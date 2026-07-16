# Donna — how she works

Donna is a Slack bot (a "chief-of-staff" assistant, styled after Donna Paulsen from
*Suits*) that turns natural-language Slack messages into actions across your tools:
scheduling links, time tracking, task management, calendar, and workouts. She now also
**reads the thread she's mentioned in** so she can answer questions about the
conversation and turn its action items into Asana tasks.

She's the assistant for a **one-person consulting business (IndieVisual)**, spanning work
(calendar, meeting prep, project to-dos, email/contract drafting) and personal life (meals,
restaurants, workouts). Because the business serves **multiple clients**, keeping their context
strictly separate is a core requirement — see [`roadmap.md`](./roadmap.md) → Phase 2 for the
memory & client-isolation design.

- [Architecture](#architecture)
- [What Donna can do](#what-donna-can-do)
- [Thread context & task extraction](#thread-context--task-extraction)
- [Integrations](#integrations)
- [Setup & configuration](#setup--configuration)
- [Deployment](#deployment)
- [Project layout](#project-layout)

> **Where Donna is headed:** see [`roadmap.md`](./roadmap.md) for the evolution plan —
> moving her brain to Claude with an agentic tool-use loop, adding memory and proactivity,
> and expanding across business functions. Phases 0 and 1 have to-do checklists there.

---

## Architecture

Donna is a [Slack Bolt](https://slack.dev/bolt-js) app. The flow for any message is:

```
Slack event (app_mention / message)
        │
        ▼
processDonnaMessage()            ← app.js
        │   ├─ fast paths (exact commands, greetings)
        │   ├─ read the thread transcript  ← utils/threadReader.js
        │   ▼
IntentClassifier.classify()      ← utils/intentClassifier.js  (LLM → {intent, slots, response})
        │
        ▼
handleIntent(intent, slots, …)   ← app.js  (switch → the right handler)
        │
        ▼
handlers/*.js  →  services/*.js  →  external API
```

- **Intent classification** is done by an LLM (OpenAI, `gpt-4o-mini` by default). It
  reads the message *plus context* (recent actions, timezone, and now the thread
  transcript) and returns a single `intent`, its `slots`, and an optional `response`.
- **Handlers** own the logic for a domain (scheduling, projects, calendar, …) and call
  the matching **service**, which wraps one external API.
- **State** lives in `utils/dataStore.js` — an in-memory, per-thread store
  (`channel::thread_ts → {…}`). It holds recent actions, cached API data, and pending
  confirmations. It resets on restart (nothing is persisted yet).

> Note: `brain.js` is an earlier, simpler router that has been superseded by
> `utils/intentClassifier.js`. It is kept for reference but not used by `app.js`.

## What Donna can do

| Area | Example message | Intent |
|------|-----------------|--------|
| Scheduling (SavvyCal) | `schedule "Intro with Acme" 30` | `schedule_oneoff` |
| | "list my links", "disable that link" | `list_links`, `disable_link` |
| Time tracking (Toggl) | "log 2 hours to Client X yesterday" | `log_time` |
| | "how much time did I track this week?" | `query_time` |
| Tasks (Asana) | "what are my tasks this week?" | `list_tasks` |
| | "create a task Review proposal for Acme" | `create_task` |
| | **"add these action items to Asana"** | **`extract_tasks`** |
| Calendar (Google) | "what's on my calendar tomorrow?" | `check_calendar` |
| | "block 2–4pm Friday for deep work" | `block_time` |
| | "meeting with John at 2pm tomorrow" | `create_meeting` |
| | "give me the daily rundown" | `daily_rundown` |
| Workouts (Peloton) | "recommend a 30min yoga class" | `workout_recommendation` |
| Conversation | "draft an email to Maura about the project" | `general_chat` |

Donna responds **in a thread** when mentioned in a channel, and stays "active" in that
thread for 24 hours so you can keep talking to her without re-mentioning. In DMs she
replies directly.

## Thread context & task extraction

This is the newest capability. When you `@Donna` **inside a thread**, she first reads the
whole thread (via Slack's `conversations.replies`) — including messages posted by bots
like **Fireflies / "Fred"** — and builds a transcript. That transcript is fed to the LLM,
so Donna understands what was said *before* you tagged her.

Two things this unlocks:

**1. Answer questions about the conversation.** e.g. after a Fred call recap:
> "@Donna what did we agree on for the launch date?"

**2. Turn action items into Asana tasks.** e.g.:
> "@Donna add these action items to my Asana under Client Acme"

The task flow is **preview-then-confirm** (Donna never writes to Asana silently):

```
@Donna add these to Asana [under <Project>]
        │
        ▼
Reads thread → extracts action items   ← utils/taskExtractor.js (dedicated LLM pass)
        │
        ├─ project named?  → resolve it
        └─ not named?      → Donna asks "which project?" and waits for your reply
        │
        ▼
Posts a preview: numbered task list + [Create all] [Cancel] buttons
        │
        ▼
You click "Create all"  → tasks created in Asana, Donna reports what landed
```

Design choices (confirmed with the product owner):
- **Source:** Donna reads the Slack thread — whatever's there — so this works for any
  thread, not just Fireflies. She does not call the Fireflies API directly.
- **Confirmation:** always preview first; tasks are only created on the button click.
- **Project routing:** if you name a project she uses it; otherwise she asks. There is no
  silent default project.
- **Assignee:** extracted tasks are assigned to you (the Asana token owner). If an item
  clearly belongs to someone else, Donna notes that in the task, but still assigns to you.

Relevant code:
- `utils/threadReader.js` — fetch + format the thread transcript.
- `utils/taskExtractor.js` — the extraction LLM pass (`{name, notes, due, assignee_hint}`).
- `handlers/projects.js` — `handleExtractTasks`, `handleTaskProjectResponse`,
  `confirmPendingTasks`, and the preview blocks.
- `app.js` — transcript read on each message, the "waiting for a project" follow-up
  interception, and the `donna_create_tasks` / `donna_cancel_tasks` button handlers.

**Limitation:** thread reading needs a thread. In a plain DM with no threads, Donna has
no `thread_ts` to read from, so extraction there will report it has nothing to read.

## Integrations

| Service | Wraps | Env vars |
|---------|-------|----------|
| Slack | Bolt app (socket or HTTP) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (socket) |
| OpenAI | Intent routing + task extraction | `OPENAI_API_KEY`, `ROUTER_MODEL`, `EXTRACT_MODEL` |
| Anthropic (Claude) | Agentic brain (`BRAIN=agentic`) | `ANTHROPIC_API_KEY`, `DONNA_MODEL` |
| SavvyCal | Scheduling links | `SAVVYCAL_TOKEN` |
| Toggl | Time tracking | (see `services/toggl.js`) |
| Asana | Tasks & projects | `ASANA_API_TOKEN`, `ASANA_WORKSPACE_ID` |
| Google Calendar | Calendar | (see `services/googleCalendar.js`) |
| Peloton | Workouts | (see `services/peloton.js`) |

### Required Slack scopes

For Donna to read threads she needs message-history scopes on the Slack app, in addition
to her usual `app_mentions:read`, `chat:write`, `users:read`, `commands`:

- `channels:history` — public channels
- `groups:history` — private channels
- `im:history` — DMs
- `mpim:history` — group DMs

Add these under **OAuth & Permissions** in your Slack app config, then reinstall the app
to the workspace so the new scopes take effect.

## Setup & configuration

```bash
npm install
cp .env.example .env   # then fill in your values
npm run dev            # starts app.js
```

**`.env.example` (repo root) is the authoritative list of every environment variable** — grouped
by integration, marked `[required]` vs `[feature]`, with the Google/Peloton auth alternatives.
Use it as the checklist for what to set in the Render dashboard. The most important ones:

| Var | Purpose | Default |
|-----|---------|---------|
| `SOCKET_MODE` | `true` for Socket Mode, else HTTP | — |
| `PORT` | HTTP port | `3000` |
| `AGENT_MODE` | `true` to enable LLM intent routing | — |
| `BRAIN` | `agentic` → use the Claude Tool Runner brain; anything else → the OpenAI router | — |
| `OPENAI_API_KEY` | OpenAI auth (router + task extraction) | — |
| `ROUTER_MODEL` | Model for intent classification | `gpt-4o-mini` |
| `EXTRACT_MODEL` | Model for action-item extraction | `gpt-4o` |
| `ANTHROPIC_API_KEY` | Anthropic auth (agentic brain) | — |
| `DONNA_MODEL` | Model for the agentic brain | `claude-sonnet-5` |
| `ASANA_API_TOKEN` / `ASANA_WORKSPACE_ID` | Asana auth / workspace | — |
| `SAVVYCAL_TOKEN` | SavvyCal auth | — |

### The two brains

Donna has two interchangeable brains for open-ended messages, selected by `BRAIN`:

- **OpenAI intent router** (default) — `utils/intentClassifier.js` classifies each message into
  one intent and `app.js` dispatches via a switch. Rigid, one action per message.
- **Agentic (Claude)** — set `BRAIN=agentic` (needs `ANTHROPIC_API_KEY`). `utils/donnaBrain.js`
  runs a [Tool Runner](https://docs.claude.com) loop on Claude (default Sonnet 5): a personality
  system prompt (`utils/donnaPrompt.js`) plus tools that wrap the existing services
  (`utils/donnaTools.js`). It converses naturally, chains multiple tools in one turn, and keeps
  the preview-then-confirm flow for writes. This is the **Phase 1 spike** — see
  [`roadmap.md`](./roadmap.md). It runs alongside the router (past the exact-command fast paths)
  so you can A/B them; flip back by unsetting `BRAIN`.

> `AGENT_MODE` must be `true` (and `OPENAI_API_KEY` set) for anything beyond the exact
> `schedule "…" 30` command and simple greetings. Without it, Donna falls back to basics.

## Deployment

Donna is hosted on **[Render](https://render.com)** as a long-running Node service (started
with `npm start` → `node app.js`). Practical notes:

- **Environment variables live in the Render dashboard**, not in a committed `.env` — use
  [`.env.example`](../.env.example) as the checklist of what to set there. Any new config must
  be added on Render to take effect in production. In particular, to turn on the agentic Claude
  brain you must set `ANTHROPIC_API_KEY`, `BRAIN=agentic`, and (optionally) `DONNA_MODEL`.
- **Run mode must match the Render service type.** `app.js` supports Slack **Socket Mode**
  (`SOCKET_MODE=true`, an outbound WebSocket — fits a Render **Background Worker**, no public
  port needed) or **HTTP mode** (an Express receiver bound to `PORT`, which Render provides —
  fits a Render **Web Service** with the Slack request URL pointed at it).
- **State is in-memory** (`utils/dataStore.js`), so every Render deploy or restart wipes thread
  state and caches. This is the main reason **memory (Phase 2 in the roadmap)** matters —
  persisting it will need a Render Disk or an external store, not the container filesystem
  (which is also reset on deploy).
- **Proactivity (Phase 4)** — Render **Cron Jobs** are a natural fit for scheduled work (the
  morning brief, follow-up nudges), or an in-process scheduler (e.g. `node-cron`) inside the
  worker.

## Project layout

```
app.js                     Slack wiring, message routing, brain selection, buttons
handlers/
  scheduling.js            SavvyCal link intents
  timeTracking.js          Toggl intents
  projects.js              Asana intents + thread task extraction (+ shared preview/confirm)
  calendar.js              Google Calendar intents + daily rundown
  workout.js               Peloton intents
services/
  savvycal.js  toggl.js  asana.js  googleCalendar.js  peloton.js
utils/
  intentClassifier.js      OpenAI router brain: LLM intent + slot extraction
  donnaBrain.js            Agentic (Claude) brain: Tool Runner loop  [BRAIN=agentic]
  donnaPrompt.js           Donna's personality + operating rules (system prompt)
  donnaTools.js            Agentic tools wrapping the services (read + propose_tasks)
  taskExtractor.js         LLM action-item extraction (thread → tasks, router path)
  threadReader.js          Read + format a Slack thread transcript
  dataStore.js             In-memory per-thread state & caches
  errorHandler.js          Standardized error messages
  timezoneHelper.js        Per-user timezone handling
scripts/
  check-syntax.js          Minimal smoke test (npm test) — syntax-checks all .js
docs/
  README.md                How Donna works today (this file)
  roadmap.md               Evolution plan + Phase to-dos
```
