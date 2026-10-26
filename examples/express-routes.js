'use strict';
// "Connect Zoho" inside your own CRM (Express). Not run by the tests; copy what you need.
//
//   const express = require('express');
//   const app = express(); app.use(express.json());
//   require('./examples/express-routes')(app, {
//     store: myTokenStore,          // get()/set(obj): the connection, in your DB, encrypted at rest
//     requireUser: mySignedIn,      // any signed-in CRM user (reads)
//     requireAdmin: myAdminOnly,    // only admins may connect or disconnect the company's Zoho
//     userId: (req) => req.user.id, // who is signed in
//   });
//
// State-changing routes are POST and expect your CRM's usual CSRF protection (same-site cookies
// plus a CSRF token or a custom header). Never put the refresh token in the browser.
const { authUrl, exchangeCode, revoke, ZohoClient, Books } = require('../src');

module.exports = function mountZoho(app, { store, requireUser, requireAdmin, userId, baseUrl = process.env.PUBLIC_URL }) {
  if (!requireAdmin || !userId) throw new Error('mountZoho needs requireAdmin and userId');
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri = `${baseUrl}/integrations/zoho/callback`;
  // state -> { user, expires }. Tied to the admin who started the flow, so a callback link someone
  // else started (e.g. for THEIR Zoho account) can't connect your CRM to it. In production keep this
  // in your session store.
  const pending = new Map();
  let books = null;                          // cached client, rebuilt when the connection changes

  const plain = (res, status, text) => res.status(status).type('text/plain').send(text);   // no HTML: no XSS

  async function getBooks() {
    if (books) return books;
    const t = await store.get();
    if (!t?.refreshToken) return null;
    books = new Books(new ZohoClient({ clientId, clientSecret, refreshToken: t.refreshToken, dc: t.dc,
      accountsServer: t.accountsServer, apiDomain: t.apiDomain, organizationId: t.orgId }));
    return books;
  }

  // 1. The "Connect Zoho" button POSTs here (POST, so a stray link or image can't start it).
  app.post('/integrations/zoho/connect', requireAdmin, (req, res) => {
    const { url, state } = authUrl({ clientId, redirectUri, dc: req.body?.dc || 'us' });
    pending.set(state, { user: userId(req), expires: Date.now() + 10 * 60 * 1000 });
    res.json({ url });                       // the page then sends the browser to it
  });

  // 2. Zoho sends the user back here. Register this exact URL in the Zoho API Console.
  app.get('/integrations/zoho/callback', requireAdmin, async (req, res) => {
    const p = pending.get(req.query.state);
    pending.delete(req.query.state);
    if (!p || p.expires < Date.now() || p.user !== userId(req)) return plain(res, 400, 'This link expired or was not started by you. Start again from Settings.');
    if (req.query.error) return plain(res, 400, 'Zoho said: ' + String(req.query.error).slice(0, 100));
    try {
      // exchangeCode only accepts a real Zoho accounts server, so the secret can't be sent elsewhere.
      const t = await exchangeCode({ code: req.query.code, clientId, clientSecret, redirectUri,
        accountsServer: req.query['accounts-server'] });
      const tmp = new Books(new ZohoClient({ clientId, clientSecret, refreshToken: t.refreshToken, dc: t.dc,
        accountsServer: t.accountsServer, apiDomain: t.apiDomain }));
      const orgs = await tmp.organizations();
      const org = orgs.find((o) => o.is_default_org) || orgs[0];
      await store.set({ ...t, accessToken: undefined, orgId: org?.organization_id, orgName: org?.name });
      books = null;
      res.redirect('/settings?zoho=connected');
    } catch (e) {
      console.error('[zoho] connect failed:', e.message);       // never log the token response
      plain(res, 500, 'Could not connect Zoho. Check the server log, then try again from Settings.');
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
  app.post('/api/zoho/disconnect', requireAdmin, async (req, res) => {
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

  // Safe to click twice: invoiceFromEstimate returns the existing invoice instead of billing again.
  app.post('/api/quotes/:estimateId/invoice', requireUser, async (req, res) => {
    const b = await getBooks();
    if (!b) return res.status(409).json({ error: 'Zoho not connected' });
    try { res.json(await b.invoiceFromEstimate(req.params.estimateId)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // Housekeeping for the in-memory state map.
  setInterval(() => { for (const [s, p] of pending) if (p.expires < Date.now()) pending.delete(s); }, 60000).unref();
  return { getBooks };
};
