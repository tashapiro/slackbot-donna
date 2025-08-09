// app.js — Donna (dual mode + agentic brain + SavvyCal)
// Node 18+ (uses global fetch)

require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const OpenAI = require('openai');

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────
const SOCKET_MODE = String(process.env.SOCKET_MODE).toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;           // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;           // xapp-... (Socket Mode only)

const SAVVYCAL_TOKEN = (process.env.SAVVYCAL_TOKEN || '').trim();
const SAVVYCAL_SCOPE_SLUG = process.env.SAVVYCAL_SCOPE_SLUG;   // e.g., indievisual

const AGENT_MODE = String(process.env.AGENT_MODE).toLowerCase() === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ROUTER_MODEL = process.env.ROUTER_MODEL || 'gpt-4o-mini';

// basic checks
const must = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SAVVYCAL_TOKEN'];
if (SOCKET_MODE) must.push('SLACK_APP_TOKEN');
const missing = must.filter(k => !process.env[k] || !String(process.env[k]).trim());
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}
console.log(`[env] Mode=${SOCKET_MODE ? 'Socket' : 'HTTP'} • Scope=${SAVVYCAL_SCOPE_SLUG || '(none)'} • Agent=${AGENT_MODE ? 'on' : 'off'} • Port=${PORT}`);

// ─────────────────────────────────────────────────────────────────────────────
/** SavvyCal helpers */
// ─────────────────────────────────────────────────────────────────────────────
function buildUrlFrom(link, scope) {
  const slug = link.slug || '';
  if (link.url) return link.url;
  if (slug.includes('/')) return `https://savvycal.com/${slug}`;
  return scope ? `https://savvycal.com/${scope}/${slug}` : `https://savvycal.com/${slug}`;
}

/** create single-use link, then PATCH durations to [minutes] (no ?d= fallback) */
async function createSingleUseLink(title, minutes) {
  const baseCreate = SAVVYCAL_SCOPE_SLUG
    ? `https://api.savvycal.com/v1/scopes/${SAVVYCAL_SCOPE_SLUG}/links`
    : `https://api.savvycal.com/v1/links`;

  // create
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
  const url = buildUrlFrom(link, SAVVYCAL_SCOPE_SLUG);

  // lock duration
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
    throw new Error(`SavvyCal PATCH durations failed ${patchRes.status}: ${t}`);
  }
  return { id: link.id, url };
}

async function toggleLink(linkId) {
  const t = await fetch(`https://api.savvycal.com/v1/links/${linkId}/toggle`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SAVVYCAL_TOKEN}` }
  });
  if (!t.ok) throw new Error(`SavvyCal toggle failed ${t.status}: ${await t.text()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
/** Agentic “brain” (intent + slots) */
// ─────────────────────────────────────────────────────────────────────────────
const DONNA_SYSTEM_PROMPT = `
You are Donna, a sharp, confident operations chief-of-staff in Slack (inspired by Donna Paulsen from *Suits*).
Style: concise, warm, subtly witty. Ask at most ONE focused question if needed. Confirm before risky actions.
Output STRICT JSON only (no backticks, no prose): {"intent": "...", "slots": {...}, "missing": []}
Valid intents:
- "schedule_oneoff"  -> slots: { "title": string, "minutes": 15|30|45|60 }
- "disable_link"     -> slots: { "link_id": string }
Rules:
- If intent unclear, set intent "" and put ONE short question in "missing".
- Keep "slots" minimal—only required fields.
`;

function initLLM() {
  if (!AGENT_MODE) return null;
  if (!OPENAI_API_KEY) {
    console.warn('Agent mode requested but OPENAI_API_KEY is missing; agent disabled.');
    return null;
  }
  return new OpenAI({ apiKey: OPENAI_API_KEY });
}

async function routeWithLLM({ llm, text, context = {} }) {
  if (!llm) return { intent: '', slots: {}, missing: ['What do you need? e.g., schedule "Intro with ACME" 30'] };
  const messages = [
    { role: 'system', content: DONNA_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ text, context }) }
  ];
  const resp = await llm.chat.completions.create({
    model: ROUTER_MODEL,
    messages,
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });
  const raw = resp.choices?.[0]?.message?.content || '{}';
  try { return JSON.parse(raw); }
  catch { return { intent: '', slots: {}, missing: ['Say that again—schedule, disable, or something else?'] }; }
}

const llm = initLLM();

// ─────────────────────────────────────────────────────────────────────────────
/** Tiny per-thread memory (swap for Redis/DB later) */
// ─────────────────────────────────────────────────────────────────────────────
const threadState = new Map();
const keyForThread = (channel, ts) => `${channel}::${ts || 'root'}`;
const loadThread = (channel, ts) => threadState.get(keyForThread(channel, ts)) || {};
const saveThread = (channel, ts, data) => {
  const k = keyForThread(channel, ts);
  const curr = threadState.get(k) || {};
  threadState.set(k, { ...curr, ...data });
};

// ─────────────────────────────────────────────────────────────────────────────
/** Bolt app: dual mode init */
// ─────────────────────────────────────────────────────────────────────────────
let app;
if (SOCKET_MODE) {
  app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: SLACK_APP_TOKEN
  });
} else {
  const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
  // request logger + health
  receiver.router.use((req, _res, next) => { console.log(`[http] ${req.method} ${req.url}`); next(); });
  receiver.router.get('/', (_req, res) => res.send('OK'));
  app = new App({ token: SLACK_BOT_TOKEN, receiver });
}

// ─────────────────────────────────────────────────────────────────────────────
/** PROD: Slash command /schedule — Usage: /schedule "Title" 30 */
// ─────────────────────────────────────────────────────────────────────────────
app.command('/schedule', async ({ command, ack, respond }) => {
  await ack();

  const m = command.text.match(/^"([^"]+)"\s+(\d{1,3})$/);
  if (!m) return respond('Usage: `/schedule "Meeting name" 30`');

  const [, title, minutesStr] = m;
  const minutes = parseInt(minutesStr, 10);

  try {
    const { url, id } = await createSingleUseLink(title, minutes);
    // store last link in this DM/thread context if needed later
    saveThread(command.channel_id, command.thread_ts || command.trigger_id, { last_link_id: id });

    await respond({
      text: url,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*All set.*\n*${title}* (${minutes} min)\n${url}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Disable link' }, value: id, action_id: 'sc_disable' }
          ]
        }
      ]
    });
  } catch (e) {
    await respond(`Couldn’t create it: ${e.message}`);
  }
});

// action to disable link (works for both slash/mention flows)
app.action('sc_disable', async ({ ack, body, client }) => {
  await ack();
  const linkId = body.actions?.[0]?.value;
  try {
    await toggleLink(linkId);
    await client.chat.postMessage({
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      text: '✅ Disabled.'
    });
  } catch (e) {
    await client.chat.postMessage({
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      text: `Couldn’t disable: ${e.message}`
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
/** DEV (and optional in prod): @mention handler — agentic with fast-path */
// Usage: @Donna schedule "Title" 30
// ─────────────────────────────────────────────────────────────────────────────
app.event('app_mention', async ({ event, client, logger }) => {
  const raw = event.text || '';
  const text = raw.replace(/<@[^>]+>\s*/g, '').trim();
  logger.info(`mention: "${text}" in ${event.channel}`);

  // Fast path (keeps your deterministic behavior)
  const strict = text.match(/^schedule\s+"([^"]+)"\s+(\d{1,3})$/i);
  if (strict) {
    const [, title, minutesStr] = strict;
    const minutes = parseInt(minutesStr, 10);

    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: 'On it.' });
    try {
      const { url, id } = await createSingleUseLink(title, minutes);
      saveThread(event.channel, event.ts, { last_link_id: id });
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Done. ${url}` });
    } catch (e) {
      logger.error(e);
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Couldn’t create it: ${e.message}` });
    }
  }

  // Agentic path
  if (!AGENT_MODE || !llm) {
    return client.chat.postMessage({
      channel: event.channel, thread_ts: event.ts,
      text: 'Try: `schedule "Meeting name" 30`'
    });
  }

  const context = loadThread(event.channel, event.ts);
  const routed = await routeWithLLM({ llm, text, context });

  if (!routed.intent && routed.missing?.length) {
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
    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: 'On it.' });
    try {
      const { url, id } = await createSingleUseLink(title, minutes);
      saveThread(event.channel, event.ts, { last_link_id: id });
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Done. ${url}` });
    } catch (e) {
      logger.error(e);
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Couldn’t create it: ${e.message}` });
    }
  }

  if (routed.intent === 'disable_link') {
    const link_id = routed.slots?.link_id || context.last_link_id;
    if (!link_id) {
      return client.chat.postMessage({
        channel: event.channel, thread_ts: event.ts,
        text: 'Which link should I disable? (Say “last link” if it’s the one we just made.)'
      });
    }
    try {
      await toggleLink(link_id);
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: '✅ Disabled.' });
    } catch (e) {
      logger.error(e);
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Couldn’t disable it: ${e.message}` });
    }
  }

  // Fallback
  return client.chat.postMessage({
    channel: event.channel, thread_ts: event.ts,
    text: 'I can schedule or disable a link. What do you need?'
  });
});

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await app.start(PORT);
  console.log(`⚡ Donna running in ${SOCKET_MODE ? 'Socket' : 'HTTP'} mode on :${PORT}`);
})();
