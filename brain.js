// brain.js — Donna’s “agent” layer (intent + slots + one follow-up)
const OpenAI = require('openai');

const DONNA_SYSTEM_PROMPT = `
You are Donna, a sharp, confident operations chief-of-staff in Slack (inspired by Donna Paulsen from *Suits*).
Style: concise, warm, subtly witty. Ask at most ONE focused question if needed. Confirm before risky actions.
You must output STRICT JSON only (no backticks, no prose) with: {"intent": "...", "slots": {...}, "missing": []}
Valid intents:
- "schedule_oneoff"  -> slots: { "title": string, "minutes": 15|30|45|60 }
- "disable_link"     -> slots: { "link_id": string } (if not provided but context.last_link_id exists, omit from "missing")

Rules:
- If you can't determine an intent, set intent to "" and put a single clear question in "missing".
- If info is missing, put the missing field names or a single question in "missing".
- Keep "slots" minimal, only the values needed by the chosen intent.
`;

function initLLM() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  return new OpenAI({ apiKey });
}

/** Ask the router model to classify and extract slots. */
async function routeWithLLM({ llm, text, context = {} }) {
  const model = process.env.ROUTER_MODEL || 'gpt-4o-mini';

  const messages = [
    { role: 'system', content: DONNA_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        text,
        context: {
          last_link_id: context.last_link_id || null
        }
      })
    }
  ];

  const resp = await llm.chat.completions.create({
    model,
    messages,
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { intent: '', slots: {}, missing: ['What do you need? e.g., schedule "Intro with ACME" 30'] }; }

  // If they want disable_link and we have context, backfill missing link_id.
  if (parsed.intent === 'disable_link' && !parsed.slots?.link_id && context.last_link_id) {
    parsed.slots = { ...(parsed.slots || {}), link_id: context.last_link_id };
    parsed.missing = [];
  }

  // Normalize shapes
  parsed.intent = parsed.intent || '';
  parsed.slots = parsed.slots || {};
  parsed.missing = Array.isArray(parsed.missing) ? parsed.missing : (parsed.missing ? [parsed.missing] : []);

  return parsed;
}

module.exports = {
  initLLM,
  routeWithLLM
};
