#!/usr/bin/env node
'use strict';
// Get a Zoho refresh token, once, for your CRM's .env.
//
//   Self Client (simplest, for your own Zoho org):
//     node bin/zoho-auth.js self-client --code 1000.xxxx --dc us
//
//   Server-based app (a local browser round-trip, also what your CRM's "Connect Zoho" button does):
//     node bin/zoho-auth.js browser --dc us [--port 8765] [--scopes ZohoBooks.contacts.ALL,...]
//
// Prints ZOHO_* lines to paste into .env, and the organisations the login can see.
// --write <file> appends them to that file instead (created with mode 600).
const http = require('node:http');
const fs = require('node:fs');
const { authUrl, exchangeCode, DEFAULT_SCOPES, ZohoClient, Books } = require('../src');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

async function finish(tokens, a) {
  const lines = [
    `ZOHO_REFRESH_TOKEN=${tokens.refreshToken}`,
    `ZOHO_DC=${tokens.dc}`,
    `ZOHO_ACCOUNTS_SERVER=${tokens.accountsServer}`,
    ...(tokens.apiDomain ? [`ZOHO_API_DOMAIN=${tokens.apiDomain}`] : []),
  ];
  let orgs = [];
  try {
    const client = new ZohoClient({ clientId: a.clientId, clientSecret: a.clientSecret, refreshToken: tokens.refreshToken,
      dc: tokens.dc, accountsServer: tokens.accountsServer, apiDomain: tokens.apiDomain });
    orgs = await new Books(client).organizations();
  } catch (e) {
    console.error(`(Could not list organisations: ${e.message}. The token still works if you skipped ZohoBooks.settings.READ.)`);
  }
  if (orgs.length === 1) lines.push(`ZOHO_ORG_ID=${orgs[0].organization_id}`);
  let written = false;
  if (a.write) {
    try {
      fs.appendFileSync(a.write, '\n' + lines.join('\n') + '\n', { mode: 0o600 });
      try { fs.chmodSync(a.write, 0o600); } catch { /* Windows: no POSIX modes */ }   // an existing .env keeps its old mode otherwise
      console.log(`Wrote ${lines.length} lines to ${a.write} (later lines win if a key repeats).`);
      written = true;
    } catch (e) {
      console.error(`Could not write ${a.write}: ${e.message}`);
    }
  }
  // The code is single-use, so never lose the token: print it whenever it wasn't written.
  if (!written) console.log('\nAdd these to your .env (keep it out of git):\n\n' + lines.join('\n') + '\n');
  if (orgs.length > 1) {
    console.log('This login sees several organisations. Pick one for ZOHO_ORG_ID:');
    for (const o of orgs) console.log(`  ${o.organization_id}  ${o.name}${o.is_default_org ? '  (default)' : ''}`);
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  a.clientId = a['client-id'] || process.env.ZOHO_CLIENT_ID;
  a.clientSecret = a['client-secret'] || process.env.ZOHO_CLIENT_SECRET;
  const dc = a.dc || process.env.ZOHO_DC || 'us';
  const mode = a._[0];
  if (!['self-client', 'browser'].includes(mode) || !a.clientId || !a.clientSecret) {
    console.log('usage: ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node bin/zoho-auth.js self-client --code <code> [--dc us]\n' +
                '       ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node bin/zoho-auth.js browser [--dc us] [--port 8765]\n' +
                'options: --scopes a,b,c   --write .env   (see docs/SETUP.md)');
    process.exit(2);
  }
  if (a.write === true) { console.log('--write needs a file name, e.g. --write .env'); process.exit(2); }

  if (mode === 'self-client') {
    if (!a.code) throw new Error('--code is required (Zoho API Console > Self Client > Generate Code)');
    return finish(await exchangeCode({ code: a.code, clientId: a.clientId, clientSecret: a.clientSecret, dc }), a);
  }

  const port = Number(a.port || 8765);
  const redirectUri = `http://localhost:${port}/callback`;
  const scopes = a.scopes ? String(a.scopes).split(',') : DEFAULT_SCOPES;
  const { url, state } = authUrl({ clientId: a.clientId, redirectUri, scopes, dc });

  await new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const done = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }).end(msg); srv.close(); };
      if (u.searchParams.get('state') !== state) {
        // Not our request (a stale tab, or someone else's link): refuse it but keep waiting for ours.
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('This link is not from the current sign-in. Use the URL in the terminal.');
        return;
      }
      if (u.searchParams.get('error')) {
        const err = String(u.searchParams.get('error')).slice(0, 100);
        done(400, 'Zoho said: ' + err); return reject(new Error(err));
      }
      try {
        const tokens = await exchangeCode({ code: u.searchParams.get('code'), clientId: a.clientId, clientSecret: a.clientSecret,
          redirectUri, dc, accountsServer: u.searchParams.get('accounts-server') || undefined });
        done(200, 'Connected. You can close this tab and go back to the terminal.');
        await finish(tokens, a);
        resolve();
      } catch (e) { done(500, e.message); reject(e); }
    });
    srv.on('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use; try --port 8766 (and register that redirect URI)` : e.message)));
    srv.listen(port, '127.0.0.1', () => {
      console.log(`Redirect URI to register in the Zoho API Console: ${redirectUri}\n\nOpen this URL and approve:\n\n${url}\n`);
    });
  });
}

main().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
