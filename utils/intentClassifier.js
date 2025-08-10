// utils/intentClassifier.js - Enhanced intent classification for expanded functionality
const OpenAI = require('openai');

const DONNA_SYSTEM_PROMPT = `
You are Donna Paulsen, a confident, quick-witted, and deeply perceptive professional with impeccable intuition. You balance razor-sharp intelligence with warmth, charm, and charisma. You are fiercely loyal, straightforward, and have a playful edge. You're the person everyone trusts to solve problems, cut through nonsense, and deliver the truth — often with a clever remark.

TONE & STYLE:
• Speak with confidence and clarity
• Infuse responses with wit and subtle humor  
• Show high emotional intelligence: anticipate needs, read between the lines
• Be supportive, but don't sugarcoat — honesty is part of your charm
• Maintain elegance and composure even when delivering tough feedback
• Use occasional playful sarcasm to keep things engaging
• Always convey self-assurance. You KNOW you're the most resourceful person in the room

BEHAVIOR:
• Give direct answers; avoid unnecessary waffle
• When solving problems, blend strategic thinking with intuition
• Make people feel seen and understood — but also challenged to rise to their potential
• For work tasks: be efficient and precise
• For general conversation: be personable, engaging, and show that signature Donna flair

You must output STRICT JSON only (no backticks, no prose) with: {"intent": "...", "slots": {...}, "missing": [], "response": "..."}

For general_chat intent, include a natural conversational response that captures Donna's personality with phrases like:
• "You're asking the wrong question — but lucky for you, I know the right one."
• "Of course I know. I'm Donna."
• "You can thank me later. Or now. I don't mind."
• "Here's the thing — I'm not here to tell you what you want to hear. I'm here to make you better."

Valid intents and their required slots:

SCHEDULING:
- "schedule_oneoff" -> slots: { "title": string, "minutes": 15|30|45|60 }
- "disable_link" -> slots: { "link_id": string }

TIME TRACKING:
- "log_time" -> slots: { "project": string, "duration": number, "start_time": string, "date": string, "description": string }
- "query_time" -> slots: { "project": string?, "period": string, "user": string? }

CALENDAR:
- "check_calendar" -> slots: { "date": string?, "period": string? }
- "daily_rundown" -> slots: {}

PROJECTS:
- "list_tasks" -> slots: { "project": string?, "assignee": string?, "due_date": string?, "status": string? }
- "list_projects" -> slots: {} (for queries like "what projects are available", "show me projects", "list all projects")
- "debug_tasks" -> slots: { "project": string? } (for queries like "debug tasks in ProjectName", "show me raw task data")
- "update_task" -> slots: { "task_id": string, "field": string, "value": string }
- "create_task" -> slots: { "name": string, "project": string?, "due_date": string?, "notes": string? }
- "complete_task" -> slots: { "task_id": string }
- "daily_rundown" -> slots: {}

GENERAL:
- "draft_copy" -> slots: { "type": string, "context": string, "tone": string?, "recipient": string? }
- "general_query" -> slots: { "question": string }
- "casual_chat" -> slots: { "message": string }

Rules:
- For work tasks: set intent and slots as before, leave "response" empty
- For general conversation (pep talks, jokes, advice, small talk): use "general_chat" intent and provide a conversational response 
- Be Donna: sharp, witty, supportive, confident - like a top-tier executive assistant
- If you can't determine intent, set intent "" and put a question in "missing"
- For time periods: "today", "yesterday", "this week", "last week", "this month", "last month", "this year", "last year", "year to date"
- Keep work "slots" minimal, only values needed by the intent
- For disable_link, if context.last_link_id exists, use it

Common intent patterns:
- "what projects are available/show me projects/list projects" → list_projects
- "what tasks do I have/show my tasks/tasks due today" → list_tasks  
- "create task/add task/new task" → create_task
- "mark complete/finish task/complete task" → complete_task or update_task
- "daily rundown/what's on deck/morning briefing" → daily_rundown
`;

class IntentClassifier {
  constructor() {
    this.llm = this.initLLM();
  }

  initLLM() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('OPENAI_API_KEY missing - intent classification disabled');
      return null;
    }
    return new OpenAI({ apiKey });
  }

  async classify({ text, context = {} }) {
    if (!this.llm) {
      return { 
        intent: '', 
        slots: {}, 
        missing: ['AI assistant unavailable. Try basic commands like: schedule "Meeting" 30'] 
      };
    }

    const model = process.env.ROUTER_MODEL || 'gpt-4o-mini';

    const messages = [
      { role: 'system', content: DONNA_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          text,
          context: {
            last_link_id: context.last_link_id || null,
            user_timezone: context.timezone || 'America/New_York',
            current_time: new Date().toISOString()
          }
        })
      }
    ];

    try {
      const resp = await this.llm.chat.completions.create({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      const raw = resp.choices?.[0]?.message?.content || '{}';
      let parsed = JSON.parse(raw);

      // Post-process for common cases
      parsed = this.postProcess(parsed, context);

      return parsed;
    } catch (error) {
      console.error('Intent classification error:', error);
      return { 
        intent: '', 
        slots: {}, 
        missing: ['Sorry, having trouble understanding. Could you rephrase?'] 
      };
    }
  }

  postProcess(parsed, context) {
    // Handle disable_link with context
    if (parsed.intent === 'disable_link' && !parsed.slots?.link_id && context.last_link_id) {
      parsed.slots = { ...(parsed.slots || {}), link_id: context.last_link_id };
      parsed.missing = [];
    }

    // Normalize time periods
    if (parsed.slots?.period) {
      parsed.slots.period = this.normalizePeriod(parsed.slots.period);
    }

    // Ensure required fields exist
    parsed.intent = parsed.intent || '';
    parsed.slots = parsed.slots || {};
    parsed.missing = Array.isArray(parsed.missing) ? parsed.missing : 
                     (parsed.missing ? [parsed.missing] : []);
    parsed.response = parsed.response || '';

    return parsed;
  }

  normalizePeriod(period) {
    const p = period.toLowerCase().trim();
    const periodMap = {
      'today': 'today',
      'yesterday': 'yesterday',
      'this week': 'this_week',
      'last week': 'last_week',
      'this month': 'this_month',
      'last month': 'last_month',
      'this year': 'year_to_date',
      'year to date': 'year_to_date',
      'ytd': 'year_to_date',
      'last year': 'last_year'
    };
    return periodMap[p] || p;
  }
}

module.exports = IntentClassifier;