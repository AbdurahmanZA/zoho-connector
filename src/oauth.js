'use strict';
const crypto = require('node:crypto');
const { datacenter, dcForAccountsServer, trustedAccountsServer } = require('./datacenters');

// Least privilege for a CRM <-> Books link: customers, quotes, invoices, and reading the org list.
const DEFAULT_SCOPES = [
  'ZohoBooks.contacts.ALL',
  'ZohoBooks.estimates.ALL',
  'ZohoBooks.invoices.ALL',
  'ZohoBooks.settings.READ',
];

/**
 * The URL to send a user to for consent ("Server-based Application" clients).
 * access_type=offline + prompt=consent makes Zoho return a refresh token every time,
 * not only on the very first consent. Keep `state` and check it in the callback.
 */
function authUrl({ clientId, redirectUri, scopes = DEFAULT_SCOPES, dc = 'us', state = crypto.randomBytes(16).toString('hex') }) {
  const q = new URLSearchParams({
    scope: scopes.join(','), client_id: clientId, response_type: 'code',
    redirect_uri: redirectUri, access_type: 'offline', prompt: 'consent', state,
  });
  return { url: `${datacenter(dc).accounts}/oauth/v2/auth?${q}`, state };
}

/**
 * Exchange a grant code for tokens. The code is valid for about 2 minutes (Self Client: the
 * duration you picked). Pass the `accounts-server` Zoho put on the redirect: it is the user's
 * data center, which may differ from the one you started on.
 * Returns { refreshToken, accessToken, expiresIn, apiDomain, accountsServer, dc }.
 */
async function exchangeCode({ code, clientId, clientSecret, redirectUri, dc = 'us', accountsServer, fetch = globalThis.fetch }) {
  // The accounts server arrives on the redirect URL, so it is attacker-controllable: only ever send
  // the client secret to a real Zoho accounts server.
  const server = accountsServer ? trustedAccountsServer(accountsServer) : datacenter(dc).accounts;
  const form = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' });
  if (redirectUri) form.set('redirect_uri', redirectUri);
  const r = await fetch(`${server}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(), signal: AbortSignal.timeout(30000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    throw new Error(`Zoho code exchange failed: ${data.error || 'HTTP ' + r.status}` +
      (data.error === 'invalid_code' ? ' (codes expire fast and work once; also check the data center)' : ''));
  }
  if (!data.refresh_token) {
    throw new Error('Zoho returned no refresh_token. Use access_type=offline and prompt=consent ' +
      '(authUrl does), or for a Self Client make sure you generated a new code.');
  }
  return {
    refreshToken: data.refresh_token, accessToken: data.access_token, expiresIn: data.expires_in,
    apiDomain: data.api_domain, accountsServer: server, dc: dcForAccountsServer(server) || dc,
  };
}

/** Revoke a refresh token (e.g. when a user disconnects Zoho from your CRM). */
async function revoke({ token, dc = 'us', accountsServer, fetch = globalThis.fetch }) {
  const server = accountsServer ? trustedAccountsServer(accountsServer) : datacenter(dc).accounts;
  const r = await fetch(`${server}/oauth/v2/token/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Zoho revoke failed: HTTP ${r.status}`);
  return true;
}

module.exports = { DEFAULT_SCOPES, authUrl, exchangeCode, revoke };
