# Donna — evolution roadmap

The goal: turn Donna from a capable-but-stiff command bot into a genuinely versatile
executive assistant (modeled after Donna Paulsen) — one who **reads context, converses
naturally, chains multiple actions, remembers, and acts proactively** across business
functions.

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
| **2** | Memory | Persistence so she remembers people, preferences, commitments across restarts (Claude memory tool is a clean fit). |
| **3** | Priority functions | Email (draft + send, triage), Fireflies-direct for meetings/notes, deeper client/project tracking — each added as a tool. |
| **4** | Proactivity | Scheduler (node-cron) for the morning brief, follow-up nudges, meeting prep — reusing the daily-rundown logic. |

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

### Phase 1 — Agentic core (spike alongside the existing router)

- [ ] Add `@anthropic-ai/sdk`; add `ANTHROPIC_API_KEY` and `DONNA_MODEL` (default
      `claude-sonnet-5`) to config/env and README.
- [ ] Write Donna's system prompt in one place (e.g. `utils/donnaPrompt.js`): personality
      (sharp, warm, witty — no canned phrases) + operating rules (ask at most one clarifying
      question; confirm before risky/irreversible actions; be concise).
- [ ] Create a tools module (e.g. `utils/tools.js`) wrapping existing service methods as Tool
      Runner tools. Start small: `list_tasks`, `create_task` (preview→confirm),
      `check_calendar`, `create_meeting`, and thread → `extract_tasks`.
- [ ] Add an agentic handler that runs `client.beta.messages.toolRunner(...)` with the thread
      transcript (`utils/threadReader.js`) as context; keep **preview-then-confirm** for all
      writes (Asana, calendar, later email).
- [ ] Gate it behind a flag (e.g. `BRAIN=agentic`) so it runs alongside the current router for
      A/B testing before any full migration.
- [ ] Once the agentic path handles conversation + email drafting, retire the canned
      personality arrays and `generateModernEmail`, and stop `handleGeneralChat` from
      discarding the model's response.
- [ ] Verify on real messages: thread summarize/Q&A, and a multi-step ask
      ("summarize this call, add the action items to Asana, and block 30 min to review").

---

_See [`README.md`](./README.md) for how Donna works today. Keep this roadmap updated as phases
land._
