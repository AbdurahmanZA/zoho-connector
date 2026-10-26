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

test('a 401 refreshes the token once and retries; a 401 right after a refresh is reported', async () => {
  let tokens = 0, api = 0;
  const f = fakeFetch(u => {
    if (u.pathname === '/oauth/v2/token') { tokens++; return tokenOk; }
    api++;
    return api === 1 ? { status: 401, body: { code: 57, message: 'Invalid token' } } : { body: { code: 0 } };
  });
  const c = new ZohoClient({ ...base, fetch: f });
  c._token = 'OLD'; c._expires = Date.now() + 3600e3; c._lastRefresh = 0;   // a cached token Zoho has since revoked
  await c.request('books', 'GET', '/contacts');
  assert.equal(tokens, 1);
  assert.equal(api, 2);
  const always = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk : { status: 401, body: { code: 57, message: 'not authorized' } });
  const c2 = new ZohoClient({ ...base, fetch: always });
  await assert.rejects(c2.request('books', 'GET', '/contacts'), e => e.status === 401);
  assert.equal(always.calls.filter(x => x.url.includes('/oauth/v2/token')).length, 1);   // no refresh storm
});

test('writes are never retried on a server error; reads are, and also on a dropped connection', async () => {
  const f = fakeFetch(u => u.pathname === '/oauth/v2/token' ? tokenOk : { status: 502, body: { message: 'bad gateway' } });
  const c = new ZohoClient({ ...base, fetch: f });
  await assert.rejects(c.request('books', 'POST', '/invoices', { body: { x: 1 } }), e => e.status === 502);
  assert.equal(f.calls.filter(x => x.init.method === 'POST' && x.url.includes('/invoices')).length, 1);
  let n = 0;
  const flaky = async (url, init) => {
    if (String(url).includes('/oauth/v2/token')) return fakeFetch(() => tokenOk)(url, init);
    if (++n === 1) throw new Error('ECONNRESET');
    return fakeFetch(() => ({ body: { code: 0, ok: 1 } }))(url, init);
  };
  const orig = global.setTimeout;
  global.setTimeout = (fn) => orig(fn, 0);                     // skip the 1 s backoff in the test
  try { assert.equal((await new ZohoClient({ ...base, fetch: flaky }).request('books', 'GET', '/x')).ok, 1); }
  finally { global.setTimeout = orig; }
});

test('the client secret only ever goes to a real Zoho accounts server, in the body', async () => {
  const f = fakeFetch(() => ({ body: { access_token: 'AT', refresh_token: 'RT' } }));
  await assert.rejects(exchangeCode({ code: 'c', clientId: 'id', clientSecret: 'SECRET', accountsServer: 'https://evil.example', fetch: f }),
    /not a Zoho accounts server/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => new ZohoClient({ ...base, accountsServer: 'https://evil.example' }), /not a Zoho accounts server/);
  await exchangeCode({ code: 'c', clientId: 'id', clientSecret: 'SECRET', accountsServer: 'https://accounts.zoho.eu', fetch: f });
  assert.ok(!f.calls[0].url.includes('SECRET'));
  assert.match(f.calls[0].init.body, /client_secret=SECRET/);
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
  assert.deepEqual(f.calls.slice(1).map(c => c.init.method), ['GET', 'PUT', 'GET', 'POST']);
});

test('upsert: "does not exist" as HTTP 400 + code 1002 also falls back to email', async () => {
  const { books } = booksWith((u, init) => {
    if (init.method === 'PUT') return { status: 400, body: { code: 1002, message: 'Contact does not exist.' } };
    if (init.method === 'GET') return { body: { code: 0, contacts: [] } };
    return { body: { code: 0, contact: { contact_id: 'new' } } };
  });
  assert.equal((await books.upsertContact({ contact_name: 'A', contact_persons: [{ email: 'a@example.com' }] }, { zohoId: 'gone' })).action, 'created');
});

test('upsert: existing contact persons keep their ids (no duplicate people)', async () => {
  let put;
  const { books } = booksWith((u, init, body) => {
    if (init.method === 'GET') return { body: { code: 0, contact: { contact_id: '7', contact_persons: [{ contact_person_id: 'P1', email: 'Alex@Example.com' }] } } };
    put = body;
    return { body: { code: 0, contact: { contact_id: '7' } } };
  });
  await books.upsertContact({ contact_name: 'A', contact_persons: [{ email: 'alex@example.com' }, { email: 'new@example.com' }] }, { zohoId: '7' });
  assert.deepEqual(put.contact_persons, [{ email: 'alex@example.com', contact_person_id: 'P1' }, { email: 'new@example.com' }]);
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

test('customerBalance uses Zoho own outstanding figures plus overdue invoices', async () => {
  const { books } = booksWith((u) => u.pathname.endsWith('/contacts/C1')
    ? { body: { code: 0, contact: { currency_code: 'ZAR', outstanding_receivable_amount: 70.5, unused_credits_receivable_amount: 10 } } }
    : { body: { code: 0, invoices: [{ status: 'overdue', balance: 50.5 }, { status: 'overdue', balance: 20 }] } });
  assert.deepEqual(await books.customerBalance('C1'), { currency: 'ZAR', outstanding: 70.5, unusedCredits: 10, overdue: 70.5, overdueCount: 2 });
});

test('invoiceFromEstimate is safe to call twice and keeps tax, discount and currency', async () => {
  let posts = 0, posted;
  const est = { customer_id: 'C1', estimate_number: 'QT-9', is_inclusive_tax: true, discount: '10%', currency_id: 'USD1',
    line_items: [{ item_id: 'I1', rate: 5, quantity: 1, hsn_or_sac: '' }] };
  const existing = [];
  const { books } = booksWith((u, init, body) => {
    if (u.pathname.includes('/estimates/')) return { body: { code: 0, estimate: est } };
    if (init.method === 'GET') return { body: { code: 0, invoices: existing } };
    posts++; posted = body; existing.push({ invoice_id: 'INV1', reference_number: 'QT-9', status: 'draft' });
    return { body: { code: 0, invoice: { invoice_id: 'INV1' } } };
  });
  assert.equal((await books.invoiceFromEstimate('E1')).invoice_id, 'INV1');
  assert.equal(posted.is_inclusive_tax, true); assert.equal(posted.discount, '10%'); assert.equal(posted.currency_id, 'USD1');
  assert.ok(!('hsn_or_sac' in posted.line_items[0]));
  const again = await books.invoiceFromEstimate('E1');
  assert.equal(again.existing, true); assert.equal(posts, 1);
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
  assert.equal(f.calls[0].url, 'https://accounts.zoho.in/oauth/v2/token');
  const noRt = fakeFetch(() => ({ body: { access_token: 'AT' } }));
  await assert.rejects(exchangeCode({ code: 'c', clientId: 'x', clientSecret: 'y', fetch: noRt }), /no refresh_token/);
});
