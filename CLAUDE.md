# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

**Donna** — a Slack bot that acts as an all-in-one executive assistant (styled after Donna
Paulsen from *Suits*). She turns natural-language Slack messages into actions across
scheduling, time tracking, tasks, calendar, and workouts, and can read a thread's context to
answer questions or create Asana tasks from it.

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
- Thread reading needs Slack history scopes (`channels:history`, `groups:history`,
  `im:history`, `mpim:history`).

## Conventions & gotchas

- **Confirm before risky/irreversible actions.** Writes (create task, send, calendar changes)
  use a **preview-then-confirm** flow — keep that pattern (see `handlers/projects.js`
  `handleExtractTasks`/`confirmPendingTasks`).
- Personality currently lives in **hardcoded arrays** in `app.js` (canned lines chosen with
  `Math.random()`) and a keyword-based email templater (`generateModernEmail`). These are
  known stiffness sources slated for replacement by the Phase 1 Claude brain — don't build
  new features on them.
- No automated tests; verify changes by syntax-checking and, where possible, exercising the
  real flow.
- `.gitignore` covers `node_modules` and `.env`.

## Git workflow

- Active feature branch: **`claude/donna-context-asana-7tkl2c`**. Develop here; commit with
  clear messages; push with `git push -u origin <branch>`.
- Don't open a PR unless asked. Don't push to `main` without explicit permission.
