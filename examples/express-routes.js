'use strict';
// "Connect Zoho" inside your own CRM (Express). Not run by the tests; copy what you need.
//
//   const express = require('express');
//   const app = express(); app.use(express.json());
//   require('./examples/express-routes')(app, { store: myTokenStore, requireUser: myAuthMiddleware });
//
// `store` is yours: get()/set(obj) for { refreshToken, dc, accountsServer, apiDomain, orgId },
// kept in your database and encrypted at rest. Never put the refresh token in the browser.
const { authUrl, exchangeCode, revoke, ZohoClient, Books } = require('../src');

module.exports = function mountZoho(app, { store, requireUser, baseUrl = process.env.PUBLIC_URL }) {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = `${baseUrl}/integrations/zoho/callback`;
  const pending = new Map();                 // state -> expiry (use your session store in production)
  let books = null;                          // cached client, rebuilt when the connection changes

  async function getBooks() {
    if (books) return books;
    const t = await store.get();
    if (!t?.refreshToken) return null;
    books = new Books(new ZohoClient({ clientId, clientSecret, refreshToken: t.refreshToken, dc: t.dc,
      accountsServer: t.accountsServer, apiDomain: t.apiDomain, organizationId: t.orgId }));
    return books;
  }

  // 1. The "Connect Zoho" button links here.
  app.get('/integrations/zoho/connect', requireUser, (req, res) => {
    const { url, state } = authUrl({ clientId, redirectUri, dc: req.query.dc || 'us' });
    pending.set(state, Date.now() + 10 * 60 * 1000);
    res.redirect(url);
  });

  // 2. Zoho sends the user back here. Register this exact URL in the Zoho API Console.
  app.get('/integrations/zoho/callback', requireUser, async (req, res) => {
    const exp = pending.get(req.query.state);
    pending.delete(req.query.state);
    if (!exp || exp < Date.now()) return res.status(400).send('This link expired. Start again from Settings.');
    if (req.query.error) return res.status(400).send('Zoho said: ' + req.query.error);
    try {
      const t = await exchangeCode({ code: req.query.code, clientId, clientSecret, redirectUri,
        accountsServer: req.query['accounts-server'] });           // the user's real data center
      const tmp = new Books(new ZohoClient({ clientId, clientSecret, refreshToken: t.refreshToken, dc: t.dc,
        accountsServer: t.accountsServer, apiDomain: t.apiDomain }));
      const orgs = await tmp.organizations();
      const org = orgs.find(o => o.is_default_org) || orgs[0];
      await store.set({ ...t, accessToken: undefined, orgId: org?.organization_id, orgName: org?.name });
      books = null;
      res.redirect('/settings?zoho=connected');
    } catch (e) {
      console.error('[zoho] connect failed:', e.message);       // never log the token response
      res.status(500).send('Could not connect Zoho: ' + e.message);
    }
  });

  // 3. Status for the Settings page.
  app.get('/api/zoho/status', requireUser, async (req, res) => {
    const t = await store.get();
    if (!t?.refreshToken) return res.json({ connected: false });
    try {
      await (await getBooks()).organizations();
      res.json({ connected: true, org: t.orgName, dc: t.dc });
    } catch (e) { res.json({ connected: false, error: e.message }); }
  });

  // 4. Disconnect: revoke at Zoho, then forget it here.
  app.post('/api/zoho/disconnect', requireUser, async (req, res) => {
    const t = await store.get();
    if (t?.refreshToken) await revoke({ token: t.refreshToken, accountsServer: t.accountsServer }).catch(() => {});
    await store.set(null); books = null;
    res.json({ connected: false });
  });

  // 5. What the CRM screens use. Keep these server-side; the browser never talks to Zoho.
  app.get('/api/customers/:zohoId/balance', requireUser, async (req, res) => {
    const b = await getBooks();
    if (!b) return res.status(409).json({ error: 'Zoho not connected' });
    try { res.json(await b.customerBalance(req.params.zohoId)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/quotes/:estimateId/invoice', requireUser, async (req, res) => {
    const b = await getBooks();
    if (!b) return res.status(409).json({ error: 'Zoho not connected' });
    try { res.json(await b.invoiceFromEstimate(req.params.estimateId)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Housekeeping for the in-memory state map.
  setInterval(() => { for (const [s, exp] of pending) if (exp < Date.now()) pending.delete(s); }, 60000).unref();
  return { getBooks };
};
