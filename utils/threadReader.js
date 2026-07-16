// utils/threadReader.js — Lets Donna read what was said in a Slack thread before
// she was @mentioned, so she can interpret context (e.g. a Fireflies/Fred recap)
// and act on it. Uses conversations.replies, which returns every message in the
// thread including bot posts.

const nameCache = new Map(); // userId -> display name (per-process cache)

/** Resolve a Slack user ID to a friendly display name, cached. */
async function resolveUserName(client, userId) {
  if (!userId) return 'Someone';
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    const res = await client.users.info({ user: userId });
    const p = res.user?.profile || {};
    const name = p.display_name || p.real_name || res.user?.name || userId;
    nameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/** Strip Slack markup down to readable plain text for an LLM prompt. */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<@([A-Z0-9]+)>/g, '@someone')              // raw user mentions
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')             // channel refs
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')    // labeled links
    .replace(/<(https?:[^>]+)>/g, '$1')                   // bare links
    .replace(/ /g, ' ')
    .trim();
}

/**
 * Fetch a thread's messages and return a lightweight transcript, oldest first:
 *   [{ author, text, ts, isBot }]
 * Empty/blank messages are dropped. Returns [] on any error or non-thread.
 */
async function fetchThreadTranscript(client, channel, thread_ts, { limit = 50, botUserId = null } = {}) {
  if (!thread_ts) return [];

  let messages = [];
  try {
    const res = await client.conversations.replies({ channel, ts: thread_ts, limit });
    messages = res.messages || [];
  } catch (err) {
    // Most commonly a missing history scope — surface it in logs, degrade gracefully.
    console.warn(`Could not read thread ${channel}::${thread_ts}: ${err.message}`);
    return [];
  }

  const transcript = [];
  for (const m of messages) {
    const text = cleanText(m.text);
    if (!text) continue;

    let author;
    let isBot = false;
    if (m.bot_id || m.subtype === 'bot_message') {
      isBot = true;
      author = m.username || m.bot_profile?.name || 'Bot';
    } else if (botUserId && m.user === botUserId) {
      author = 'Donna';
    } else {
      author = await resolveUserName(client, m.user);
    }

    transcript.push({ author, text, ts: m.ts, isBot });
  }

  return transcript;
}

/** Render a transcript array into a plain-text block for an LLM prompt. */
function formatTranscript(transcript = []) {
  return transcript.map(m => `${m.author}: ${m.text}`).join('\n');
}

module.exports = { fetchThreadTranscript, formatTranscript, resolveUserName };
