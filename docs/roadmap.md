# Donna — evolution roadmap

The goal: turn Donna from a capable-but-stiff command bot into a genuinely versatile
executive assistant (modeled after Donna Paulsen) — one who **reads context, converses
naturally, chains multiple actions, remembers, and acts proactively**.

## Mission

Donna is the all-in-one assistant for a **one-person consulting business (IndieVisual)** —
productivity hacking and staying organized. She spans:

- **Work** — managing the calendar, prepping before meetings, updating project to-dos,
  drafting emails, drafting contracts and other documents, and one day maybe billing
  (QuickBooks). Because the business serves **multiple clients**, she must **never mix up
  context across clients** — a confidentiality requirement designed into the memory
  architecture (see Phase 2), not a hope.
- **Personal** — meal prep and recipe ideas, restaurant recommendations, and fitting in
  workouts (she has Peloton access).
- **Personality** — intuitive, witty, and genuinely helpful.

This doc records the assessment, the decisions we've made, and the phased plan. Phases 0
and 1 have concrete to-do checklists at the bottom for this branch
(`claude/donna-context-asana-7tkl2c`).

---

## Where Donna is today (assessment)

What's good — and worth keeping:
- **The service layer is clean and reusable.** Each integration (`services/*.js`) wraps one
  API with sensible methods. This is the asset that makes everything below tractable.
- Solid timezone handling, a real daily-rundown feature, and (new) thread-context reading.

What makes her stiff — and it's structural, not cosmetic:
- **Faked personality.** `donnaOpeningLines` / `donnaResponses` / `exitResponses` are
  hardcoded arrays picked with `Math.random()`. She rotates ~15 stock phrases regardless of
  context. The email "drafter" (`generateModernEmail`) is a keyword-driven string builder,
  not real writing — and `handleGeneralChat` sometimes throws away the LLM's actual response
  and substitutes a canned Donna-ism.
- **Rigid brain.** Every message goes through a single-intent LLM classifier
  (`utils/intentClassifier.js`) → a giant `switch` in `app.js`. Adding any capability means
  editing a mega-prompt **and** a switch case **and** a handler. Multi-step requests don't
  really work (`multi_step` just tells you to do it yourself).
- **No memory.** `utils/dataStore.js` is in-memory `Map`s — a restart wipes everything; thread
  state expires in 24h. She can't remember people, preferences, or commitments.
- **No proactivity.** She's purely reactive — no scheduler for briefings, nudges, or prep.
- Minor debt: dead `brain.js`; `handlers/calendar.js` has `generateProjectRollup` defined
  twice and three near-duplicate "insights" methods; `.DS_Store` committed.

## Decisions (confirmed)

- **Move the brain to Claude**, via the Anthropic SDK (`@anthropic-ai/sdk`) using the
  **Tool Runner** (it drives the request → run-tool → loop cycle, so we wrap existing service
  methods as tools instead of hand-writing an agent loop).
- **Default runtime model: Claude Sonnet 5** — best quality-per-cost for chat + tool use
  (`claude-sonnet-5`; intro pricing $2/$10 per 1M tokens through 2026-08-31, then $3/$15).
  Escalate to **Opus 4.8** (`claude-opus-4-8`) only for the hardest reasoning. Keep the model
  configurable via env (`DONNA_MODEL`).
- **Architecture: rebuild the core on an agentic tool-use loop, rolled out in phases** — the
  "less stiff + more versatile" goal both depend on it, and over the roadmap it's *less* total
  effort than bolting more intents onto the rigid router (each new function becomes one tool,
  not prompt+switch+handler surgery).
- **Memory + proactivity**: both. Persistent memory so she remembers across restarts; a
  scheduler for morning briefs, follow-up nudges, and meeting prep.
- **Client-context isolation is a first-class requirement.** Memory is scoped
  (personal / business-global / per-client) and enforced in the storage layer; the active
  client is resolved **per message** (content + registry) with confirm-when-unsure; the
  client registry comes from the user's **Google Sheet**. See the Phase 2 design below.
- **Priority business functions**: client & project work (Asana), email & comms (draft *and*
  send), notes & meetings (Fireflies-direct).
- **Writes stay preview-then-confirm** (create tasks, send email, calendar changes) — matches
  Donna's "confirm before risky actions" ethos.

### On cost — why it isn't the deciding factor

Donna serves one user (~10–30 real interactions/day), so **API token cost is negligible
regardless of model** — roughly $15–35/month on Sonnet 5 (with prompt caching, which the
agentic setup gets for free), vs ~$40–90 on Opus 4.8, vs ~$1–3 on the current OpenAI mini
router. The real cost is **engineering effort**, which is why the phased agentic rebuild wins:
it makes every future capability cheap to add.

---

## Phased plan

| Phase | Theme | Outcome |
|------|-------|---------|
| **0** | Cleanup | Remove dead code / dupes so the rebuild starts clean. Non-breaking. |
| **1** | Agentic core | Tool Runner loop on Sonnet 5 + real personality prompt; existing services as tools. Multi-step + natural conversation start working. Runs alongside the old router behind a flag. |
| **2** | Memory & client context | Scoped, persistent memory (personal / business-global / per-client) with **client isolation enforced in storage**; a client registry from the user's Google Sheet; per-message client resolution. Must survive Render redeploys. See the design section below. |
| **3** | Priority functions | Email (draft + send, triage), Fireflies-direct for meetings/notes, deeper client/project tracking — each added as a tool. |
| **4** | Proactivity | Scheduler for the morning brief, follow-up nudges, meeting prep — reusing the daily-rundown logic. Render Cron Jobs, or an in-process `node-cron` inside the worker. |

Each phase is independently shippable; after Phase 1 everything else is additive.

---

## To-dos for this branch

### Phase 0 — Cleanup (safe, non-breaking) ✅ done

- [x] Delete `brain.js` (dead code — superseded by `utils/intentClassifier.js`; nothing
      `require`d it).
- [x] Deduplicate `handlers/calendar.js`: removed the shadowing second `generateProjectRollup`
      (kept the `periodTasks` version the renderer actually reads — the removed copy wrote
      `todayTasks`, so the detailed daily-rundown breakdown had been silently dropping period
      tasks); removed the two dead insight helpers (`generateFocusedDailyInsights`,
      `generateDailyInsights`) and the now-unused `hasBackToBackMeetings`. `generatePeriodInsights`
      is the one live helper. (calendar.js: 1318 → 1138 lines.)
- [x] Remove committed `.DS_Store` files and ensure `.gitignore` covers them.
- [x] Add a minimal smoke test — `npm test` (`scripts/check-syntax.js`) syntax-checks every
      project `.js` file. Still no real behavioral suite; that comes with the Phase 1 rebuild.

> Note: the canned-personality arrays and the hardcoded email templater are intentionally
> **not** deleted in Phase 0 — removing them would leave the current bot broken. They're
> replaced in Phase 1 when the agentic brain supplies real personality and email drafting.

### Phase 1 — Agentic core (spike alongside the existing router) — in progress

Landed (the spike is wired and offline-verified; live run needs `ANTHROPIC_API_KEY`):

- [x] Add `@anthropic-ai/sdk`; add `ANTHROPIC_API_KEY`, `DONNA_MODEL` (default
      `claude-sonnet-5`), and `BRAIN` to config/env and README.
- [x] Donna's system prompt in one place — `utils/donnaPrompt.js` (personality, no canned
      phrases; ask ≤1 question; confirm before writes; concise Slack style).
- [x] Tools module — `utils/donnaTools.js` wrapping existing services: `list_tasks`,
      `list_projects`, `check_calendar` (read), and `propose_tasks` (write → reuses the
      existing pending-task + Create/Cancel button flow; also covers "turn this call's action
      items into tasks", since the model reads the thread transcript in context).
- [x] Agentic handler — `utils/donnaBrain.js` runs `client.beta.messages.toolRunner(...)`
      with the thread transcript as context; writes stay **preview-then-confirm**.
- [x] Gated behind `BRAIN=agentic` in `app.js` (runs past the exact-command fast paths,
      alongside the OpenAI router). Startup log reports the active brain.

Still to do in Phase 1:

- [x] Add a `propose_meeting` write tool (calendar events) — same preview-then-confirm pattern
      as `propose_tasks` (preview card + Create/Cancel buttons; creates the Google Calendar
      event only on confirm via `calendarHandler.confirmPendingEvent`).
- [x] **Live verification** — thread reading, extraction, and the agentic brain confirmed
      working in production (`BRAIN=agentic`, Sonnet 5). Ongoing: tune `DONNA_MODEL` / effort
      for latency vs. quality as you use it.
- [ ] **Deferred until agentic becomes the default** (a separate milestone — the OpenAI router
      is still the default and fallback, and this code is load-bearing for it): retire the
      canned personality arrays and `generateModernEmail` in `app.js`, and stop
      `handleGeneralChat` discarding the model's response.

---

## Phase 2 — Memory & client context (design)

Donna serves a one-person consulting business with **multiple clients**, so memory has a hard
requirement beyond "remember things": she must **never mix up context across clients**. Getting
Client B's details into a draft for Client A isn't a bug — it's a confidentiality breach. So
isolation is a first-class design goal, not a prompt instruction.

### Core principle
Isolation is enforced in the **storage/retrieval layer**, not the prompt. Donna is only ever
*handed* the active client's memory; she can't leak what she was never given. The prompt just
operates on whatever scope it was given.

### Scopes
- **personal** — the user; preferences; meals/recipes/restaurants; workouts. Never touches
  client work.
- **business-global (IndieVisual)** — true across all clients: bio, rate card, contract
  boilerplate, email voice.
- **per-client** — one isolated namespace per client (deadlines, decisions, contacts, notes,
  contract terms).

Operating for a client, Donna sees `personal + business-global + <that client>` and nothing
from other clients.

### Client registry — from the user's Google Sheet
The source of truth for clients/projects is a **Google Sheet** the user maintains. The bot
reads it with its existing Google service account (share the sheet with the service-account
email). Suggested columns:

`Client` (canonical) · `Aliases` (other names/abbreviations to match) · `Asana project` (so
tasks file into the right project) · `Email domain` (optional; aids detection) · `Status`
(active/archived).

The registry powers the valid client set, content-matching for resolution, and the memory
namespace keys. `Client → Asana project` means action items for a client file into that
client's Asana project automatically.

### Scope resolution — per message, not per channel
The user's Slack is **not** one-channel-per-client (a shared `call-notes` channel holds
Fireflies notes across clients; ad-hoc DMs vary by client), so the channel can't determine
scope. But it's usually one client per message, and Fireflies notes name the client — so:

1. On each message (+ its thread/note), resolve the active client by matching content against
   the registry (names / aliases / domains).
2. **Confident** → proceed, and **surface the client** on the reply (e.g. a `📁 Acme` tag) so
   mistakes are visible.
3. **Ambiguous / no match** → ask "which client?" before anything client-scoped. In shared
   channels like `call-notes`, lean toward confirming even on a good guess.
4. **Explicit override wins** — "for Beta, …" forces Beta.

### Confidentiality rule
**Inbound aggregation OK; outbound isolation strict.** "What's my workload across all clients?"
is allowed — an explicit, read-only, clearly-labeled multi-client view. But cross-client
context must never flow into an *outward* artifact (an email or doc to a client). Single-client
is the default for anything she drafts or sends.

### Persistence & database
Memory must survive Render redeploys (the in-memory `dataStore` is wiped on every deploy/
restart), so it lives in a real database — **Postgres**, behind a thin data-access module.

**`services/memoryStore.js` is the only thing that touches the DB.** It exposes
`remember({ scope, client, ... })` / `recall({ scope, client, ... })` and enforces the scope
filter on **every** query. This is where the isolation guarantee actually lives — no caller can
read across clients, because the filter isn't optional. The schema is tiny (the Google Sheet
stays the client *registry*; the DB only holds scoped memory):

```
memories(id, scope, client_key, kind, content, created_at, updated_at)
  scope ∈ 'personal' | 'business' | 'client'
  every read: WHERE scope = ? AND (scope <> 'client' OR client_key = ?)
```

**Engine** — swappable behind the module (a connection-string choice, not an architecture one):
- **Recommended: Neon** (serverless Postgres) — free, durable, standard Postgres; just a
  connection string in Render env.
- **Render Postgres** — if you'd rather keep everything on Render (use the small paid tier for
  durability; Render's free Postgres has time-limited/expiring terms).
- **SQLite on a Render Disk** (`better-sqlite3`) — fewest moving parts; same scope-filtered
  schema, but needs a paid Render instance and pins the service to one node (fine for a solo
  bot). Use only if you want zero external DB.

We deliberately do **not** use the Claude memory-tool `/memories` file interface as the store —
structured rows with a scope key are far easier to isolate and audit than files. (That
model-facing interface could be layered on top later if useful.)

### Sub-steps
- **2a — Client registry + resolver:** read the Google Sheet; a `resolveClient(message)` layer
  → active client or "ambiguous". Backbone for everything below.
- **2b — Scoped memory:** personal / business-global / per-client namespaces via
  `services/memoryStore.js` over Postgres, storage-enforced, keyed by the registry's canonical
  client id, wired to 2a's confirm-when-unsure behavior.

Downstream (meeting prep, contract drafting, per-client email) then inherits correct scoping.
Even the current read tools (`list_tasks`, `check_calendar`) should become scope-filterable by
client — design new tool signatures with that in mind.

### Landed (this branch: `claude/phase-2-implementation-hw1tvz`)

Both sub-steps built, additive and defensively gated (no config → feature reports "not
configured", the bot runs exactly as before). Offline-verified (`npm run check:phase2`); the live
end-to-end check needs Postgres + a shared sheet (see below), like the Phase 1 `ANTHROPIC_API_KEY`
step.

- [x] **2a — Registry + resolver.** `services/googleSheets.js` (read-only Sheets, reuses the
      Calendar service account via the new `utils/googleAuth.js`; no new package —
      `googleapis` already present); `services/clientRegistry.js` (**config-driven column mapping**
      — headers auto-detected, `CLIENT_REGISTRY_COL_*` overrides — because the real sheet differs
      from the suggested layout; 5-min cached); `utils/clientResolver.js` (pure, injected registry:
      confident / ambiguous / none, explicit "for <Client>" override wins, transcript fallback).
- [x] **2b — Scoped memory.** `services/memoryStore.js` — **the only module that touches the DB**
      — over **Render Postgres** (`pg` + `DATABASE_URL`). The scope filter
      `WHERE scope = $1 AND (scope <> 'client' OR client_key = $2)` is applied on every read and is
      not optional; the visible-context read returns `personal + business + <active client>` only.
- [x] **Brain wiring (backbone + surface tag).** `donnaBrain` resolves the client, preloads visible
      memory, injects client/memory context, and prefixes confident replies with `📁 <Client>`;
      two tools (`remember`, `recall`) whose client namespace comes from the resolved context, never
      the model; prompt gains a Client-context-&-memory section (scopes, confirm-when-unsure, the
      inbound-aggregation-OK / outbound-single-client confidentiality rule). `list_tasks` /
      `check_calendar` signatures left as-is (scope-filtering deferred to a later phase, by design).

**Live checklist (on Render):** set `DATABASE_URL` + `CLIENT_REGISTRY_SHEET_ID`, share the sheet
with the service-account email, then confirm: a client-named message shows `📁 <Client>`; an
ambiguous message asks "which client?"; "remember that Acme prefers Friday check-ins" survives a
restart; recall never returns another client's rows.

### Decisions (confirmed for this build)
- **Ambiguity behavior:** detect + show the client (`📁`) + confirm-when-unsure. Explicit
  "for <Client>" overrides always win. _(Implemented in `utils/clientResolver.js` + the brain.)_
- **The sheet:** the real layout **differs** from the suggested columns, so the reader is
  **config-driven** — headers auto-detected with `CLIENT_REGISTRY_COL_*` env overrides, rather than
  hard-coded columns. Still to plug in at deploy: the **Sheet ID** (`CLIENT_REGISTRY_SHEET_ID`) and
  sharing the sheet with the service-account email. `Client → Asana project` auto-routing is left
  for a later phase (read/propose tool signatures unchanged for now).
- **Database engine:** **Render Postgres** (`pg` + `DATABASE_URL`), keeping everything in-platform.
  Swappable behind `memoryStore` (a connection-string choice). Use the small paid tier for
  durability.

## How we work through the phases

- **One phase per branch**, cut from `main`, merged back via PR once tested. Keep each branch
  small and focused.
- Update the docs in the same branch as the code: `.env.example` (new config),
  `docs/README.md` (behavior), this roadmap (tick off to-dos), and `CLAUDE.md` (conventions).
- After a phase merges, start the next from a fresh `main`.

_See [`README.md`](./README.md) for how Donna works today. Keep this roadmap updated as phases
land._
