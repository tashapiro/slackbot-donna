// app.js — Donna (dual mode: Socket for dev, HTTP + /schedule for prod)
require('dotenv').config();

const { initLLM, routeWithLLM } = require('./brain');
const AGENT_MODE = String(process.env.AGENT_MODE).toLowerCase() === 'true';

// simple per-thread memory (swap for Redis/DB later)
const threadState = new Map();
function keyForThread(channel, thread_ts) { return `${channel}::${thread_ts || 'root'}`; }
function loadThread(channel, thread_ts) { return threadState.get(keyForThread(channel, thread_ts)) || {}; }
function saveThread(channel, thread_ts, data) {
  const k = keyForThread(channel, thread_ts);
  const curr = threadState.get(k) || {};
  threadState.set(k, { ...curr, ...data });
}


const { App, ExpressReceiver } = require('@slack/bolt');

// ─────────────────────────────────────────────────────────────────────────────
// Environment variables
// ─────────────────────────────────────────────────────────────────────────────
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;         // needed only in Socket Mode (xapp-...)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;         // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SAVVYCAL_SCOPE_SLUG = process.env.SAVVYCAL_SCOPE_SLUG; // e.g., indievisual
// Support either SAVVYCAL_TOKEN (preferred) or legacy SAVVYCAL_API_KEY
const SAVVYCAL_TOKEN = (process.env.SAVVYCAL_TOKEN || process.env.SAVVYCAL_API_KEY || '').trim();

const SOCKET_MODE = String(process.env.SOCKET_MODE).toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;

// Basic env checks
const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];
if (SOCKET_MODE) required.push('SLACK_APP_TOKEN');
if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || (SOCKET_MODE && !SLACK_APP_TOKEN)) {
  console.error('❌ Missing Slack env vars. Required:',
    required.join(', '), '\nCheck your .env or hosting env.');
  process.exit(1);
}
if (!SAVVYCAL_TOKEN) {
  console.error('❌ Missing SavvyCal token. Set SAVVYCAL_TOKEN (preferred) or SAVVYCAL_API_KEY.');
  process.exit(1);
}

console.log(`[env] Mode=${SOCKET_MODE ? 'Socket' : 'HTTP'} • SavvyCal scope=${SAVVYCAL_SCOPE_SLUG || '(none)'} • Port=${PORT}`);

// ─────────────────────────────────────────────────────────────────────────────
// SavvyCal helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildUrlFrom(link, scope) {
  const slug = link.slug || '';
  if (link.url) return link.url;
  if (slug.includes('/')) return `https://savvycal.com/${slug}`;
  return scope ? `https://savvycal.com/${scope}/${slug}` : `https://savvycal.com/${slug}`;
}

/**
 * Create a single-use link, then enforce duration via PATCH.
 * Returns: { id, url }
 */
async function createSingleUseLink(title, minutes) {
  const baseCreate = SAVVYCAL_SCOPE_SLUG
    ? `https://api.savvycal.com/v1/scopes/${SAVVYCAL_SCOPE_SLUG}/links`
    : `https://api.savvycal.com/v1/links`;

  // 1) Create the single-use link
  const createRes = await fetch(baseCreate, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SAVVYCAL_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: title, type: 'single', description: `${minutes} min` })
  });
  const createText = await createRes.text();
  if (!createRes.ok) throw new Error(`SavvyCal create failed ${createRes.status}: ${createText}`);
  const created = JSON.parse(createText);
  const link = created.link || created;
  const baseUrl = buildUrlFrom(link, SAVVYCAL_SCOPE_SLUG);

  // 2) Try to lock durations to [minutes]
  try {
    const patchRes = await fetch(`https://api.savvycal.com/v1/links/${link.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SAVVYCAL_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ durations: [minutes], default_duration: minutes })
    });

    if (!patchRes.ok) {
      const t = await patchRes.text();
      console.warn(`SavvyCal PATCH durations failed ${patchRes.status}: ${t}`);
      // Fallback: preselect duration via query param (doesn't lock, but preselects)
      return { id: link.id, url: `${baseUrl}?d=${minutes}` };
    }
    return { id: link.id, url: baseUrl };
  } catch (e) {
    console.warn('SavvyCal PATCH threw:', e);
    return { id: link.id, url: `${baseUrl}?d=${minutes}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bolt app (dual mode)
// ─────────────────────────────────────────────────────────────────────────────
let app;
if (SOCKET_MODE) {
  // Socket Mode (great for local dev; no public URL needed)
  app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: SLACK_APP_TOKEN
  });
} else {
  // HTTP Mode (for prod slash commands & webhooks)
  const receiver = new ExpressReceiver({
    signingSecret: SLACK_SIGNING_SECRET
  });
  // Simple health check
  receiver.router.get('/', (_, res) => res.send('OK'));
  app = new App({
    token: SLACK_BOT_TOKEN,
    receiver
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Dev UX: @mention handler (works in Socket Mode; optional in HTTP if subscribed)
// Usage: @Donna schedule "Title" 30
// ─────────────────────────────────────────────────────────────────────────────
app.event('app_mention', async ({ event, client, logger }) => {
    const raw = event.text || '';
    const text = raw.replace(/<@[^>]+>\s*/g, '').trim();
    logger.info(`mention: "${text}" in ${event.channel}`);
  
    // Fast path: keep your strict syntax working for speed/consistency
    const strict = text.match(/^schedule\s+"([^"]+)"\s+(\d{1,3})$/i);
    if (strict) {
      const [, title, minutesStr] = strict;
      const minutes = parseInt(minutesStr, 10);
      await client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts, text: "On it."
      });
      try {
        const { url, id } = await createSingleUseLink(title, minutes);
        saveThread(event.channel, event.ts, { last_link_id: id });
        return client.chat.postMessage({
          channel: event.channel, thread_ts: event.ts,
          text: `Done. ${url}`
        });
      } catch (e) {
        logger.error(e);
        return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Couldn’t create it. Try again?" });
      }
    }
  
    // Agentic path (only if enabled)
    if (!AGENT_MODE) {
      return client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: "Try: `schedule \"Meeting name\" 30`"
      });
    }
  
    const llm = initLLM();
    const context = loadThread(event.channel, event.ts);
    const routed = await routeWithLLM({ llm, text, context });
  
    if (!routed.intent && routed.missing.length) {
      return client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: routed.missing[0]
      });
    }
  
    if (routed.intent === 'schedule_oneoff') {
      const { title, minutes } = routed.slots || {};
      if (!title || !minutes) {
        return client.chat.postMessage({
          channel: event.channel, thread_ts: event.ts,
          text: 'I need a title and duration. Example: schedule "Intro with ACME" 30'
        });
      }
      await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "On it." });
      try {
        const { url, id } = await createSingleUseLink(title, minutes);
        saveThread(event.channel, event.ts, { last_link_id: id });
        return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Done. ${url}` });
      } catch (e) {
        logger.error(e);
        return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Couldn’t create it. Want me to try 30 minutes?" });
      }
    }
  
    if (routed.intent === 'disable_link') {
      const { link_id } = routed.slots || {};
      if (!link_id) {
        return client.chat.postMessage({
          channel: event.channel, thread_ts: event.ts,
          text: "Which link should I disable? (If it’s the last one here, say “last link”.)"
        });
      }
      try {
        // your existing toggle endpoint if/when you wire it:
        // await scToggle(link_id);
        return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Disabled. Want me to create a new one?" });
      } catch (e) {
        logger.error(e);
        return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "Couldn’t disable it. Share the link ID?" });
      }
    }
  
    // Fallback
    return client.chat.postMessage({
      channel: event.channel, thread_ts: event.ts,
      text: "I can schedule, disable a link, or draft a proposal. What do you need?"
    });
  });
  

// ─────────────────────────────────────────────────────────────────────────────
// Prod UX: Slash command /schedule (HTTP mode recommended)
// Usage: /schedule "Title" 30
// ─────────────────────────────────────────────────────────────────────────────
app.command('/schedule', async ({ command, ack, respond }) => {
  await ack();

  const m = command.text.match(/^"([^"]+)"\s+(\d{1,3})$/);
  if (!m) return respond('Usage: `/schedule "Meeting name" 30`');

  const [, title, minutesStr] = m;
  const minutes = parseInt(minutesStr, 10);

  try {
    const { url } = await createSingleUseLink(title, minutes);
    await respond({
      text: url,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}* (${minutes} min)\n${url}` } }
      ]
    });
  } catch (e) {
    await respond(`Couldn’t create the link: ${e.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await app.start(PORT);
  console.log(`⚡ Donna running in ${SOCKET_MODE ? 'Socket' : 'HTTP'} mode on :${PORT}`);
})();
