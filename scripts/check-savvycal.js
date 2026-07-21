#!/usr/bin/env node
// Offline behavioral checks for the SavvyCal agentic tools — no network, no Slack.
//
// The SavvyCal service singleton is monkeypatched with fakes that record calls, so we
// can assert the *tool + confirm-flow logic* (which method fires, what gets staged in
// dataStore, how slots are normalized) without hitting api.savvycal.com — which the
// build sandbox can't reach anyway. The live end-to-end check (real token on Render)
// is documented in docs/README.md.
//
// Run via `npm run check:savvycal` (also runs inside `npm test`).

const assert = require('assert');
const savvyCalService = require('../services/savvycal');
const dataStore = require('../utils/dataStore');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch(err => { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; });
}

// ── Test doubles ─────────────────────────────────────────────────────────────
const calls = [];
function record(method) {
  return (...args) => { calls.push({ method, args }); return Promise.resolve(fakes[method + ':return']); };
}
const fakes = {
  createSingleUseLink: record('createSingleUseLink'),
  createReusableLink: record('createReusableLink'),
  getLink: (id) => Promise.resolve({ id, name: 'Intro call', enabled: true, durations: [30] }),
  getLinks: () => Promise.resolve([{ id: 'L1', name: 'Intro', enabled: true }, { id: 'L2', name: 'Deep dive', enabled: false }]),
  toggleLink: record('toggleLink'),
  deleteLink: record('deleteLink'),
  getEvents: () => Promise.resolve([
    { start_at: '2026-07-23T18:00:00.000Z', summary: 'Discovery', attendee: { display_name: 'Sam Lee' } }
  ]),
  createPoll: record('createPoll'),
  getPolls: () => Promise.resolve([{ id: 'P1', name: 'Kickoff', state: 'open', slug: 'kickoff-abc' }]),
  getPoll: (id) => Promise.resolve({ id, name: 'Kickoff', state: 'open', slots: [
    { start_at: '2026-07-23T18:00:00.000Z', votes: 2 },
    { start_at: '2026-07-24T15:00:00.000Z', votes: 5 }
  ] }),
  deletePoll: record('deletePoll')
};
fakes['createSingleUseLink:return'] = { id: 'NEW-SINGLE', url: 'https://savvycal.com/indievisual/abc' };
fakes['createReusableLink:return'] = { id: 'NEW-REUSE', url: 'https://savvycal.com/indievisual/xyz' };
fakes['createPoll:return'] = { id: 'NEW-POLL', url: 'https://savvycal.com/indievisual/poll1', slotCount: 3, invited: 2 };

// Patch the singleton (keep the pure helpers — validateDuration/generateLinkTitle/buildUrlFrom — real).
Object.assign(savvyCalService, {
  createSingleUseLink: fakes.createSingleUseLink,
  createReusableLink: fakes.createReusableLink,
  getLink: fakes.getLink,
  getLinks: fakes.getLinks,
  toggleLink: fakes.toggleLink,
  deleteLink: fakes.deleteLink,
  getEvents: fakes.getEvents,
  createPoll: fakes.createPoll,
  getPolls: fakes.getPolls,
  getPoll: fakes.getPoll,
  deletePoll: fakes.deletePoll
});

// buildTools requires the (patched) service, so load it after patching.
const { buildTools } = require('../utils/donnaTools');
const schedulingHandler = require('../handlers/scheduling');

// Fake Slack client + context.
const posted = [];
const client = { chat: { postMessage: async (m) => { posted.push(m); return { ok: true }; } } };
const CH = 'C_TEST';
const TS = 'T_TEST';
// Pre-seed the timezone cache so TimezoneHelper never calls the Slack API.
dataStore.setCachedData('user_timezone_U1', 'America/New_York');

function freshThread() {
  // reset thread state for isolation between checks
  dataStore.setThreadData(CH, TS, {
    pending_sc_action: null, pending_sc_poll: null,
    last_link_id: null, last_link_url: null, last_poll_id: null
  });
}
const tools = buildTools({ client, channel: CH, thread_ts: TS, userId: 'U1' });
const tool = name => {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool "${name}" not registered`);
  return t;
};

async function main() {
  // ── Registration ───────────────────────────────────────────────────────────
  await ok('all 10 SavvyCal tools are registered', () => {
    ['create_scheduling_link', 'list_scheduling_links', 'get_scheduling_link',
     'disable_scheduling_link', 'delete_scheduling_link', 'list_booked_events',
     'create_scheduling_poll', 'list_scheduling_polls', 'get_scheduling_poll',
     'delete_scheduling_poll'].forEach(n => tool(n));
  });

  // ── create_scheduling_link ───────────────────────────────────────────────────
  await ok('create link (default) → single-use, rounds duration, stores thread context', async () => {
    freshThread(); calls.length = 0;
    const res = await tool('create_scheduling_link').run({ title: 'Intro', minutes: 25 });
    assert.strictEqual(calls[0].method, 'createSingleUseLink');
    assert.strictEqual(calls[0].args[1], 30, 'duration 25 should round to 30');
    assert.match(res, /single-use/);
    assert.strictEqual(dataStore.getThreadData(CH, TS).last_link_url, 'https://savvycal.com/indievisual/abc');
  });

  await ok('create link with reusable:true → reusable path', async () => {
    freshThread(); calls.length = 0;
    const res = await tool('create_scheduling_link').run({ title: 'Standing', minutes: 30, reusable: true });
    assert.strictEqual(calls[0].method, 'createReusableLink');
    assert.match(res, /reusable/);
  });

  // ── disable / delete link stage a confirm card (no immediate write) ──────────
  await ok('disable link (no id) uses last link, stages pending, posts card, no toggle yet', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    dataStore.setThreadData(CH, TS, { last_link_id: 'L9' });
    await tool('disable_scheduling_link').run({});
    const p = dataStore.getThreadData(CH, TS).pending_sc_action;
    assert.strictEqual(p.kind, 'disable_link');
    assert.strictEqual(p.id, 'L9');
    assert.ok(posted[posted.length - 1].blocks, 'a confirm card should be posted');
    assert.ok(!calls.some(c => c.method === 'toggleLink'), 'must NOT toggle before confirm');
  });

  await ok('confirm disable → toggles the link and clears pending', async () => {
    calls.length = 0;
    await schedulingHandler.confirmPendingScAction({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(calls[0].method, 'toggleLink');
    assert.strictEqual(calls[0].args[0], 'L9');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_sc_action, null);
  });

  await ok('confirm delete → deletes link and clears stored link ref', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { last_link_id: 'L5', last_link_url: 'u' });
    await tool('delete_scheduling_link').run({});
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_sc_action.kind, 'delete_link');
    await schedulingHandler.confirmPendingScAction({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(calls.find(c => c.method === 'deleteLink').args[0], 'L5');
    assert.strictEqual(dataStore.getThreadData(CH, TS).last_link_id, null);
  });

  await ok('cancel action clears pending without any write', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { pending_sc_action: { kind: 'delete_link', id: 'L1' } });
    await schedulingHandler.cancelPendingScAction({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_sc_action, null);
    assert.strictEqual(calls.length, 0);
  });

  // ── booked events (defensive field access) ───────────────────────────────────
  await ok('list_booked_events formats mixed event fields', async () => {
    const res = await tool('list_booked_events').run({});
    assert.match(res, /Discovery/);
    assert.match(res, /Sam Lee/);
  });

  // ── polls: create stages a preview + confirm sends with normalized slots ─────
  await ok('create poll drops invalid slots, keeps valid ISO, stages preview (no send yet)', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    const res = await tool('create_scheduling_poll').run({
      name: 'Kickoff',
      duration_minutes: 45,
      slots: ['2026-07-23T14:00:00', 'not-a-date', '2026-07-24T11:00:00'],
      attendees: ['a@x.com', '']
    });
    const p = dataStore.getThreadData(CH, TS).pending_sc_poll;
    assert.strictEqual(p.slots.length, 2, 'invalid slot should be filtered out');
    assert.strictEqual(p.durationMinutes, 45);
    assert.deepStrictEqual(p.attendees, ['a@x.com']);
    assert.ok(posted[posted.length - 1].blocks, 'poll preview card posted');
    assert.ok(!calls.some(c => c.method === 'createPoll'), 'must NOT send before confirm');
    assert.match(res, /Wait for the user to confirm/);
  });

  await ok('confirm poll → createPoll called, last_poll_id stored', async () => {
    calls.length = 0;
    await schedulingHandler.confirmPendingScPoll({ client, channel: CH, thread_ts: TS });
    const call = calls.find(c => c.method === 'createPoll');
    assert.ok(call, 'createPoll should fire on confirm');
    assert.strictEqual(call.args[0].slots.length, 2);
    assert.strictEqual(dataStore.getThreadData(CH, TS).last_poll_id, 'NEW-POLL');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_sc_poll, null);
  });

  await ok('get_scheduling_poll (no id) uses last poll and shows vote counts', async () => {
    const res = await tool('get_scheduling_poll').run({});
    assert.match(res, /5 votes/);
    assert.match(res, /2 votes/);
  });

  await ok('delete poll stages delete_poll then confirm deletes', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { last_poll_id: 'P7' });
    await tool('delete_scheduling_poll').run({});
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_sc_action.kind, 'delete_poll');
    await schedulingHandler.confirmPendingScAction({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(calls.find(c => c.method === 'deletePoll').args[0], 'P7');
  });

  console.log(`\n${passed} checks passed.`);
}

main();
