// services/gmail.js — Gmail draft creation for the one user's mailbox.
//
// Scope for this phase is DRAFTS ONLY: Donna composes an email and stages it as a Gmail
// draft in the user's account. Nothing is ever sent from here — the user reviews and sends
// from Gmail. (Matches the roadmap's "draft first" ethos; a send path can be added later.)
//
// Auth: the same Google service account as Calendar/Sheets, using DOMAIN-WIDE DELEGATION to
// impersonate the user's mailbox (a service account has no mailbox of its own, so Gmail
// requires impersonation). One-time Workspace setup: grant the service account the
// gmail.compose scope in Admin console → Security → API controls → Domain-wide delegation.
//
// Config:
//   GMAIL_IMPERSONATE_EMAIL  the mailbox to draft into (falls back to GOOGLE_IMPERSONATE_EMAIL).
// Without credentials + an impersonation address, isEnabled() is false and the tools say so.

const { google } = require('googleapis');
const { getGoogleCredentials } = require('../utils/googleAuth');

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.compose'];

class GmailService {
  constructor() {
    this.credentials = getGoogleCredentials();
    this.impersonate = process.env.GMAIL_IMPERSONATE_EMAIL || process.env.GOOGLE_IMPERSONATE_EMAIL || null;
    this._gmail = null;

    if (!this.credentials) {
      console.warn('Gmail: no Google service-account credentials — Gmail tools disabled');
    } else if (!this.impersonate) {
      console.warn('Gmail: no GMAIL_IMPERSONATE_EMAIL / GOOGLE_IMPERSONATE_EMAIL — Gmail tools disabled');
    }
  }

  /** True when credentials + an impersonation mailbox are both configured. */
  isEnabled() {
    return !!(this.credentials && this.impersonate);
  }

  /** Lazily build a Gmail client authorized via domain-wide delegation (JWT + subject). */
  getClient() {
    if (this._gmail) return this._gmail;
    if (!this.isEnabled()) {
      throw new Error('Gmail is not configured (needs Google service-account credentials and an impersonation mailbox).');
    }
    const jwt = new google.auth.JWT({
      email: this.credentials.client_email,
      key: this.credentials.private_key,
      scopes: GMAIL_SCOPES,
      subject: this.impersonate
    });
    this._gmail = google.gmail({ version: 'v1', auth: jwt });
    return this._gmail;
  }

  /**
   * Create a draft email in the user's mailbox. Never sends.
   * @param {Object} p
   * @param {string[]|string} p.to    recipient address(es)
   * @param {string[]|string} [p.cc]
   * @param {string} p.subject
   * @param {string} p.body           plain-text body
   * @returns {Promise<{id:string, messageId:string, threadId:string, webLink:string, to:string[], cc:string[]}>}
   */
  async createDraft({ to, cc, subject, body }) {
    const gmail = this.getClient();

    const toList = this.finalRecipients(to);
    const ccList = GmailService.dedupe(GmailService.normalizeRecipients(cc))
      .filter(a => a.toLowerCase() !== this.impersonate.toLowerCase());
    if (!toList.length) throw new Error('A draft needs at least one recipient.');

    const raw = GmailService.buildRawMessage({
      from: this.impersonate,
      to: toList,
      cc: ccList,
      subject: subject || '(no subject)',
      body: body || ''
    });

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } }
    });

    const draftId = res.data.id;
    const messageId = res.data.message && res.data.message.id;
    const threadId = res.data.message && res.data.message.threadId;
    return {
      id: draftId,
      messageId: messageId || null,
      threadId: threadId || null,
      webLink: draftId ? `https://mail.google.com/mail/u/0/#drafts?compose=${draftId}` : 'https://mail.google.com/mail/u/0/#drafts',
      to: toList,
      cc: ccList
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Resolve the final "To" list: normalize, dedupe, and drop the sender's own address
   * (a call follow-up shouldn't email the user themselves) — BUT if excluding the sender
   * would leave no recipients at all (e.g. a deliberate note-to-self), keep the full list
   * rather than producing an empty, un-saveable draft.
   */
  finalRecipients(input) {
    const all = GmailService.dedupe(GmailService.normalizeRecipients(input));
    if (!this.impersonate) return all;
    const self = this.impersonate.toLowerCase();
    const others = all.filter(a => a.toLowerCase() !== self);
    return others.length ? others : all;
  }

  /** Case-insensitive de-duplication, preserving first-seen order/casing. */
  static dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const a of list || []) {
      const key = a.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(a); }
    }
    return out;
  }

  /** Accept an array or a comma/semicolon-separated string; return a clean address list. */
  static normalizeRecipients(input) {
    if (!input) return [];
    const arr = Array.isArray(input) ? input : String(input).split(/[,;]/);
    return arr.map(s => String(s).trim()).filter(Boolean);
  }

  /** Base64url-encode a raw RFC 2822 message (UTF-8 subject/body safe). */
  static buildRawMessage({ from, to, cc, subject, body }) {
    const headers = [
      `From: ${from}`,
      `To: ${to.join(', ')}`,
      ...(cc && cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${GmailService.encodeHeader(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit'
    ];
    const mime = `${headers.join('\r\n')}\r\n\r\n${body}`;
    return Buffer.from(mime, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /** RFC 2047 encode a header value only when it has non-ASCII characters. */
  static encodeHeader(value) {
    const v = String(value);
    if (/^[\x00-\x7F]*$/.test(v)) return v;
    return `=?UTF-8?B?${Buffer.from(v, 'utf-8').toString('base64')}?=`;
  }
}

module.exports = new GmailService();
