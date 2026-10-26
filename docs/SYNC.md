# Keeping a CRM and Zoho Books in sync

Connecting is the easy part. Most integrations break later, when the two systems disagree. These
rules keep them agreeing.

## 1. One owner per field

Decide which system is the truth for each field, and only ever copy that way.

| Field | Owner | Why |
|---|---|---|
| Company name, address, contact person, site notes | **CRM** | Sales and support edit these every day |
| Invoices, payments, balance, credit | **Zoho Books** | Accounting is the legal record |
| Quotes (estimates) | **Zoho Books** (created from the CRM) | Numbering, tax and PDFs come from Books |
| VAT number, payment terms | CRM → Books | Captured at onboarding |

If both sides can edit a field, you will eventually overwrite someone's work.

## 2. Store Zoho's id the first time, then match on it

The first time a customer is pushed, save `contact_id` on the CRM record (a `zoho_id` column).
Every later sync matches on that id. Match on email **only** on the very first push. Emails change
and people share them, but an id never changes.

`Books.upsertContact(contact, { zohoId, email })` does this: it uses the id if you have one, and
falls back to an exact, case-insensitive email match on the primary contact person if the stored id
was deleted in Zoho. Only after both fail does it create a new contact.

## 3. Make every sync safe to re-run

- **Dry-run by default.** `examples/crm-sync.js` prints `create` / `update` lines and writes
  nothing until you add `--apply`.
- **Idempotent writes.** Upserts, not inserts. Running the sync twice must give the same result as
  running it once.
- **Write the id map after each success**, so a failed run halfway through resumes cleanly.

## 4. Show money live, cache it briefly

Screens in the CRM (a customer's balance, overdue invoices) should read from Books, not from a copy
that drifts. Use `Books.customerBalance(customerId)`. With 100 calls a minute, cache each customer's
balance for a few minutes, and refresh it when someone opens the customer.

## 5. Quotes become invoices in Books

Create the quote in Books from the CRM (`createEstimate`). When the customer accepts, call
`invoiceFromEstimate(estimateId)`. It copies the customer, the line items, and the quote number into
the invoice's reference, so accounting can trace every invoice back to its quote.

## 6. Errors you will meet

| Error | Meaning | Fix |
|---|---|---|
| `invalid_code` on connect | Code expired or already used, **or wrong data center** | Generate a new code, check `ZOHO_DC` |
| `invalid_client` | Client ID/secret wrong, or the user is in another DC and Multi-DC is off | Check the console; enable Multi-DC |
| HTTP 401 / code 57 | Access token expired or revoked | The client refreshes and retries once on its own |
| HTTP 429 / code 44 | Over 100 calls a minute | The client backs off and retries. Batch your syncs |
| code 1002 "does not exist" | Deleted in Books | `upsertContact` falls back to email |
| `organizationId is required` | `ZOHO_ORG_ID` not set | Run `bin/zoho-auth.js`. It lists your organisations |

## 7. Privacy

Customer records are personal information under POPIA/GDPR. Send Zoho only what invoicing needs.
Site notes, alarm codes and camera passwords stay in your CRM.
