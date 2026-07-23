// services/quickbooks.js — wraps the QuickBooks Online Accounting API (invoices, customers,
// items) for Donna's billing capability. Follows the one-file-per-API service pattern, but is the
// first to authenticate with OAuth2 + a rotating refresh token rather than a static env-var key.
//
// Auth model (see docs/quickbooks-design.md):
//   • The INITIAL refresh token is minted once, out-of-band (Intuit's OAuth 2.0 Playground or a
//     one-off local script) and seeded via QBO_REFRESH_TOKEN. This avoids needing an inbound OAuth
//     callback route in the socket-mode Render worker.
//   • From then on this service auto-refreshes the ~1h access token on demand and PERSISTS the
//     rotated refresh token to Postgres (services/quickbooksTokenStore.js), which becomes the
//     source of truth. Token refresh is a plain POST to Intuit's token endpoint — no extra
//     dependency needed.
//
// Defensive: without the client id/secret, a realm id, and a database for the token store,
// isEnabled() is false and the billing tools report "not configured" — the bot runs as before.
//
// Editing an invoice is READ-MODIFY-WRITE: QBO has no PATCH; every update is a POST of the FULL
// object with its current Id + SyncToken (a stale token → 400). Callers fetch, mutate, then write.

const tokenStore = require('./quickbooksTokenStore');

// Intuit's token endpoint is the same for sandbox and production; only the API base differs.
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR_VERSION = '73'; // pin field availability; bump deliberately.

class QuickBooksService {
  constructor() {
    this.clientId = process.env.QBO_CLIENT_ID;
    this.clientSecret = process.env.QBO_CLIENT_SECRET;
    this.realmId = process.env.QBO_REALM_ID;
    this.environment = (process.env.QBO_ENVIRONMENT || 'sandbox').toLowerCase();
    this.seedRefreshToken = process.env.QBO_REFRESH_TOKEN || null;
    // Default item to hang line items off of when the caller doesn't name one. QBO requires every
    // sales line to reference an Item; a solo consultancy typically bills a single "Services" item.
    this.defaultItemName = process.env.QBO_DEFAULT_ITEM || 'Services';

    this.apiBase = this.environment === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
    this.appBase = this.environment === 'production'
      ? 'https://app.qbo.intuit.com'
      : 'https://app.sandbox.qbo.intuit.com';

    if (!this.clientId || !this.clientSecret) {
      console.warn('QuickBooks: QBO_CLIENT_ID / QBO_CLIENT_SECRET not set — QuickBooks tools disabled');
    } else if (!this.realmId) {
      console.warn('QuickBooks: QBO_REALM_ID not set — QuickBooks tools disabled');
    } else if (!tokenStore.isEnabled()) {
      console.warn('QuickBooks: no DATABASE_URL for the token store — QuickBooks tools disabled');
    }
  }

  /** True when app creds + a realm + a durable token store are all configured. */
  isEnabled() {
    return !!(this.clientId && this.clientSecret && this.realmId && tokenStore.isEnabled());
  }

  _assert() {
    if (!this.isEnabled()) {
      throw new Error('QuickBooks is not configured (needs QBO_CLIENT_ID/SECRET, QBO_REALM_ID, and DATABASE_URL).');
    }
  }

  /** A user-facing deep link to an invoice in the QuickBooks UI. */
  invoiceUrl(id) {
    return id ? `${this.appBase}/app/invoice?txnId=${id}` : `${this.appBase}/app/invoices`;
  }

  // ── OAuth: refresh + persist ─────────────────────────────────────────────────

  /** Exchange the stored refresh token for a fresh access token, persisting the rotated tokens. */
  async _refresh(refreshToken) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
    const t = await resp.json().catch(() => ({}));
    if (!resp.ok || !t.access_token) {
      throw new Error(`QBO token refresh failed (${resp.status}): ${t.error_description || t.error || 'unknown error'}. ` +
        'The refresh token may have expired — re-seed QBO_REFRESH_TOKEN.');
    }
    const saved = await tokenStore.save({
      realmId: this.realmId,
      accessToken: t.access_token,
      accessExpiresAt: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000),
      refreshToken: t.refresh_token || refreshToken, // Intuit returns the rotated one; keep old if absent
      refreshExpiresAt: new Date(Date.now() + (Number(t.x_refresh_token_expires_in) || 8640000) * 1000)
    });
    return saved.access_token;
  }

  /**
   * Return a valid access token, refreshing (and persisting) when the stored one is missing or
   * within 60s of expiry. Seeds the refresh token from QBO_REFRESH_TOKEN on first ever use.
   */
  async _getAccessToken({ force = false } = {}) {
    this._assert();
    let row = await tokenStore.load(this.realmId);
    if (!row && this.seedRefreshToken) {
      row = { refresh_token: this.seedRefreshToken, access_token: null, access_expires_at: null };
    }
    if (!row || !row.refresh_token) {
      throw new Error('No QBO refresh token stored. Seed QBO_REFRESH_TOKEN once (see docs/quickbooks-design.md).');
    }
    const stillValid = !force && row.access_token && row.access_expires_at &&
      new Date(row.access_expires_at).getTime() - Date.now() > 60_000;
    if (stillValid) return row.access_token;
    return this._refresh(row.refresh_token);
  }

  // ── Raw request ──────────────────────────────────────────────────────────────

  /**
   * Call an Accounting API endpoint. `path` is everything after /v3/company/{realmId}, e.g.
   * "/invoice" or "/query?query=...". Retries once on a 401 by forcing a token refresh.
   */
  async _request(method, path, body, { retryOnAuth = true } = {}) {
    const token = await this._getAccessToken();
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.apiBase}/v3/company/${this.realmId}${path}${sep}minorversion=${MINOR_VERSION}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (resp.status === 401 && retryOnAuth) {
      await this._getAccessToken({ force: true }); // token died early — refresh and retry once
      return this._request(method, path, body, { retryOnAuth: false });
    }
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const fault = json.Fault || json.fault;
      const detail = fault && fault.Error && fault.Error[0]
        ? `${fault.Error[0].Message}${fault.Error[0].Detail ? ` — ${fault.Error[0].Detail}` : ''}`
        : JSON.stringify(json);
      throw new Error(`QBO ${method} ${path.split('?')[0]} ${resp.status}: ${detail}`);
    }
    return json;
  }

  _query(sql) {
    return this._request('GET', `/query?query=${encodeURIComponent(sql)}`);
  }

  // Escape a value for a QBO SQL string literal (single quotes are doubled... actually backslash).
  static _esc(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // ── Customers & items (invoice references) ───────────────────────────────────

  /** Find a customer by exact display name, or null. */
  async findCustomer(name) {
    const r = await this._query(`SELECT * FROM Customer WHERE DisplayName = '${QuickBooksService._esc(name)}'`);
    return (r.QueryResponse && r.QueryResponse.Customer && r.QueryResponse.Customer[0]) || null;
  }

  /** Find a sales item by exact name, or null. */
  async findItem(name) {
    const r = await this._query(`SELECT * FROM Item WHERE Name = '${QuickBooksService._esc(name)}'`);
    return (r.QueryResponse && r.QueryResponse.Item && r.QueryResponse.Item[0]) || null;
  }

  // ── Invoices ─────────────────────────────────────────────────────────────────

  /** Create an invoice from a full Invoice object; returns the created invoice. */
  async createInvoice(invoice) {
    const r = await this._request('POST', '/invoice', invoice);
    return r.Invoice;
  }

  /** Fetch one invoice by its QBO id. */
  async getInvoice(id) {
    const r = await this._request('GET', `/invoice/${encodeURIComponent(id)}`);
    return r.Invoice;
  }

  /** Find an invoice by its human-facing DocNumber (the "invoice number"), or null. */
  async findInvoiceByNumber(docNumber) {
    const r = await this._query(`SELECT * FROM Invoice WHERE DocNumber = '${QuickBooksService._esc(docNumber)}'`);
    return (r.QueryResponse && r.QueryResponse.Invoice && r.QueryResponse.Invoice[0]) || null;
  }

  /** List recent invoices, optionally scoped to one customer id. */
  async listInvoices({ customerId = null, limit = 20 } = {}) {
    let sql = 'SELECT * FROM Invoice';
    if (customerId) sql += ` WHERE CustomerRef = '${QuickBooksService._esc(customerId)}'`;
    sql += ` ORDERBY MetaData.CreateTime DESC MAXRESULTS ${Math.min(Number(limit) || 20, 100)}`;
    const r = await this._query(sql);
    return (r.QueryResponse && r.QueryResponse.Invoice) || [];
  }

  /**
   * Update an invoice. Pass the FULL, current invoice object (with its Id + SyncToken) after
   * mutating it — QBO has no partial update. A stale SyncToken throws a 400; refetch and retry.
   */
  async updateInvoice(fullInvoice) {
    if (!fullInvoice || !fullInvoice.Id || fullInvoice.SyncToken == null) {
      throw new Error('updateInvoice needs the full invoice object including Id and SyncToken.');
    }
    const r = await this._request('POST', '/invoice', { ...fullInvoice, sparse: false });
    return r.Invoice;
  }

  // ── Pure helpers (exported for offline tests) ────────────────────────────────

  /**
   * Build a QBO Invoice payload from a resolved customer, resolved line items, and options.
   * @param {Object} customer  a QBO Customer ({ Id, DisplayName }).
   * @param {Array}  lines     [{ description, quantity, rate, item: { Id, Name } }]
   * @param {Object} [opts]    { dueDate, txnDate, memo }
   */
  static buildInvoicePayload(customer, lines, opts = {}) {
    const Line = lines.map(l => {
      const qty = Number(l.quantity) || 1;
      const rate = Number(l.rate) || 0;
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(qty * rate * 100) / 100,
        Description: l.description || (l.item && l.item.Name) || undefined,
        SalesItemLineDetail: {
          ItemRef: { value: l.item.Id, name: l.item.Name },
          Qty: qty,
          UnitPrice: rate
        }
      };
    });
    const payload = {
      CustomerRef: { value: customer.Id, name: customer.DisplayName },
      Line
    };
    if (opts.txnDate) payload.TxnDate = opts.txnDate;
    if (opts.dueDate) payload.DueDate = opts.dueDate;
    if (opts.memo) payload.CustomerMemo = { value: String(opts.memo) };
    return payload;
  }

  /** Sum a set of {quantity, rate} lines to a 2-dp total (for previews). */
  static lineTotal(lines) {
    const sum = (lines || []).reduce((acc, l) => acc + (Number(l.quantity) || 1) * (Number(l.rate) || 0), 0);
    return Math.round(sum * 100) / 100;
  }
}

module.exports = new QuickBooksService();
