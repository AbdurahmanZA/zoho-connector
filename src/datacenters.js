'use strict';
// Zoho runs separate data centers. A user's account (and their tokens) live in exactly one of
// them, and every call must go to that DC's accounts server and API domain.
// Source: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
// Live list: https://accounts.zoho.com/oauth/serverinfo

const DATACENTERS = {
  us: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  au: { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  uk: { accounts: 'https://accounts.zoho.uk', api: 'https://www.zohoapis.uk' },
  cn: { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn' },
};

function datacenter(dc = 'us') {
  const d = DATACENTERS[String(dc).toLowerCase()];
  if (!d) throw new Error(`Unknown Zoho data center "${dc}". Use one of: ${Object.keys(DATACENTERS).join(', ')}`);
  return d;
}

/** The DC code for an accounts-server URL (Zoho sends it back on the OAuth redirect). */
function dcForAccountsServer(url) {
  const u = String(url || '').replace(/\/+$/, '');
  return Object.keys(DATACENTERS).find(k => DATACENTERS[k].accounts === u) || null;
}

/** The accounts-server URL if it is one of Zoho's, else throw (never send a client secret elsewhere). */
function trustedAccountsServer(url) {
  const dc = dcForAccountsServer(url);
  if (!dc) throw new Error(`"${String(url).slice(0, 80)}" is not a Zoho accounts server`);
  return DATACENTERS[dc].accounts;
}

module.exports = { DATACENTERS, datacenter, dcForAccountsServer, trustedAccountsServer };
