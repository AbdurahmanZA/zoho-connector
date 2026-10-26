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
        return { contact: await this.updateContact(zohoId, contact), action: 'updated' };
      } catch (e) {
        if (e.status !== 404) throw e;          // deleted in Zoho since we stored the id: match by email instead
      }
    }
    const existing = await this.findContactByEmail(email || contactEmail(contact));
    if (existing) return { contact: await this.updateContact(existing.contact_id, contact), action: 'updated' };
    return { contact: await this.createContact(contact), action: 'created' };
  }

  // ── Estimates (quotes) ────────────────────────────────────────────────────
  listEstimates(query = {}) { return this.c.paginate('books', '/estimates', 'estimates', query); }
  async getEstimate(id) { return (await this._get(`/estimates/${encodeURIComponent(id)}`)).estimate; }
  async createEstimate(estimate) { return (await this._post('/estimates', estimate)).estimate; }

  /**
   * Turn an accepted quote into an invoice: same customer and line items, the quote number as
   * the invoice's reference. Uses only the documented create-invoice call, so it works on every plan.
   */
  async invoiceFromEstimate(estimateId, extra = {}) {
    const est = await this.getEstimate(estimateId);
    if (!est) throw new Error(`Estimate ${estimateId} not found`);
    const lineItems = (est.line_items || []).map(li => {
      const out = { rate: li.rate, quantity: li.quantity };
      if (li.item_id) out.item_id = li.item_id;
      for (const k of ['name', 'description', 'unit', 'tax_id', 'discount']) if (li[k] !== undefined && li[k] !== '') out[k] = li[k];
      return out;
    });
    return this.createInvoice({
      customer_id: est.customer_id,
      reference_number: est.estimate_number,
      notes: `From quote ${est.estimate_number}`,
      line_items: lineItems,
      ...extra,
    });
  }

  // ── Invoices ──────────────────────────────────────────────────────────────
  listInvoices(query = {}) { return this.c.paginate('books', '/invoices', 'invoices', query); }
  async getInvoice(id) { return (await this._get(`/invoices/${encodeURIComponent(id)}`)).invoice; }
  async createInvoice(invoice) { return (await this._post('/invoices', invoice)).invoice; }
  invoicesForCustomer(customerId, query = {}) { return this.listInvoices({ customer_id: customerId, ...query }); }

  /** What a customer owes: totals over their invoices (the CRM "account balance" card). */
  async customerBalance(customerId) {
    let billed = 0, outstanding = 0, overdue = 0, count = 0;
    for await (const inv of this.invoicesForCustomer(customerId)) {
      if (inv.status === 'void' || inv.status === 'draft') continue;
      count++;
      billed += Number(inv.total) || 0;
      outstanding += Number(inv.balance) || 0;
      if (inv.status === 'overdue') overdue += Number(inv.balance) || 0;
    }
    return { count, billed: round(billed), outstanding: round(outstanding), overdue: round(overdue) };
  }
}

function contactEmail(contact) {
  const people = contact.contact_persons || [];
  return (people.find(p => p.is_primary_contact) || people[0] || {}).email || contact.email || '';
}

const round = n => Math.round(n * 100) / 100;

module.exports = { Books, contactEmail };
