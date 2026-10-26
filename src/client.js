'use strict';
const { datacenter, trustedAccountsServer } = require('./datacenters');

// Base path and organisation parameter per Zoho product. Books, Invoice and Inventory scope
// every call to an organization_id; CRM does not.
const SERVICES = {
  books: { base: '/books/v3', org: true },
  invoice: { base: '/invoice/v3', org: true },
  inventory: { base: '/inventory/v1', org: true },
  crm: { base: '/crm/v6', org: false },
};

class ZohoError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'ZohoError';
    this.status = status;   // HTTP status
    this.code = code;       // Zoho's own numeric code (0 = success)
    this.body = body;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Minimal Zoho API client: refresh-token auth with caching, data-center aware, retries on
 * 429/5xx, automatic organization_id, and page iteration. No dependencies (Node 20+ fetch).
 */
class ZohoClient {
  constructor(opts = {}) {
    for (const k of ['clientId', 'clientSecret', 'refreshToken']) {
      if (!opts[k]) throw new Error(`ZohoClient: ${k} is required`);
    }
    const dc = datacenter(opts.dc || 'us');
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshToken = opts.refreshToken;
    this.accountsServer = opts.accountsServer ? trustedAccountsServer(opts.accountsServer) : dc.accounts;
    this.apiDomain = (opts.apiDomain || '').replace(/\/+$/, '') || null;   // set from the token response if empty
    this.defaultApiDomain = dc.api;
    this.organizationId = opts.organizationId || null;
    this.fetch = opts.fetch || globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this._token = null;
    this._expires = 0;
    this._refreshing = null;
  }

  /** Build a client from ZOHO_* environment variables (see .env.example). */
  static fromEnv(env = process.env, extra = {}) {
    return new ZohoClient({
      clientId: env.ZOHO_CLIENT_ID,
      clientSecret: env.ZOHO_CLIENT_SECRET,
      refreshToken: env.ZOHO_REFRESH_TOKEN,
      dc: env.ZOHO_DC || 'us',
      accountsServer: env.ZOHO_ACCOUNTS_SERVER,
      apiDomain: env.ZOHO_API_DOMAIN,
      organizationId: env.ZOHO_ORG_ID,
      ...extra,
    });
  }

  /** A valid access token. Concurrent callers share one refresh. */
  async accessToken() {
    if (this._token && Date.now() < this._expires) return this._token;
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async _refresh() {
    // Secrets go in the form body, not the URL, so they never land in proxy or access logs.
    const form = new URLSearchParams({
      refresh_token: this.refreshToken, client_id: this.clientId,
      client_secret: this.clientSecret, grant_type: 'refresh_token',
    });
    const r = await this.fetch(`${this.accountsServer}/oauth/v2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this._lastRefresh = Date.now();
    const data = await r.json().catch(() => ({}));
    // Zoho answers token errors with HTTP 200 and {"error": "..."}.
    if (!r.ok || data.error || !data.access_token) {
      const why = data.error || `HTTP ${r.status}`;
      throw new ZohoError(`Zoho token refresh failed: ${why}. If it says invalid_code or invalid_client, ` +
        `check ZOHO_DC (the account's data center) and re-run bin/zoho-auth.js.`, { status: r.status, body: data });
    }
    this._token = data.access_token;
    this._expires = Date.now() + ((data.expires_in || 3600) - 60) * 1000;   // renew a minute early
    if (!this.apiDomain && data.api_domain) this.apiDomain = data.api_domain.replace(/\/+$/, '');
    return this._token;
  }

  /**
   * request('books', 'GET', '/contacts', { query, body }) -> parsed JSON.
   * Pass orgId: false to skip organization_id (e.g. GET /organizations).
   */
  async request(service, method, path, { query = {}, body, orgId } = {}) {
    const svc = SERVICES[service];
    if (!svc) throw new Error(`Unknown Zoho service "${service}". Known: ${Object.keys(SERVICES).join(', ')}`);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    const org = orgId === undefined ? this.organizationId : orgId;
    if (svc.org && org) q.set('organization_id', org);
    else if (svc.org && orgId !== false) throw new Error('organizationId is required for ' + service + ' (set ZOHO_ORG_ID)');

    // Only reads are safe to repeat after a server error or a dropped connection: a retried POST
    // can create a second invoice. Every method may retry a 429, which Zoho answers before acting.
    const idempotent = method === 'GET' || method === 'HEAD';
    for (let attempt = 0, refreshed = false; ; attempt++) {
      const token = await this.accessToken();
      const url = `${this.apiDomain || this.defaultApiDomain}${svc.base}${path}${q.size ? '?' + q : ''}`;
      let r;
      try {
        r = await this.fetch(url, {
          method,
          headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (idempotent && attempt < this.maxRetries) { await sleep(Math.min(30000, 1000 * 2 ** attempt)); continue; }
        throw new ZohoError(`Zoho ${method} ${path}: ${e.message}`, { status: 0 });
      }
      const text = await r.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }

      // 401: the token expired early or was revoked. Refresh once, and only if nobody else already
      // replaced this token; a 401 that survives a fresh token is a scope/permission problem, so
      // don't burn Zoho's per-refresh-token limit retrying it.
      if (r.status === 401 && !refreshed && Date.now() - (this._lastRefresh || 0) > 30000) {
        refreshed = true;
        if (this._token === token) this._token = null;
        continue;
      }
      if ((r.status === 429 || (idempotent && r.status >= 500)) && attempt < this.maxRetries) {
        const ra = r.headers.get('retry-after');
        // Zoho's limit is per minute, so back off in seconds, not milliseconds.
        const wait = ra !== null && ra !== '' && !isNaN(ra) ? Math.min(60000, Number(ra) * 1000)
          : Math.min(60000, (r.status === 429 ? 5000 : 1000) * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (!r.ok || (typeof data.code === 'number' && data.code !== 0)) {
        throw new ZohoError(`Zoho ${method} ${path}: ${data.message || 'HTTP ' + r.status}`,
          { status: r.status, code: data.code, body: data });
      }
      return data;
    }
  }

  /** Iterate every record of a list endpoint: for await (const c of client.paginate('books', '/contacts', 'contacts')). */
  async *paginate(service, path, listKey, query = {}) {
    for (let page = 1; ; page++) {
      const data = await this.request(service, 'GET', path, { query: { per_page: 200, ...query, page } });
      for (const item of data[listKey] || []) yield item;
      if (!data.page_context?.has_more_page) return;
    }
  }
}

module.exports = { ZohoClient, ZohoError, SERVICES };
