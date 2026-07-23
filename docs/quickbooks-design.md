# QuickBooks Online (Phase 5) — design + implementation notes

Design for adding QBO invoice **create + edit** to Donna.

> **Status: 5a–5c implemented** (offline-verified via `npm run check:qbo`). The live pieces are
> `services/quickbooksTokenStore.js`, `services/quickbooks.js`, `handlers/billing.js`, the four
> tools in `utils/donnaTools.js` (`list_invoices`, `get_invoice`, `propose_invoice`,
> `edit_invoice`), and the confirm wiring in `app.js`. **One deviation from the sketch below:** the
> token refresh is a plain `POST` to Intuit's token endpoint (`fetch`), **not** the `intuit-oauth`
> package — so there's **no new dependency**. Everything else follows this design. What remains
> before it works in prod is the Intuit app setup + env vars + a sandbox pass (5d), below.

The original sketch is preserved below so the reasoning is on record.

Guiding constraints, all already true in this codebase:
- **One file wraps one API**, constructed from env vars, exporting a singleton, with an
  `isEnabled()` gate so the bot boots and degrades gracefully when unconfigured
  (`services/fireflies.js`, `services/gmail.js`).
- **Writes are preview-then-confirm** — a tool stages a `pending_*` object and posts a Slack
  card; a handler does the confirm and only then touches the external API
  (`handlers/comms.js`). Money movement obviously stays on this pattern.
- **One module owns each DB table** and is defensively gated on `DATABASE_URL`
  (`services/memoryStore.js`).
- **Client isolation is enforced in storage/resolution, never the prompt.** Invoicing is
  inherently single-client (one QBO Customer), which fits the outbound-isolation rule.

---

## 1. What QBO gives us (the API facts the design rests on)

- **Accounting API v3**, base URL
  `https://quickbooks.api.intuit.com/v3/company/{realmId}` (production) or
  `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}` (sandbox). `realmId` = the
  company id; IndieVisual is one company, so it's a single fixed value.
- **Invoice CRUD:**
  - Create — `POST /invoice` with a JSON `Invoice` object.
  - Read — `GET /invoice/{id}`, or query: `GET /query?query=SELECT * FROM Invoice WHERE ...`.
  - **Update — `POST /invoice` with the _full_ object plus its current `Id` and `SyncToken`.**
    No PUT/PATCH. `sparse=true` exists but is unreliable across entities → we always send the
    full object. A stale `SyncToken` → `400`; refetch and retry.
  - Delete/void — `POST /invoice?operation=delete` (or `void`).
- **An invoice references other entities:** `CustomerRef` (required) and `Line[]` items that
  reference an `Item` (`SalesItemLineDetail.ItemRef`). So creating one is a small sequence:
  resolve the Customer → resolve/create the Items → assemble the Invoice.
- **Auth: OAuth 2.0 authorization-code.** Access token ~1 h; **refresh token rotates roughly
  every 100 days** and is re-issued on each refresh — it must be persisted every time.
- **Rate limits** (plenty for a solo bot): ~500 req/min per realm, ~40 req/min throttle on
  bursts; 429 on breach. Not a design factor here.

---

## 2. The OAuth problem (the only genuinely new piece) and how we sidestep the callback

QBO needs a rotating refresh token stored somewhere durable. Two facts make the naive approach
fail:

1. **`.env` can't hold it** — it's static; the refresh token changes ~every 100 days and the
   process can't rewrite its own Render env.
2. **The Render worker is socket-mode** (Background Worker, no inbound HTTP) — so the standard
   OAuth *redirect callback* has nowhere to land.

**Resolution — seed once, auto-refresh forever, persist to Postgres:**

- Mint the **first** refresh token out-of-band, one time, using Intuit's **OAuth 2.0
  Playground** (or a tiny local `scripts/qbo-auth.js` run on a laptop where a `localhost`
  callback is fine). This is the same "paste a token once" pragmatism as
  `PELOTON_ACCESS_TOKEN` — but unlike Peloton it becomes self-renewing.
- Seed it via `QBO_REFRESH_TOKEN` + `QBO_REALM_ID` on first boot; `services/quickbooks.js`
  imports it into the token store, then **auto-refreshes the access token on demand and
  re-persists the rotated refresh token** — so after the one seed, the env var is just a
  fallback and the DB is the source of truth.
- No callback route in the worker. (If we later run HTTP mode, a `/oauth/qbo/callback` route on
  the Bolt Express receiver is a clean upgrade, but it's explicitly *not* required for v1.)

---

## 3. `services/quickbooksTokenStore.js` — the durable token table

The **only** module that touches the `qbo_tokens` table, modeled on `memoryStore.js` (Postgres
via `pg`, same `DATABASE_URL`, same defensive gating). Single business ⇒ effectively one row,
keyed by `realm_id`.

```
qbo_tokens(
  realm_id           TEXT PRIMARY KEY,
  access_token       TEXT,
  access_expires_at  TIMESTAMPTZ,
  refresh_token      TEXT NOT NULL,
  refresh_expires_at TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

```js
// services/quickbooksTokenStore.js — the ONLY module that touches qbo_tokens.
// Postgres via DATABASE_URL (reuses the Phase 2 database). Defensive: no DATABASE_URL / no `pg`
// → isEnabled() false and QBO reports "not configured", the bot runs exactly as before.
let Pool = null;
try { ({ Pool } = require('pg')); } catch (err) {
  console.warn('⚠️ pg not available; QBO token store disabled:', err.message);
}

let pool = null, initPromise = null;
const connStr = () => process.env.DATABASE_URL || '';
function getPool() {
  if (!Pool || !connStr()) return null;
  if (!pool) pool = new Pool({ connectionString: connStr(), ssl: { rejectUnauthorized: false }, max: 2 });
  return pool;
}
function isEnabled() { return !!getPool(); }

function init() {
  if (!isEnabled()) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS qbo_tokens (
        realm_id           TEXT PRIMARY KEY,
        access_token       TEXT,
        access_expires_at  TIMESTAMPTZ,
        refresh_token      TEXT NOT NULL,
        refresh_expires_at TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).then(() => true).catch(err => { console.error('qbo token init failed:', err.message); initPromise = null; return false; });
  }
  return initPromise;
}

async function load(realmId) {
  if (!isEnabled()) return null;
  await init();
  const r = await getPool().query(`SELECT * FROM qbo_tokens WHERE realm_id = $1`, [realmId]);
  return r.rows[0] || null;
}

// Upsert — called after every refresh so the ROTATED refresh token is never lost.
async function save({ realmId, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }) {
  if (!isEnabled()) throw new Error('QBO token store not configured (set DATABASE_URL).');
  await init();
  await getPool().query(`
    INSERT INTO qbo_tokens (realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
    VALUES ($1,$2,$3,$4,$5, now())
    ON CONFLICT (realm_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      access_expires_at = EXCLUDED.access_expires_at,
      refresh_token = EXCLUDED.refresh_token,
      refresh_expires_at = EXCLUDED.refresh_expires_at,
      updated_at = now()
  `, [realmId, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt]);
}

module.exports = { isEnabled, init, load, save };
```

---

## 4. `services/quickbooks.js` — the API wrapper

Same shape as the other services: env-configured constructor, `isEnabled()` gate, thin `fetch`
methods. The one addition is a private `getAccessToken()` that transparently refreshes and
persists. (The sketch below shows the `intuit-oauth` package for the token dance; **the shipped
code instead does a plain `POST` to Intuit's token endpoint with `fetch`** — `grant_type=
refresh_token`, HTTP Basic client id/secret — so there's no extra dependency. Accounting
endpoints use raw `fetch` either way.)

```js
// services/quickbooks.js — wraps the QuickBooks Online Accounting API (invoices, customers,
// items). Auth is OAuth2 with a rotating refresh token, persisted in quickbooksTokenStore.
// isEnabled() gates the whole thing; unconfigured → tools report "not configured".
const tokenStore = require('./quickbooksTokenStore');
let OAuthClient = null;
try { OAuthClient = require('intuit-oauth'); } catch (_) { /* optional until Phase 5 lands */ }

class QuickBooksService {
  constructor() {
    this.clientId = process.env.QBO_CLIENT_ID;
    this.clientSecret = process.env.QBO_CLIENT_SECRET;
    this.realmId = process.env.QBO_REALM_ID;
    this.environment = process.env.QBO_ENVIRONMENT || 'sandbox'; // 'sandbox' | 'production'
    this.seedRefreshToken = process.env.QBO_REFRESH_TOKEN;       // one-time seed only
    this.base = this.environment === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    if (!this.clientId) console.warn('QBO_CLIENT_ID not configured — QuickBooks disabled');
  }

  isEnabled() {
    return !!(OAuthClient && this.clientId && this.clientSecret && this.realmId && tokenStore.isEnabled());
  }
  _assert() { if (!this.isEnabled()) throw new Error('QuickBooks is not configured.'); }

  _oauth() {
    return new OAuthClient({
      clientId: this.clientId, clientSecret: this.clientSecret,
      environment: this.environment,
      redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost/qbo/callback', // seeding only
    });
  }

  // Return a valid access token, refreshing + persisting when expired. Seeds from
  // QBO_REFRESH_TOKEN on first ever use, then the DB is the source of truth.
  async _getAccessToken() {
    this._assert();
    let row = await tokenStore.load(this.realmId);
    if (!row && this.seedRefreshToken) {
      row = { refresh_token: this.seedRefreshToken, access_expires_at: null };
    }
    if (!row) throw new Error('No QBO refresh token — seed QBO_REFRESH_TOKEN once (see docs).');

    const fresh = row.access_token && row.access_expires_at &&
      new Date(row.access_expires_at).getTime() - Date.now() > 60_000; // 60s skew
    if (fresh) return row.access_token;

    const oauth = this._oauth();
    const res = await oauth.refreshUsingToken(row.refresh_token); // rotates the refresh token
    const t = res.getjson ? res.getjson() : res.token;
    await tokenStore.save({
      realmId: this.realmId,
      accessToken: t.access_token,
      accessExpiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
      refreshToken: t.refresh_token,                                  // <-- persist the NEW one
      refreshExpiresAt: new Date(Date.now() + (t.x_refresh_token_expires_in ?? 8640000) * 1000),
    });
    return t.access_token;
  }

  async _request(method, path, body, { retryOnAuth = true } = {}) {
    const token = await this._getAccessToken();
    const resp = await fetch(`${this.base}/v3/company/${this.realmId}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
                 ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401 && retryOnAuth) {          // token died early — force one refresh
      await tokenStore.save({ realmId: this.realmId, accessToken: null, accessExpiresAt: null,
        refreshToken: (await tokenStore.load(this.realmId)).refresh_token, refreshExpiresAt: null });
      return this._request(method, path, body, { retryOnAuth: false });
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`QBO ${method} ${path} ${resp.status}: ${JSON.stringify(json.Fault || json)}`);
    return json;
  }

  // ── Customers & items (invoice references) ──────────────────────────────────
  async findCustomer(name) {
    const q = `SELECT * FROM Customer WHERE DisplayName = '${name.replace(/'/g, "\\'")}'`;
    const r = await this._request('GET', `/query?query=${encodeURIComponent(q)}&minorversion=73`);
    return r.QueryResponse?.Customer?.[0] || null;
  }
  async findItem(name) {
    const q = `SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`;
    const r = await this._request('GET', `/query?query=${encodeURIComponent(q)}&minorversion=73`);
    return r.QueryResponse?.Item?.[0] || null;
  }

  // ── Invoices ────────────────────────────────────────────────────────────────
  async createInvoice(invoice) {                       // invoice = a full Invoice object
    const r = await this._request('POST', `/invoice?minorversion=73`, invoice);
    return r.Invoice;
  }
  async getInvoice(id) {
    const r = await this._request('GET', `/invoice/${id}?minorversion=73`);
    return r.Invoice;
  }
  async listInvoices({ customerId, limit = 20 } = {}) {
    let q = `SELECT * FROM Invoice`;
    if (customerId) q += ` WHERE CustomerRef = '${customerId}'`;
    q += ` ORDERBY TxnDate DESC MAXRESULTS ${Math.min(limit, 100)}`;
    const r = await this._request('GET', `/query?query=${encodeURIComponent(q)}&minorversion=73`);
    return r.QueryResponse?.Invoice || [];
  }
  // Edit = read-modify-write. Caller fetches, mutates, and passes the full object back; QBO
  // requires the current Id + SyncToken (stale token → 400; refetch upstream and retry).
  async updateInvoice(fullInvoice) {
    const r = await this._request('POST', `/invoice?minorversion=73`, fullInvoice);
    return r.Invoice;
  }
}

module.exports = new QuickBooksService();
```

**Why read-modify-write is exposed to the caller, not hidden:** the model proposes a *change*
("add 2 hours", "change the rate to $150"); the confirm handler fetches the live invoice, applies
the change to the full object (preserving `Id`/`SyncToken`), previews it, and POSTs on confirm.
Keeping the fetch in the handler means the preview shows the *actual* resulting invoice, and the
`SyncToken` is as fresh as possible.

---

## 5. Tools + confirm flow

### Tools (`utils/donnaTools.js`)
Same `{ name, description, inputSchema, run }` shape as today; bound to the request context.

- **Reads (direct):**
  - `list_invoices` — `{ client?, status? }` → recent invoices (optionally for one client's
    Customer). Returns text to the model.
  - `get_invoice` — `{ invoice_number | invoice_id }` → one invoice's detail.
- **Writes (staged → confirm card):**
  - `propose_invoice` — `{ client, line_items:[{description, quantity, rate}], due_date?, memo? }`.
    Resolves the QBO Customer (via the registry's `qbo_customer_id`, else `findCustomer`),
    resolves/creates Items, assembles the Invoice object, stashes it as `pending_invoice` in
    `dataStore`, and posts `billingHandler.buildInvoicePreviewBlocks(...)`. Returns "a preview is
    shown; do not claim it's created." (verbatim to the model's contract, like `propose_tasks`).
  - `edit_invoice` — `{ invoice_number, changes:{...} }`. Fetches the live invoice, applies the
    changes to the full object, stashes `pending_invoice_edit`, posts a diff-style preview.

Customer resolution runs through the **client registry**, so invoicing inherits Phase 2's
isolation: a `propose_invoice` for "Acme" can only ever target Acme's Customer, and the outbound
artifact is single-client by construction.

### Handler (`handlers/billing.js`)
Modeled directly on `handlers/comms.js`:

```js
// handlers/billing.js — preview-then-confirm for QBO invoices. The tool stashes a
// pending_invoice(_edit) in dataStore and posts one of these cards; the matching app.action
// handler calls confirm/cancel here. Nothing hits QuickBooks until the user clicks.
class BillingHandler {
  buildInvoicePreviewBlocks(pending, stableTs) { /* customer, line items, total, due date +
    "Create invoice" (donna_invoice_confirm) / "Cancel" (donna_invoice_cancel) buttons */ }

  async confirmPendingInvoice({ client, channel, thread_ts }) {
    const { pending_invoice } = dataStore.getThreadData(channel, thread_ts);
    if (!pending_invoice) return /* "nothing pending" */;
    const inv = await quickbooksService.createInvoice(pending_invoice.payload);
    dataStore.setThreadData(channel, thread_ts, { pending_invoice: null });
    await client.chat.postMessage({ channel, thread_ts,
      text: `✅ Invoice #${inv.DocNumber} created for ${pending_invoice.customerName} — $${inv.TotalAmt}.` });
  }
  async cancelPendingInvoice({ client, channel, thread_ts }) { /* clear + "scrapped it" */ }
}
```

Wire the four `action_id`s (`donna_invoice_confirm/cancel`, `donna_invoice_edit_confirm/cancel`)
in `app.js` next to the existing `donna_create_draft` / `donna_notetaker_*` handlers.

---

## 6. Config (`.env.example` block, to add when 5d lands)

```
# ── QuickBooks Online (billing / invoices) ───────────────────────────────────
# Donna creates & edits QBO invoices (preview-then-confirm). OAuth2: mint the initial refresh
# token once via Intuit's OAuth 2.0 Playground (or scripts/qbo-auth.js) and seed it below; the
# service auto-refreshes and persists rotations to Postgres (reuses DATABASE_URL). Without these,
# the billing tools report "not configured" and the bot runs exactly as before.
QBO_CLIENT_ID=              # [feature] Intuit app client id
QBO_CLIENT_SECRET=          # [feature] Intuit app client secret
QBO_ENVIRONMENT=sandbox     # sandbox | production — start on sandbox
QBO_REALM_ID=               # [feature] the QuickBooks company id
QBO_REFRESH_TOKEN=          # [feature] one-time seed refresh token (DB becomes source of truth after)
QBO_REDIRECT_URI=           # optional; only used by the one-off seeding script
```

---

## 7. Build order & open questions

**Order:** 5a auth foundation (token store + refresh loop, verified against sandbox) → 5b invoice
methods → 5c tools + confirm handler → 5d config/docs/`npm run check:qbo`. Ship against the
**sandbox** realm end-to-end (create → edit → restart-and-still-works) before flipping
`QBO_ENVIRONMENT=production`.

**Open questions to settle at build time:**
- **Item strategy** — auto-create a generic "Consulting Services" Item on first use, or require
  Items to pre-exist in QBO? (Leaning: reference a configurable default Item; only create on
  explicit request.)
- **Registry column** — add `qbo_customer_id` to the IndieVisual Hub sheet (mirrors the planned
  `asana_project_id`), or resolve customers purely by `DisplayName` match? (Leaning: registry
  column, with `findCustomer` as fallback.)
- **Send vs. create-only** — v1 creates the invoice in QBO (unsent draft). Emailing it to the
  client (`POST /invoice/{id}/send`) is a natural follow-up slice, kept behind its own confirm.
- **`minorversion`** — pin one (e.g. `73`) and bump deliberately; Intuit ties field availability
  to it.
