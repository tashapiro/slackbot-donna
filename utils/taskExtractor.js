// utils/taskExtractor.js — Dedicated LLM pass that reads a conversation transcript
// and pulls out candidate Asana tasks (action items). Kept separate from the intent
// router so it can use a stronger model and a focused prompt without bloating routing.

const OpenAI = require('openai');

const EXTRACTION_PROMPT = `You are Donna's task-extraction engine. You read a Slack
conversation transcript — which often includes meeting notes or action items posted by
a bot such as Fireflies ("Fred") — and pull out concrete ACTION ITEMS that should become
Asana tasks.

Rules:
- Only extract real, actionable items — things someone actually needs to DO. Ignore
  small talk, FYI/status statements, and background discussion.
- Favor the perspective of the person asking (treat them as "me"). If an item is clearly
  owned by someone else, still include it and note who in "assignee_hint".
- Write each "name" as a short imperative, e.g. "Send the revised proposal to Acme".
- Put supporting detail/context in "notes" (keep it brief).
- If a due date is stated or clearly implied, put it in "due" as a natural phrase
  ("Friday", "next week", "2026-07-20"). Otherwise use null.
- Never invent tasks. If there are no clear action items, return an empty array.

Output STRICT JSON only, no prose, no backticks:
{"tasks": [{"name": string, "notes": string, "due": string|null, "assignee_hint": string|null}]}`;

class TaskExtractor {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.llm = apiKey ? new OpenAI({ apiKey }) : null;
    // Extraction benefits from a stronger model than the router. Configurable.
    this.model = process.env.EXTRACT_MODEL || 'gpt-4o';
  }

  /**
   * @param {Object} p
   * @param {string} p.transcript  Formatted conversation text.
   * @param {string} [p.userRequest]  What the user actually asked Donna to do.
   * @returns {Promise<Array<{name,notes,due,assignee_hint}>>}
   */
  async extract({ transcript, userRequest = '' }) {
    if (!this.llm) throw new Error('OPENAI_API_KEY not configured');
    if (!transcript || !transcript.trim()) return [];

    const resp = await this.llm.chat.completions.create({
      model: this.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: JSON.stringify({ user_request: userRequest, transcript }) }
      ]
    });

    const raw = resp.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = { tasks: [] }; }

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return tasks
      .filter(t => t && typeof t.name === 'string' && t.name.trim())
      .map(t => ({
        name: t.name.trim(),
        notes: (t.notes || '').toString().trim(),
        due: t.due || null,
        assignee_hint: t.assignee_hint || null
      }));
  }
}

module.exports = new TaskExtractor();
