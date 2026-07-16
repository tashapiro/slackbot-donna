// services/googleSheets.js — read-only Google Sheets access.
//
// Donna's client registry lives in a Google Sheet the user maintains (see
// docs/roadmap.md → Phase 2). This service authenticates as the same Google
// service account used for Calendar (share the sheet with the service-account
// email) and reads raw cell values. It does one thing: fetch rows from a range.
//
// Defensive by design: if googleapis or credentials are missing, isEnabled()
// returns false and callers degrade gracefully (the registry reports "not
// configured") — nothing here can crash the bot at boot.

const { getGoogleCredentials } = require('../utils/googleAuth');

let google = null;
try {
  ({ google } = require('googleapis'));
} catch (err) {
  console.warn('⚠️ googleapis not available; Google Sheets disabled:', err.message);
}

class GoogleSheetsService {
  constructor() {
    this.credentials = getGoogleCredentials();
    this.auth = null;
    this.sheets = null;

    if (google && this.credentials) {
      this.initializeAuth();
    } else if (!this.credentials) {
      console.warn('Google Sheets credentials not configured (client registry will be empty)');
    }
  }

  initializeAuth() {
    try {
      const authConfig = {
        credentials: this.credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
      };
      // Honor Domain-Wide Delegation if configured, same as Calendar.
      if (process.env.GOOGLE_IMPERSONATE_EMAIL) {
        authConfig.subject = process.env.GOOGLE_IMPERSONATE_EMAIL;
      }
      this.auth = new google.auth.GoogleAuth(authConfig);
      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      console.log('✅ Google Sheets API initialized');
    } catch (error) {
      console.error('Failed to initialize Google Sheets API:', error.message);
      this.sheets = null;
    }
  }

  /** True when the Sheets client is ready to make calls. */
  isEnabled() {
    return !!this.sheets;
  }

  /**
   * Fetch a rectangular block of cell values.
   * @param {string} spreadsheetId  The sheet ID (from its URL).
   * @param {string} range          A1 range, e.g. "Clients!A1:E100" or "A:E".
   * @returns {Promise<Array<Array<string>>>} rows of string cells (empty if none).
   */
  async getRows(spreadsheetId, range) {
    if (!this.sheets) {
      throw new Error('Google Sheets not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON (or client email + private key).');
    }
    if (!spreadsheetId) {
      throw new Error('No spreadsheetId provided (set CLIENT_REGISTRY_SHEET_ID).');
    }
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      majorDimension: 'ROWS'
    });
    const values = (res && res.data && res.data.values) || [];
    // Normalize every cell to a trimmed string so downstream parsing is simple.
    return values.map(row => (Array.isArray(row) ? row.map(c => (c == null ? '' : String(c).trim())) : []));
  }
}

module.exports = new GoogleSheetsService();
