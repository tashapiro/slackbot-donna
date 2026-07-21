# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

**Donna** — a Slack bot that acts as the all-in-one executive assistant for a **one-person
consulting business (IndieVisual)**, styled after Donna Paulsen from *Suits*. She turns
natural-language Slack messages into actions across calendar, project to-dos, scheduling, time
tracking, and workouts; reads a thread's context to answer questions or create Asana tasks; and
is headed toward meeting prep, email/contract drafting, and personal-life help (meals, recipes,
restaurants).

**Client-context isolation is a hard requirement.** The business serves multiple clients, and
Donna must never mix one client's context into another's — a confidentiality concern, not just
a UX one. This is being designed into the memory layer (see `docs/roadmap.md` → Phase 2:
scoped memory, per-message client resolution, storage-enforced isolation). Keep it in mind for
any feature that reads or writes client data.

Runtime: Node.js + [Slack Bolt](https://slack.dev/bolt-js). Entry point is `app.js`.

## Docs — read these first

- **`docs/README.md`** — how Donna works today: architecture, capabilities, integrations,
  the thread-context feature, setup, and project layout.
- **`docs/roadmap.md`** — where she's headed and **the active to-do lists** (Phase 0 cleanup,
  Phase 1 agentic-core spike). Check here before starting new work; keep it updated as phases
  land.

## Architecture in one breath

`Slack event → processDonnaMessage() (app.js) → IntentClassifier.classify() (LLM →
{intent, slots}) → handleIntent() switch → handlers/*.js → services/*.js → external API`.

- `services/*.js` each wrap **one** external API (Asana, Google Calendar, SavvyCal, Toggl,
  Peloton). Clean and reusable — this is the codebase's main asset.
- `handlers/*.js` own per-domain logic and post messages back to Slack.
- `utils/dataStore.js` is **in-memory** per-thread state — it resets on restart, nothing is
  persisted yet.
- `utils/intentClassifier.js` is the current brain (OpenAI). `brain.js` is dead/legacy.

## Current direction (important context)

We are migrating the core **from the rigid single-intent router to an agentic tool-use loop
on Claude** (Sonnet 5 default, via `@anthropic-ai/sdk` Tool Runner). See `docs/roadmap.md`.
When adding a capability, prefer the roadmap's tool-based approach over extending the
`intentClassifier` mega-prompt + `app.js` switch, unless a task explicitly targets the
existing router.

## Running & checking

```bash
npm install
npm run dev            # starts app.js (needs a populated .env — see docs/README.md)
node -c <file.js>      # syntax check (there is no real test suite yet)
```

- `AGENT_MODE=true` + `OPENAI_API_KEY` are required for anything beyond exact commands.
- `BRAIN=agentic` + `ANTHROPIC_API_KEY` switch on the Claude Tool Runner brain (`utils/donnaBrain.js`).
- Thread reading needs Slack history scopes (`channels:history`, `groups:history`,
  `im:history`, `mpim:history`).

## Deployment

Donna is hosted on **Render** as a long-running Node service (`npm start`). Env vars are set
in the **Render dashboard** (not a committed `.env`) — new config must be added there to take
effect in production. **`.env.example` (repo root) is the full, documented list of env vars** —
keep it updated when you add config. In-memory `dataStore` is wiped on every deploy/restart.
Run mode (`SOCKET_MODE`) must match the Render service type (Background Worker for socket mode,
Web Service on `PORT` for HTTP mode). See `docs/README.md` → Deployment.

## Conventions & gotchas

- **Confirm before risky/irreversible actions.** Writes (create task, send, calendar changes)
  use a **preview-then-confirm** flow — keep that pattern (see `handlers/projects.js`
  `handleExtractTasks`/`confirmPendingTasks`).
- Personality currently lives in **hardcoded arrays** in `app.js` (canned lines chosen with
  `Math.random()`) and a keyword-based email templater (`generateModernEmail`). These are
  known stiffness sources slated for replacement by the Phase 1 Claude brain — don't build
  new features on them.
- No automated tests; verify changes by syntax-checking and, where possible, exercising the
  real flow. Phase 2 adds `npm run check:phase2` (offline: resolver + memory scope filters);
  `npm test` runs it after the syntax check.
- **Client isolation lives in storage, not prompts.** `services/memoryStore.js` is the *only*
  module that touches the DB, and its scope filter
  (`WHERE scope = ? AND (scope <> 'client' OR client_key = ?)`) is not optional — never add a
  read path that can return another client's rows. The active `client_key` comes from
  `utils/clientResolver.js`, never from the model.
- `.gitignore` covers `node_modules` and `.env`.

## Git workflow

- **One phase per branch.** Each roadmap phase (see `docs/roadmap.md`) gets its own
  short-lived branch off `main`, merged back via PR once it's tested. Keep branches small and
  focused rather than long-running.
- **Update docs in the same branch as the code they describe:** `.env.example` for any new
  config, `docs/README.md` for behavior / how-it-works, `docs/roadmap.md` to tick off phase
  to-dos, and this file when conventions change.
- Commit with clear messages; push with `git push -u origin <branch>`.
- Don't open a PR or push to `main` without explicit permission.
- Current working branch: `claude/savvycal-scheduling-links-x9ynlj` (restore + extend SavvyCal
  in the agentic brain: booking links, booked events, meeting polls — as tools in
  `utils/donnaTools.js`, not the old router). Update this line when a new phase branch starts.
