// utils/donnaBrain.js — Donna's agentic brain (Phase 1 spike).
//
// Replaces the single-intent router with a Claude Tool Runner loop: one capable
// model + a personality system prompt + tools that wrap the existing services.
// The runner drives request → run tool → loop until Claude has a final answer.
//
// Gated behind BRAIN=agentic in app.js so it runs alongside the existing OpenAI
// router for A/B testing. Requires ANTHROPIC_API_KEY. See docs/roadmap.md (Phase 1).

const { buildSystem } = require('./donnaPrompt');
const { buildTools } = require('./donnaTools');
const { fetchThreadTranscript, formatTranscript } = require('./threadReader');
const { resolveClient } = require('./clientResolver');
const clientRegistry = require('../services/clientRegistry');
const memoryStore = require('../services/memoryStore');
const TimezoneHelper = require('./timezoneHelper');
const dataStore = require('./dataStore');

// Load the SDK defensively so a missing/partial install can't crash the whole bot —
// isEnabled() just returns false and app.js falls back to the router.
let AnthropicCtor = null;
let betaTool = null;
try {
  const Pkg = require('@anthropic-ai/sdk');
  AnthropicCtor = Pkg.default || Pkg;
  ({ betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema'));
} catch (err) {
  console.warn('⚠️ @anthropic-ai/sdk not available; agentic brain disabled:', err.message);
}

const MODEL = process.env.DONNA_MODEL || 'claude-sonnet-5';

let _client = null;
function getClient() {
  if (!AnthropicCtor || !betaTool) return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new AnthropicCtor({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** True when the agentic brain can actually run (SDK present + API key set). */
function isEnabled() {
  return !!getClient();
}

/** Collect the text from a (beta) message's content blocks. */
function extractText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
}

/**
 * Handle one inbound Slack message with the agentic brain.
 * @param {Object} p
 * @param {string} p.text            The user's message (mention stripped).
 * @param {object} p.client          Slack web client.
 * @param {string} p.channel
 * @param {string} [p.thread_ts]
 * @param {string} p.userId
 * @param {string} [p.botUserId]     Donna's own Slack user id (to label her lines).
 * @param {object} [p.logger]
 */
async function handleMessage({ text, client, channel, thread_ts, userId, botUserId, logger }) {
  const anthropic = getClient();
  if (!anthropic) {
    return client.chat.postMessage({
      channel,
      thread_ts,
      text: "My Claude brain isn't configured yet — set ANTHROPIC_API_KEY and try again."
    });
  }

  // Read the thread so Donna understands what was said before she was tagged.
  let transcript = [];
  if (thread_ts) {
    transcript = await fetchThreadTranscript(client, channel, thread_ts, { botUserId });
    if (transcript.length) {
      dataStore.setThreadData(channel, thread_ts, {
        recent_messages: transcript.map(m => ({ author: m.author, text: m.text }))
      });
    }
  }

  const timezone = await TimezoneHelper.getUserTimezone(client, userId);
  const system = buildSystem({ now: new Date(), timezone });

  // Resolve the active client for this message (content-matched against the registry).
  // Failures degrade to "no client" — never block the reply.
  let resolution = { status: 'none', client: null, candidates: [] };
  try {
    const clients = await clientRegistry.getActiveClients();
    resolution = resolveClient({ text, transcript, clients });
  } catch (err) {
    (logger && logger.warn ? logger.warn : console.warn)('Client resolution failed:', err.message);
  }
  const activeClient = resolution.status === 'confident' ? resolution.client : null;

  // Preload the memory Donna is allowed to see now (personal + business + active client only).
  let memoryLines = [];
  if (memoryStore.isEnabled()) {
    try {
      await memoryStore.init();
      const rows = await memoryStore.recallVisible({ client_key: activeClient ? activeClient.key : null });
      memoryLines = rows.map(r => {
        const scopeLabel = r.scope === 'client' && activeClient ? `client:${activeClient.name}` : r.scope;
        return `• [${scopeLabel}${r.kind ? `/${r.kind}` : ''}] ${r.content}`;
      });
    } catch (err) {
      (logger && logger.warn ? logger.warn : console.warn)('Memory preload failed:', err.message);
    }
  }

  let userContent = '';
  if (transcript.length) {
    userContent += `Conversation in this Slack thread so far:\n${formatTranscript(transcript)}\n\n`;
  }
  if (resolution.status === 'confident' && activeClient) {
    userContent += `Active client for this message: ${activeClient.name} (📁). If that's wrong, the user will say so.\n\n`;
  } else if (resolution.status === 'ambiguous') {
    const names = resolution.candidates.map(c => c.name).join(' or ');
    userContent += `The client is ambiguous — it could be ${names}. Ask which one before doing anything client-specific.\n\n`;
  }
  if (memoryLines.length) {
    userContent += `What you already remember that's relevant now:\n${memoryLines.join('\n')}\n\n`;
  }
  userContent += `The most recent message, which you are replying to, is:\n"${text}"`;

  const tools = buildTools({
    client, channel, thread_ts, userId,
    activeClient,
    clientStatus: resolution.status
  }).map(betaTool);

  try {
    const finalMessage = await anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      output_config: { effort: 'medium' },
      system,
      tools,
      messages: [{ role: 'user', content: userContent }]
    });

    const reply = extractText(finalMessage);
    if (reply) {
      // Surface the resolved client so any mis-resolution is visible to the user.
      const prefix = activeClient ? `📁 *${activeClient.name}*\n` : '';
      await client.chat.postMessage({ channel, thread_ts, text: prefix + reply });
    }
  } catch (err) {
    (logger && logger.error ? logger.error : console.error)('Agentic brain error:', err);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: 'I hit a snag working through that. Mind rephrasing, or trying again in a moment?'
    });
  }
}

module.exports = { isEnabled, handleMessage, MODEL };
