# Zoho Connector

[![tests](https://github.com/AbdurahmanZA/zoho-connector/actions/workflows/test.yml/badge.svg)](https://github.com/AbdurahmanZA/zoho-connector/actions/workflows/test.yml) [![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

**Connect your own CRM to Zoho Books, and have it still work next month.**

Getting a token out of Zoho takes an afternoon. Keeping two systems in agreement takes longer:
the "invalid_code" that is really the wrong data center, the duplicate customer on every re-sync,
the second invoice created by a retry. This is the connector we use in production, with those
lessons built in. Customers, quotes and invoices, OAuth that works in every Zoho data center,
19 tests, Node 20+ and zero dependencies.

*Built and maintained by [SANDZ](https://www.sandz.co.za) · MIT licensed.*

```js
const { ZohoClient, Books } = require('zoho-connector');
const books = new Books(ZohoClient.fromEnv());

const { contact } = await books.upsertContact(crmCustomerAsZoho, { zohoId: row.zoho_id });
const balance    = await books.customerBalance(contact.contact_id);   // { outstanding, unusedCredits, overdue, currency }
const invoice    = await books.invoiceFromEstimate(acceptedQuoteId);
```

## Why this exists

Every "connect our CRM to Zoho" project hits the same walls:

- **`invalid_code` that is really the wrong data center.** Zoho runs separate clouds (.com,
  .eu, .in, .com.au, .jp, .ca, .sa, .uk, .com.cn). Tokens only work in one of them, and the API
  domain differs too. This client follows the `accounts-server` and `api_domain` Zoho hands back.
- **No refresh token on the second connect.** You need `access_type=offline` **and**
  `prompt=consent`.
- **Token errors arrive as HTTP 200** with `{"error": …}`, and API errors as a non-zero
  `code` in the body. Both throw a `ZohoError` here.
- **429s at 100 calls a minute.** Retries honour `Retry-After` with backoff. A 401 triggers one
  silent token refresh. Writes are never retried after a server error, so a flaky network can't
  create a second invoice.
- **Duplicates on every re-sync.** Upsert by stored id, then by exact email, never blindly create
  (see [docs/SYNC.md](docs/SYNC.md)).

## Quick start

```bash
git clone <this repo> && cd zoho-connector
cp .env.example .env                       # add your Client ID + Secret (docs/SETUP.md)
node bin/zoho-auth.js self-client --code 1000.xxxx --dc us   # or: browser --dc us
#  -> paste the printed ZOHO_* lines into .env
node --env-file=.env examples/crm-sync.js examples/sample-crm.json          # dry run
node --env-file=.env examples/crm-sync.js examples/sample-crm.json --apply  # really write
npm test                                   # 19 tests, no network
```

[docs/SETUP.md](docs/SETUP.md) walks through the Zoho API Console (Self Client vs Server-based app,
scopes, data centers, limits).

## What's inside

| File | |
|---|---|
| `src/client.js` | `ZohoClient`: token refresh (cached, one refresh shared between concurrent calls), DC-aware URLs, retries, `organization_id`, `paginate()`. Also handles `crm`, `invoice`, `inventory` via `request(service, …)`. |
| `src/books.js` | `Books`: organisations, contacts (find by email, upsert), estimates, invoices, quote → invoice, customer balance. |
| `src/oauth.js` | `authUrl()` with state, `exchangeCode()`, `revoke()`, least-privilege default scopes. |
| `bin/zoho-auth.js` | One-time CLI to get a refresh token (Self Client code, or a local browser round-trip) and list your organisations. |
| `examples/crm-sync.js` | Push CRM customers into Books: dry-run first, an id map so re-runs never duplicate. |
| `examples/express-routes.js` | A "Connect Zoho" button for your CRM: admin-only connect with the state tied to the signed-in admin, status, disconnect (revoke), balance, quote → invoice that is safe to click twice. |
| `docs/SYNC.md` | The rules that keep two systems agreeing, plus the errors you'll meet and their fixes. |

## API at a glance

```js
const client = ZohoClient.fromEnv();      // or new ZohoClient({ clientId, clientSecret, refreshToken, dc, organizationId })
const books = new Books(client);

await books.organizations();
for await (const c of books.listContacts()) { /* every customer, 200 per page */ }
await books.findContactByEmail('alex@acme.example.com');
await books.upsertContact(contact, { zohoId, email });   // -> { contact, action: 'created' | 'updated' }
await books.createEstimate({ customer_id, line_items: [{ name: 'Install', rate: 1500, quantity: 1 }] });
await books.invoiceFromEstimate(estimateId);              // returns the existing invoice if already done
await books.customerBalance(customerId);                  // Zoho's own outstanding, net of credits

// Anything else in Zoho's APIs:
await client.request('books', 'GET', '/customerpayments', { query: { customer_id } });
await client.request('crm', 'GET', '/Leads', { query: { per_page: 50 } });
```

## Security

- The refresh token is a long-lived credential. Keep it server-side and out of git
  (`.gitignore` covers `.env`), and encrypt it at rest if you store one per customer.
- The library never logs tokens or token responses. Keep your own logging that way too.
- The browser flow checks `state` on the callback, and only a real Zoho accounts server ever receives
  your client secret (the `accounts-server` on the redirect is checked against Zoho's list).
- Tokens and secrets travel in request bodies, never in URLs, so they stay out of proxy logs.
- Ask for the smallest scopes you need. The defaults are contacts, estimates, invoices and settings.READ.

## About

Zoho Connector is built and maintained by **[SANDZ](https://www.sandz.co.za)**, a software studio
that builds CRMs, dashboards and integrations for small businesses. It started as the Zoho Books
link inside our own CRM.

Issues and pull requests are welcome. MIT licence, see [LICENSE](LICENSE).
Visit **[www.sandz.co.za](https://www.sandz.co.za)**.
