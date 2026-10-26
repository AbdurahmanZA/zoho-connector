'use strict';
// Zoho Books helpers for the jobs a CRM usually needs: customers, quotes (estimates), invoices.
// API reference: https://www.zoho.com/books/api/v3/

const norm = s => String(s || '').trim().toLowerCase();

class Books {
  /** @param {import('./client').ZohoClient} client */
  constructor(client) {
    this.c = client;
  }

  _get(path, query) { return this.c.request('books', 'GET', path, { query }); }
  _post(path, body, query) { return this.c.request('books', 'POST', path, { body, query }); }
  _put(path, body) { return this.c.request('books', 'PUT', path, { body }); }

  /** Organisations this login can see; use one's organization_id as ZOHO_ORG_ID. */
  async organizations() {
    return (await this.c.request('books', 'GET', '/organizations', { orgId: false })).organizations || [];
  }

  // ── Contacts (customers) ───────────────────────────────────────────────────
  listContacts(query = {}) { return this.c.paginate('books', '/contacts', 'contacts', { contact_type: 'customer', ...query }); }
  async getContact(id) { return (await this._get(`/contacts/${encodeURIComponent(id)}`)).contact; }
  async createContact(contact) { return (await this._post('/contacts', contact)).contact; }
  async updateContact(id, changes) { return (await this._put(`/contacts/${encodeURIComponent(id)}`, changes)).contact; }

  /** The customer whose primary contact person has this email (exact, case-insensitive), or null. */
  async findContactByEmail(email) {
    if (!email) return null;
    for await (const c of this.listContacts({ email })) {
      if (norm(c.email) === norm(email)) return c;
    }
    return null;
  }

  /**
   * Create or update a customer, matched by a Zoho contact id you stored earlier, else by email.
   * Returns { contact, action: 'created' | 'updated' }.
   */
  async upsertContact(contact, { zohoId, email } = {}) {
    if (zohoId) {
      try {
        return { contact: await this._updateKeepingPeople(zohoId, contact), action: 'updated' };
      } catch (e) {
        // Deleted in Zoho since we stored the id ("does not exist" = code 1002): match by email instead.
        if (e.status !== 404 && e.code !== 1002) throw e;
      }
    }
    const existing = await this.findContactByEmail(email || contactEmail(contact));
    if (existing) return { contact: await this._updateKeepingPeople(existing.contact_id, contact), action: 'updated' };
    return { contact: await this.createContact(contact), action: 'created' };
  }

  /**
   * Update a contact without duplicating its contact persons: a person sent without a
   * contact_person_id is added as new, so match the ones Zoho already has by email first.
   */
  async _updateKeepingPeople(id, contact) {
    if (!contact.contact_persons?.length) return this.updateContact(id, contact);
    const current = await this.getContact(id);
    const byEmail = new Map((current?.contact_persons || []).filter((p) => p.email).map((p) => [norm(p.email), p.contact_person_id]));
    const people = contact.contact_persons.map((p) => {
      const known = p.contact_person_id || byEmail.get(norm(p.email));
      return known ? { ...p, contact_person_id: known } : p;
    });
    return this.updateContact(id, { ...contact, contact_persons: people });
  }

  // ── Estimates (quotes) ────────────────────────────────────────────────────
  listEstimates(query = {}) { return this.c.paginate('books', '/estimates', 'estimates', query); }
  async getEstimate(id) { return (await this._get(`/estimates/${encodeURIComponent(id)}`)).estimate; }
  async createEstimate(estimate) { return (await this._post('/estimates', estimate)).estimate; }

  /**
   * Turn an accepted quote into an invoice: same customer, lines, tax treatment, discounts and
   * currency, with the quote number as the invoice's reference. Uses only the documented
   * create-invoice call, so it works on every plan.
   *
   * Safe to call twice (a double-click, a retried request): if an invoice for this customer already
   * carries the quote number as its reference, that invoice is returned with `existing: true`
   * instead of billing the customer again.
   */
  async invoiceFromEstimate(estimateId, extra = {}) {
    const est = await this.getEstimate(estimateId);
    if (!est) throw new Error(`Estimate ${estimateId} not found`);
    for await (const inv of this.listInvoices({ customer_id: est.customer_id, reference_number: est.estimate_number })) {
      if (inv.reference_number === est.estimate_number && inv.status !== 'void') return { ...inv, existing: true };
    }
    const lineItems = (est.line_items || []).map((li) => {
      const out = { rate: li.rate, quantity: li.quantity };
      for (const k of LINE_FIELDS) if (li[k] !== undefined && li[k] !== '' && li[k] !== null) out[k] = li[k];
      return out;
    });
    const header = {};
    for (const k of HEADER_FIELDS) if (est[k] !== undefined && est[k] !== '' && est[k] !== null) header[k] = est[k];
    return this.createInvoice({
      customer_id: est.customer_id,
      reference_number: est.estimate_number,
      notes: `From quote ${est.estimate_number}`,
      ...header,
      line_items: lineItems,
      ...extra,
    });
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  listInvoices(query = {}) { return this.c.paginate('books', '/invoices', 'invoices', query); }
  async getInvoice(id) { return (await this._get(`/invoices/${encodeURIComponent(id)}`)).invoice; }
  async createInvoice(invoice) { return (await this._post('/invoices', invoice)).invoice; }
  invoicesForCustomer(customerId, query = {}) { return this.listInvoices({ customer_id: customerId, ...query }); }

  /**
   * What a customer owes (the CRM "account balance" card). Outstanding and unused credits come
   * from Zoho's own figures on the contact, which already net off credit notes and payments and
   * are in the customer's currency. Overdue is summed from that customer's overdue invoices.
   */
  async customerBalance(customerId) {
    const c = await this.getContact(customerId);
    let overdue = 0, overdueCount = 0;
    for await (const inv of this.invoicesForCustomer(customerId, { filter_by: 'Status.Overdue' })) {
      if (inv.status !== 'overdue') continue;
      overdueCount++;
      overdue += Number(inv.balance) || 0;
    }
    return {
      currency: c?.currency_code || null,
      outstanding: round(Number(c?.outstanding_receivable_amount) || 0),
      unusedCredits: round(Number(c?.unused_credits_receivable_amount) || 0),
      overdue: round(overdue),
      overdueCount,
    };
  }
}

// Copied from a quote to its invoice. Line: item, text, tax and discount (incl. India GST's HSN/SAC).
const LINE_FIELDS = ['item_id', 'name', 'description', 'unit', 'tax_id', 'discount', 'hsn_or_sac', 'product_type'];
// Header: tax treatment, document discount, currency and charges that change the total.
const HEADER_FIELDS = ['is_inclusive_tax', 'discount', 'discount_type', 'is_discount_before_tax', 'currency_id',
  'exchange_rate', 'adjustment', 'adjustment_description', 'shipping_charge', 'place_of_supply', 'gst_treatment', 'gst_no',
  'tax_treatment', 'salesperson_name'];

function contactEmail(contact) {
  const people = contact.contact_persons || [];
  return (people.find(p => p.is_primary_contact) || people[0] || {}).email || contact.email || '';
}

const round = n => Math.round(n * 100) / 100;

module.exports = { Books, contactEmail };
