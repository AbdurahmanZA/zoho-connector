'use strict';
// node --test   (no network: fetch is faked)
const test = require('node:test');
const assert = require('node:assert/strict');
const { ZohoClient, ZohoError, Books, authUrl, exchangeCode, datacenter, dcForAccountsServer } = require('../src');

/** A fake fetch: routes(url, init) returns {status, body, headers}; records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = await routes(new URL(url), init, calls.length);
    const headers = new Map(Object.entries(r.headers || {}));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return { ok: (r.status || 200) < 400, status: r.status || 200, headers: { get: k => headers.get(k.toLowerCase()) ?? null },
             text: async () => text, json: async () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}

const tokenOk = { status: 200, body: { access_token: 'AT', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' } };
const base = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'RT', organizationId: '42', maxRetries: 2 };

test('data centers map both ways', () => {
  assert.equal(datacenter('EU').accounts, 'https://accounts.zoho.eu');
  assert.equal(dcForAccountsServer('https://accounts.zohocloud.ca/'), 'ca');
  assert.throws(() => datacenter('xx'), /Unknown Zoho data center/);
});

test('refreshes once, shares the token, and uses the api_domain Zoho returns', async () => {
  const f = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk : { body: { code: 0, contacts: [] } });
  const c = new ZohoClient({ ...base, dc: 'eu', fetch: f });
  await Promise.all([c.request('books', 'GET', '/contacts'), c.request('books', 'GET', '/contacts')]);
  assert.equal(f.calls.filter(x => x.url.includes('/oauth/v2/token')).length, 1);
  const api = f.calls.find(x => x.url.includes('/books/v3/contacts'));
  assert.match(api.url, /^https:\/\/www\.zohoapis\.eu\/books\/v3\/contacts\?organization_id=42$/);
  assert.equal(api.init.headers.Authorization, 'Zoho-oauthtoken AT');
});

test('token errors come back as HTTP 200 with an error field', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { error: 'invalid_code' } }));
  const c = new ZohoClient({ ...base, fetch: f });
  await assert.rejects(c.accessToken(), /invalid_code.*ZOHO_DC/s);
});

test('retries 429 then succeeds; gives up after maxRetries', async () => {
  let n = 0;
  const f = fakeFetch(u => {
    if (u.pathname === '/oauth/v2/token') return tokenOk;
    n++;
    return n < 3 ? { status: 429, headers: { 'retry-after': '0' }, body: { code: 44, message: 'Too many' } } : { body: { code: 0, ok: 1 } };
  });
  const c = new ZohoClient({ ...base, fetch: f });
  assert.equal((await c.request('books', 'GET', '/invoices')).ok, 1);

  const always = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk
    : { status: 503, headers: { 'retry-after': '0' }, body: { message: 'down' } });
  await assert.rejects(new ZohoClient({ ...base, fetch: always }).request('books', 'GET', '/x'),
    e => e instanceof ZohoError && e.status === 503);
});

test('a 401 forces one token refresh and a retry', async () => {
  let tokens = 0, api = 0;
  const f = fakeFetch(u => {
    if (u.pathname === '/oauth/v2/token') { tokens++; return tokenOk; }
    api++;
    return api === 1 ? { status: 401, body: { code: 57, message: 'Invalid token' } } : { body: { code: 0 } };
  });
  await new ZohoClient({ ...base, fetch: f }).request('books', 'GET', '/contacts');
  assert.equal(tokens, 2);
  assert.equal(api, 2);
});

test('a non-zero Zoho code is an error even with HTTP 200', async () => {
  const f = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk : { body: { code: 1002, message: 'Contact does not exist.' } });
  await assert.rejects(new ZohoClient({ ...base, fetch: f }).request('books', 'GET', '/contacts/1'),
    e => e.code === 1002 && /does not exist/.test(e.message));
});

test('organization_id is required for Books but not for CRM or /organizations', async () => {
  const f = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk : { body: { code: 0, organizations: [{ organization_id: '1' }] } });
  const c = new ZohoClient({ ...base, organizationId: undefined, fetch: f });
  await assert.rejects(c.request('books', 'GET', '/contacts'), /organizationId is required/);
  await c.request('crm', 'GET', '/Leads');
  assert.equal((await new Books(c).organizations())[0].organization_id, '1');
  assert.ok(!f.calls.at(-1).url.includes('organization_id'));
});

test('paginate follows has_more_page', async () => {
  const f = fakeFetch(u => {
    if (u.pathname === '/oauth/v2/token') return tokenOk;
    const page = Number(u.searchParams.get('page'));
    return { body: { code: 0, invoices: [{ id: page }], page_context: { has_more_page: page < 3 } } };
  });
  const got = [];
  for await (const i of new ZohoClient({ ...base, fetch: f }).paginate('books', '/invoices', 'invoices')) got.push(i.id);
  assert.deepEqual(got, [1, 2, 3]);
});

function booksWith(handler) {
  const f = fakeFetch((u, init) => u.pathname === '/oauth/v2/token' ? tokenOk
    : handler(u, init, init.body ? JSON.parse(init.body) : null));
  return { books: new Books(new ZohoClient({ ...base, fetch: f })), f };
}

test('upsert: matches by email (exact, case-insensitive) and updates', async () => {
  const { books, f } = booksWith((u, init) => {
    if (init.method === 'GET') return { body: { code: 0, contacts: [
      { contact_id: '9', email: 'other-alex@acme.example.com' }, { contact_id: '7', email: 'Alex@Acme.example.com' }] } };
    return { body: { code: 0, contact: { contact_id: u.pathname.split('/').pop() } } };
  });
  const r = await books.upsertContact({ contact_name: 'Acme', contact_persons: [{ email: 'alex@acme.example.com', is_primary_contact: true }] });
  assert.deepEqual(r, { contact: { contact_id: '7' }, action: 'updated' });
  assert.equal(f.calls.at(-1).init.method, 'PUT');
});

test('upsert: creates when nobody matches; falls back to email when a stored id was deleted', async () => {
  const { books, f } = booksWith((u, init) => {
    if (init.method === 'PUT') return { status: 404, body: { code: 1002, message: 'Contact does not exist.' } };
    if (init.method === 'GET') return { body: { code: 0, contacts: [] } };
    return { body: { code: 0, contact: { contact_id: 'new' } } };
  });
  const r = await books.upsertContact({ contact_name: 'Acme', contact_persons: [{ email: 'a@example.com' }] }, { zohoId: 'gone' });
  assert.deepEqual(r, { contact: { contact_id: 'new' }, action: 'created' });
  assert.deepEqual(f.calls.slice(1).map(c => c.init.method), ['PUT', 'GET', 'POST']);
});

test('invoiceFromEstimate copies customer, lines and the quote number', async () => {
  let posted;
  const { books } = booksWith((u, init, body) => {
    if (init.method === 'GET') return { body: { code: 0, estimate: { customer_id: 'C1', estimate_number: 'QT-0001',
      line_items: [{ item_id: 'I1', name: 'Camera', rate: 100, quantity: 2, description: '', unit: 'pcs' }] } } };
    posted = body;
    return { body: { code: 0, invoice: { invoice_id: 'INV1' } } };
  });
  assert.equal((await books.invoiceFromEstimate('E1')).invoice_id, 'INV1');
  assert.deepEqual(posted, { customer_id: 'C1', reference_number: 'QT-0001', notes: 'From quote QT-0001',
    line_items: [{ rate: 100, quantity: 2, item_id: 'I1', name: 'Camera', unit: 'pcs' }] });
});

test('customerBalance skips drafts and voids', async () => {
  const { books } = booksWith(() => ({ body: { code: 0, invoices: [
    { status: 'paid', total: 100, balance: 0 }, { status: 'overdue', total: 50.5, balance: 50.5 },
    { status: 'sent', total: 20, balance: 20 }, { status: 'draft', total: 999, balance: 999 }, { status: 'void', total: 5, balance: 5 }] } }));
  assert.deepEqual(await books.customerBalance('C1'), { count: 3, billed: 170.5, outstanding: 70.5, overdue: 50.5 });
});

test('authUrl asks for offline access with consent and carries state', () => {
  const { url, state } = authUrl({ clientId: 'cid', redirectUri: 'http://localhost:8765/callback', dc: 'au' });
  const u = new URL(url);
  assert.equal(u.origin, 'https://accounts.zoho.com.au');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('state'), state);
  assert.match(u.searchParams.get('scope'), /ZohoBooks\.contacts\.ALL/);
});

test('exchangeCode uses the accounts-server from the redirect and needs a refresh token', async () => {
  const f = fakeFetch(() => ({ body: { access_token: 'AT', refresh_token: 'RT2', api_domain: 'https://www.zohoapis.in' } }));
  const t = await exchangeCode({ code: 'c', clientId: 'cid', clientSecret: 's', dc: 'us', accountsServer: 'https://accounts.zoho.in', fetch: f });
  assert.equal(t.dc, 'in');
  assert.equal(t.refreshToken, 'RT2');
  assert.match(f.calls[0].url, /^https:\/\/accounts\.zoho\.in\/oauth\/v2\/token\?/);
  const noRt = fakeFetch(() => ({ body: { access_token: 'AT' } }));
  await assert.rejects(exchangeCode({ code: 'c', clientId: 'x', clientSecret: 'y', fetch: noRt }), /no refresh_token/);
});
