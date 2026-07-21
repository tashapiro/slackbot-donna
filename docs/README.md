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
| | "make a reusable 30-min booking link", "what's been booked?", "set up a poll with 3 times for the Acme kickoff" | agentic SavvyCal tools (see below) |
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

> **DMs read recent history too.** DMs aren't threaded, so a message has no `thread_ts` and
> the thread reader can't see anything. The agentic brain therefore falls back to
> `conversations.history` for the DM (`utils/threadReader.js` → `fetchRecentHistory`, needs
> `im:history`), so Donna follows the back-and-forth across turns in a DM instead of treating
> each message in isolation. Without this she'd answer a context-dependent follow-up like
> "I'm ok with the following week" with "I don't have the earlier part of this in front of me."

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

## Memory & client context

This is **Phase 2** (see [`roadmap.md`](./roadmap.md)). It gives the agentic brain
(`BRAIN=agentic`) two things it lacked: a persistent memory that survives Render restarts, and an
awareness of **which client** each message is about — with the clients kept strictly separate.

**Client registry (from your Google Sheet).** The source of truth for clients is your Google Sheet
(the "IndieVisual Hub"). Donna reads its **`Clients`** tab with the **same Google service account**
as Calendar — share the sheet with the service-account email (Viewer) and set
`CLIENT_REGISTRY_SHEET_ID`. Each client is keyed by the sheet's own stable `id` (`CLI-xxx`), so
renaming a client doesn't orphan its memory. Because there's no aliases column and names are formal
("Lockton Companies LLC"), Donna **auto-derives nicknames** by stripping corporate suffixes
("Lockton") — add an `aliases` column if you want explicit control. For detection she also collects
**email domains** from each client's `website`/`email` and from the **`Contacts`** tab (so a message
mentioning `@lockton.com` resolves to Lockton); free-mail domains are ignored. Column headers are
auto-detected and overridable via `CLIENT_REGISTRY_COL_*`; the registry is cached ~5 minutes.
(The `Projects` tab holds each project's `asana_project_id` — auto-filing tasks into a client's
Asana project is wired in a later phase.)

**Per-message client resolution.** Because a channel isn't one-client-per-channel (a shared
`call-notes` channel holds Fireflies notes across clients), Donna resolves the client **per
message**: she matches the message and its thread transcript against the registry (names / aliases /
email domains) and lands on one of —

- **confident** → she proceeds and prefixes her reply with `📁 <Client>` so any mistake is visible;
- **ambiguous** (more than one match) → she asks *which client?* before doing anything client-specific;
- **none** → treated as non-client work.

An explicit **"for <Client>, …"** always overrides.

**Scoped memory (Postgres).** Memory lives in Postgres (Render Postgres) behind
`services/memoryStore.js` — **the only module that touches the database**. Facts are stored in one
of three scopes:

- **personal** — about you (preferences, meals, workouts);
- **business** — true across all clients (rate card, email voice, bio);
- **client** — about one client only (deadlines, decisions, contacts).

Isolation is enforced **in storage, not the prompt**: every read applies
`WHERE scope = ? AND (scope <> 'client' OR client_key = ?)`, and the brain is only ever handed
`personal + business + the active client`. Donna literally cannot store to, or read from, another
client's namespace — the client key comes from the resolver, never from the model. Aggregating
across clients is allowed only when it's explicit and read-only ("my workload across all clients");
anything she drafts or sends outward stays single-client.

Donna uses two tools for this — `recall` (before answering) and `remember` (to save a durable
fact). Without `DATABASE_URL` or `CLIENT_REGISTRY_SHEET_ID` the features simply report "not
configured" and the rest of the bot is unchanged.

Relevant code: `services/googleSheets.js`, `services/clientRegistry.js`, `utils/clientResolver.js`,
`services/memoryStore.js`, plus the `remember`/`recall` tools in `utils/donnaTools.js` and the
resolution + memory wiring in `utils/donnaBrain.js`.

## Integrations

| Service | Wraps | Env vars |
|---------|-------|----------|
| Slack | Bolt app (socket or HTTP) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (socket) |
| OpenAI | Intent routing + task extraction | `OPENAI_API_KEY`, `ROUTER_MODEL`, `EXTRACT_MODEL` |
| Anthropic (Claude) | Agentic brain (`BRAIN=agentic`) | `ANTHROPIC_API_KEY`, `DONNA_MODEL` |
| Postgres | Persistent scoped memory (`memoryStore`) | `DATABASE_URL`, `DATABASE_SSL` |
| Google Sheets | Client registry (read-only) | `CLIENT_REGISTRY_SHEET_ID`, `CLIENT_REGISTRY_COL_*` (+ Google service account) |
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
| `DATABASE_URL` | Postgres connection (enables persistent memory) | — |
| `CLIENT_REGISTRY_SHEET_ID` | Google Sheet ID for the client registry | — |
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

### Scheduling with SavvyCal (agentic brain)

The agentic brain has full SavvyCal tooling in `utils/donnaTools.js` (the OpenAI router only
had create/list/disable/delete via the switch; the agentic brain previously had **none** — this
restores and extends it). All of it runs under `BRAIN=agentic` and needs `SAVVYCAL_TOKEN`.

- **Booking links** — `create_scheduling_link` (single-use by default; `reusable:true` for a
  standing link), `list_scheduling_links`, `get_scheduling_link`, `disable_scheduling_link`,
  `delete_scheduling_link`.
- **Booked events** — `list_booked_events` ("what's on the books / who booked time with me").
- **Meeting polls** — `create_scheduling_poll` (propose a few slots for a group to vote on;
  Donna can suggest slots from your calendar or use ones you name), `list_scheduling_polls`,
  `get_scheduling_poll` (shows live vote counts), `delete_scheduling_poll`.

**Confirmation model:** creating a booking link is **immediate** (cheap and reversible) — Donna
just shares the URL. Disabling/deleting a link, deleting a poll, and **sending a poll** all go
through a Confirm/Cancel card first (same preview-then-confirm pattern as tasks/events), wired in
`handlers/scheduling.js` + the `sc_action_*` / `sc_poll_*` button handlers in `app.js`.

> **Two pieces need a live check on Render** (SavvyCal's API isn't reachable from CI/dev
> sandboxes, so they were built defensively — graceful errors + raw-response logging — but not
> exercised end-to-end): **(a)** reusable-link creation (the exact create payload vs single-use),
> and **(b)** the `/v1/events` and `/v1/polls` endpoints (paths/response shapes). Offline logic is
> covered by `npm run check:savvycal`.

**Live verification (on Render, with `SAVVYCAL_TOKEN` set):** create a single-use link, create a
reusable link (confirm it books more than once), list/get/disable/delete a link, `list_booked_events`
returns real bookings, then create a poll with 3–4 slots + a couple of invitees → confirm it sends
and `get_scheduling_poll` reflects votes. If a call errors, the logged raw response shows the exact
path/shape to adjust.

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
  scheduling.js            SavvyCal links, polls, booked events (+ agentic confirm flows)
  timeTracking.js          Toggl intents
  projects.js              Asana intents + thread task extraction (+ shared preview/confirm)
  calendar.js              Google Calendar intents + daily rundown
  workout.js               Peloton intents
services/
  savvycal.js  toggl.js  asana.js  googleCalendar.js  peloton.js
  googleSheets.js          Read-only Google Sheets access (client registry source)
  clientRegistry.js        Clients from the Sheet: config-driven column mapping + cache
  memoryStore.js           Persistent scope-isolated memory (Postgres) — only DB module
utils/
  intentClassifier.js      OpenAI router brain: LLM intent + slot extraction
  donnaBrain.js            Agentic (Claude) brain: Tool Runner loop  [BRAIN=agentic]
  donnaPrompt.js           Donna's personality + operating rules (system prompt)
  donnaTools.js            Agentic tools wrapping the services (reads + propose_* + SavvyCal + remember/recall)
  clientResolver.js        Resolve the active client per message (confident/ambiguous/none)
  googleAuth.js            Shared Google service-account credential parsing
  taskExtractor.js         LLM action-item extraction (thread → tasks, router path)
  threadReader.js          Read + format a Slack thread transcript
  dataStore.js             In-memory per-thread state & caches
  errorHandler.js          Standardized error messages
  timezoneHelper.js        Per-user timezone handling
scripts/
  check-syntax.js          Minimal smoke test (npm test) — syntax-checks all .js
  check-phase2.js          Offline checks for the resolver + memory scope filters
docs/
  README.md                How Donna works today (this file)
  roadmap.md               Evolution plan + Phase to-dos
```
