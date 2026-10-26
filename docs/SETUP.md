# Setting up the Zoho side

About 10 minutes. You need a Zoho Books organisation and an admin login.

## 1. Find your data center

Look at the address bar when you're signed in to Zoho Books:

| You see | `ZOHO_DC` |
|---|---|
| books.zoho.**com** | `us` |
| books.zoho.**eu** | `eu` |
| books.zoho.**in** | `in` |
| books.zoho.**com.au** | `au` |
| books.zoho.**jp** | `jp` |
| books.zoho**cloud.ca** | `ca` |
| books.zoho.**sa** | `sa` |
| books.zoho.**uk** | `uk` |
| books.zoho.**com.cn** | `cn` |

The most common integration failure is an `invalid_code` or `invalid_client` error that is
really a **data-center mismatch**. Accounts, tokens and data live in one DC only. The browser
flow in this repo reads the DC Zoho reports back, so it handles this for you.

## 2. Create an API client

Open the API Console for your DC (`https://api-console.zoho.<your-dc>`, e.g. api-console.zoho.com;
Canada is `https://api-console.zohocloud.ca`)
and choose one:

**Self Client.** Use this when the CRM is only for your own company. There's no redirect URL and
no web server.
1. *Add Client* → *Self Client* → *Create*. Copy the **Client ID** and **Client Secret**.
2. *Generate Code* tab → scopes: `ZohoBooks.contacts.ALL,ZohoBooks.estimates.ALL,ZohoBooks.invoices.ALL,ZohoBooks.settings.READ`
   → duration 10 minutes → description → *Create* → choose your organisation.
3. Within those 10 minutes:
   ```bash
   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node bin/zoho-auth.js self-client --code 1000.xxxx --dc us
   ```

**Server-based Application.** Use this when your CRM has a "Connect Zoho" button, for example a CRM you sell to other businesses.
1. *Add Client* → *Server-based Applications*.
   - Homepage URL: your CRM's address.
   - Authorized Redirect URI: `https://your-crm.example.com/integrations/zoho/callback`, and for
     local testing also `http://localhost:8765/callback`.
2. Copy the Client ID and Secret. Then either run the local round-trip:
   ```bash
   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... node bin/zoho-auth.js browser --dc us
   ```
   or wire up `examples/express-routes.js` in your CRM.
3. If your users are in other data centers, enable **Multi-DC** for the client in the console
   (*Settings* tab of the client), or they will get `invalid_client`. If you leave "use the same OAuth
credentials for all data centers" off, each DC gets its own client secret.

## 3. Save the output

`zoho-auth.js` prints the lines for your `.env`:

```
ZOHO_REFRESH_TOKEN=1000.…
ZOHO_DC=us
ZOHO_ACCOUNTS_SERVER=https://accounts.zoho.com
ZOHO_API_DOMAIN=https://www.zohoapis.com
ZOHO_ORG_ID=…
```

If your login sees several organisations, it lists them so you can pick one for `ZOHO_ORG_ID`.

## Token facts worth knowing

- **Access tokens last 1 hour.** The client refreshes them by itself, a minute early, and shares
  one refresh between concurrent requests.
- **Refresh tokens don't expire** until revoked. Treat one like a password: keep it server-side,
  out of git and logs, and encrypted in your database if you store it per customer.
- Zoho limits how many refresh tokens a user can hold per client. If you keep re-authorising in
  testing, revoke the old ones (`revoke()` in `src/oauth.js`, or *Connected Apps* in Zoho
  Accounts).
- Grant codes expire within minutes and work **once**. A second exchange of the same code
  returns `invalid_code`.
- Ask for the **smallest scopes** you need. Add `ZohoBooks.customerpayments.READ` if you want
  payments, and so on. Changing scopes means connecting again.

## API limits (Zoho Books)

- 100 requests per minute per organisation (you get HTTP 429 if you go over; the client retries with backoff).
- Daily caps by plan: Free 1,000 · Standard 2,000 · Professional 5,000 · Premium and up 10,000.
- Up to 10 concurrent calls on paid plans (5 on Free).

Sync in batches, cache what you show on screens (balances don't change every second), and use
`page`/`per_page` (`paginate()` does both).
