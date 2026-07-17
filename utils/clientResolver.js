// utils/clientResolver.js — resolve the active client for a message.
//
// The user's Slack is NOT one-channel-per-client (a shared call-notes channel holds Fireflies
// notes across clients), so the channel can't determine scope. Instead we resolve per message:
// match the message (and its thread transcript) against the client registry's names / aliases /
// email domains, and return one of:
//   • confident  — a single clear client; surface it (📁 tag) so mistakes are visible
//   • ambiguous  — multiple candidates; the caller should ask "which client?"
//   • none       — no client detected; treat as non-client-scoped
//
// Explicit overrides ("for Beta, …", "client: Beta") win. This is a PURE function over an
// injected registry (no I/O) so it's unit-testable with a mock client list.

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-ish-word containment of `term` in an already-lowercased haystack. */
function mentions(haystackLower, term) {
  const t = String(term || '').toLowerCase().trim();
  if (t.length < 2) return false;
  const re = new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`, 'i');
  return re.test(haystackLower);
}

/** Does this client appear in the haystack (name, any alias, or an email domain)? */
function clientMentioned(haystackLower, client) {
  if (mentions(haystackLower, client.name)) return true;
  for (const a of client.aliases || []) {
    if (mentions(haystackLower, a)) return true;
  }
  // emailDomains is the current shape; emailDomain (string) kept for backward compatibility.
  const domains = client.emailDomains || (client.emailDomain ? [client.emailDomain] : []);
  for (const d of domains) {
    if (d && haystackLower.includes(String(d).toLowerCase())) return true;
  }
  return false;
}

function transcriptToText(transcript) {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript;
  if (Array.isArray(transcript)) {
    return transcript.map(m => (m && typeof m === 'object' ? m.text || '' : String(m || ''))).join('\n');
  }
  return '';
}

/**
 * Detect an explicit override phrase ("for <Client>", "client: <Client>", "re <Client>")
 * and resolve it against the registry. Returns the matched client or null.
 */
function detectOverride(text, clients) {
  const patterns = [
    /\bfor\s+([a-z0-9&.\-' ]{2,40})/gi,
    /\bclient[:\s]+([a-z0-9&.\-' ]{2,40})/gi,
    /\bre[:\s]+([a-z0-9&.\-' ]{2,40})/gi
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const phrase = ` ${m[1].toLowerCase()} `;
      for (const c of clients) {
        if (clientMentioned(phrase, c)) return c;
      }
    }
  }
  return null;
}

/**
 * Resolve the active client for a message.
 * @param {Object} p
 * @param {string} p.text               The current message text.
 * @param {string|Array} [p.transcript] The thread transcript (string or [{text}]).
 * @param {Array} p.clients             Registry client objects (name, aliases, emailDomain, ...).
 * @returns {{status:'confident'|'ambiguous'|'none', client:Object|null, candidates:Array, source:string}}
 */
function resolveClient({ text = '', transcript = '', clients = [] } = {}) {
  const none = { status: 'none', client: null, candidates: [], source: 'none' };
  if (!Array.isArray(clients) || clients.length === 0) return none;

  const msgLower = String(text || '').toLowerCase();

  // 1) Explicit override wins outright.
  const override = detectOverride(msgLower, clients);
  if (override) {
    return { status: 'confident', client: override, candidates: [override], source: 'override' };
  }

  // 2) Clients named in the current message (strongest signal).
  const inMessage = clients.filter(c => clientMentioned(msgLower, c));
  if (inMessage.length === 1) {
    return { status: 'confident', client: inMessage[0], candidates: inMessage, source: 'message' };
  }
  if (inMessage.length > 1) {
    return { status: 'ambiguous', client: null, candidates: inMessage, source: 'message' };
  }

  // 3) Fall back to the thread transcript.
  const threadLower = transcriptToText(transcript).toLowerCase();
  if (threadLower) {
    const inThread = clients.filter(c => clientMentioned(threadLower, c));
    if (inThread.length === 1) {
      return { status: 'confident', client: inThread[0], candidates: inThread, source: 'transcript' };
    }
    if (inThread.length > 1) {
      return { status: 'ambiguous', client: null, candidates: inThread, source: 'transcript' };
    }
  }

  return none;
}

module.exports = { resolveClient, _internal: { mentions, clientMentioned, detectOverride, transcriptToText } };
