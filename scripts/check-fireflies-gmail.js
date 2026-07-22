#!/usr/bin/env node
// Offline behavioral checks for the Phase 3 Fireflies + Gmail tools — no network, no Slack.
//
// The Fireflies, Gmail, and Google Calendar service singletons are monkeypatched with fakes
// that record calls, so we can assert the *tool + confirm-flow logic* (which method fires, what
// gets staged in dataStore, how the notetaker/email drafts are built) without hitting
// api.fireflies.ai / Gmail / Google Calendar — which the build sandbox can't reach anyway. The
// live end-to-end check (real keys on Render) is documented in docs/README.md.
//
// Run via `npm run check:fireflies-gmail` (also runs inside `npm test`).

const assert = require('assert');
const firefliesService = require('../services/fireflies');
const gmailService = require('../services/gmail');
const googleCalendarService = require('../services/googleCalendar');
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
const NOW = 1753000000000; // fixed epoch for deterministic "recent" ordering

const FF_MEETINGS = [
  { id: 'FF1', title: 'Acme kickoff', date: NOW, duration: 32, organizer_email: 'tanya@indievisual.tech',
    participants: ['sam@acme.com'], meeting_attendees: [{ displayName: 'Sam Lee', email: 'sam@acme.com', name: 'Sam Lee' }] },
  { id: 'FF2', title: 'Beta weekly sync', date: NOW - 86400000, duration: 25, organizer_email: 'tanya@indievisual.tech',
    participants: ['jo@beta.io'], meeting_attendees: [{ displayName: 'Jo Kim', email: 'jo@beta.io', name: 'Jo Kim' }] }
];
const FF_TRANSCRIPTS = {
  FF1: {
    id: 'FF1', title: 'Acme kickoff', date: NOW, duration: 32, organizer_email: 'tanya@indievisual.tech',
    participants: ['sam@acme.com'],
    meeting_attendees: [{ displayName: 'Sam Lee', email: 'sam@acme.com', name: 'Sam Lee' }],
    summary: { overview: 'Kicked off the Acme project.', action_items: 'Tanya: send SOW\nSam: share brand assets', keywords: ['sow'], bullet_gist: '' },
    sentences: [{ speaker_name: 'Tanya', text: 'Welcome!' }, { speaker_name: 'Sam', text: 'Excited to start.' }]
  }
};

// Fireflies: replace the GraphQL layer only, keep the real normalizers/resolver logic.
firefliesService.apiKey = 'test-key';
firefliesService.getRecentMeetings = async (limit = 10) => {
  calls.push({ method: 'getRecentMeetings', args: [limit] });
  return FF_MEETINGS.slice(0, limit).map(t => firefliesService.normalizeMeeting(t));
};
firefliesService.getTranscript = async (id) => {
  calls.push({ method: 'getTranscript', args: [id] });
  if (!FF_TRANSCRIPTS[id]) throw new Error(`No transcript ${id}`);
  return firefliesService.normalizeTranscript(FF_TRANSCRIPTS[id]);
};

// Gmail: enabled + record createDraft, echoing normalized recipients.
gmailService.credentials = { client_email: 'svc@x.iam', private_key: 'k' };
gmailService.impersonate = 'tanya@indievisual.tech';
gmailService.createDraft = async ({ to, cc, subject, body }) => {
  calls.push({ method: 'createDraft', args: [{ to, cc, subject, body }] });
  const toList = (Array.isArray(to) ? to : [to]).filter(a => a && a.toLowerCase() !== 'tanya@indievisual.tech');
  return { id: 'DRAFT1', webLink: 'https://mail.google.com/mail/u/0/#drafts?compose=DRAFT1', to: toList, cc: cc || [] };
};

// Google Calendar: an event with and without Fred.
const CAL_EVENTS = [
  { id: 'EV1', summary: 'Acme kickoff', start: { dateTime: '2026-07-23T14:00:00Z' },
    attendees: [{ email: 'sam@acme.com' }] }
];
googleCalendarService.getEventsThisWeek = async () => { calls.push({ method: 'getEventsThisWeek', args: [] }); return CAL_EVENTS; };
googleCalendarService.getEventsForDate = async (date) => { calls.push({ method: 'getEventsForDate', args: [date] }); return CAL_EVENTS; };
googleCalendarService.updateEvent = async (id, updates) => { calls.push({ method: 'updateEvent', args: [id, updates] }); return { id, ...updates }; };

// buildTools requires the (patched) services, so load after patching.
const { buildTools } = require('../utils/donnaTools');
const commsHandler = require('../handlers/comms');

const posted = [];
const client = { chat: { postMessage: async (m) => { posted.push(m); return { ok: true }; } } };
const CH = 'C_TEST';
const TS = 'T_TEST';
dataStore.setCachedData('user_timezone_U1', 'America/New_York');

function freshThread() {
  dataStore.setThreadData(CH, TS, { pending_email_draft: null, pending_notetaker: null });
}
const tools = buildTools({ client, channel: CH, thread_ts: TS, userId: 'U1' });
const tool = name => {
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`tool "${name}" not registered`);
  return t;
};

async function main() {
  await ok('all 6 Phase 3 tools are registered', () => {
    ['list_meetings', 'get_meeting_notes', 'get_meeting_transcript',
     'check_notetaker', 'toggle_notetaker', 'draft_email'].forEach(n => tool(n));
  });

  // ── Fireflies reads ──────────────────────────────────────────────────────────
  await ok('list_meetings formats title, participant count, id', async () => {
    calls.length = 0;
    const res = await tool('list_meetings').run({});
    assert.match(res, /Acme kickoff/);
    assert.match(res, /id: FF1/);
    assert.match(res, /1 people/);
  });

  await ok('get_meeting_notes (no name) resolves to most recent + shows action items + emails', async () => {
    calls.length = 0;
    const res = await tool('get_meeting_notes').run({});
    assert.strictEqual(calls.find(c => c.method === 'getTranscript').args[0], 'FF1', 'should fetch the most recent (FF1)');
    assert.match(res, /Sam Lee <sam@acme\.com>/);
    assert.match(res, /send SOW/);
  });

  await ok('get_meeting_notes by fuzzy name resolves the right meeting', async () => {
    calls.length = 0;
    const res = await tool('get_meeting_notes').run({ meeting: 'kickoff' });
    assert.match(res, /Acme kickoff/);
  });

  await ok('get_meeting_transcript returns speaker-labeled lines', async () => {
    const res = await tool('get_meeting_transcript').run({ meeting: 'Acme' });
    assert.match(res, /Tanya: Welcome!/);
    assert.match(res, /Sam: Excited to start\./);
  });

  // ── Notetaker (Fred) on a calendar event ─────────────────────────────────────
  await ok('check_notetaker reports Fred absent when not a guest', async () => {
    const res = await tool('check_notetaker').run({ meeting: 'Acme' });
    assert.match(res, /not\*? on/i);
  });

  await ok('toggle_notetaker add stages pending + posts card, does NOT patch the event', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    const res = await tool('toggle_notetaker').run({ action: 'add', meeting: 'Acme' });
    const p = dataStore.getThreadData(CH, TS).pending_notetaker;
    assert.strictEqual(p.action, 'add');
    assert.strictEqual(p.eventId, 'EV1');
    assert.strictEqual(p.notetakerEmail, 'fred@fireflies.ai');
    assert.ok(posted[posted.length - 1].blocks, 'a confirm card should be posted');
    assert.ok(!calls.some(c => c.method === 'updateEvent'), 'must NOT patch before confirm');
    assert.match(res, /Wait for them to confirm/);
  });

  await ok('confirm notetaker add → patches event attendees to include Fred', async () => {
    calls.length = 0;
    await commsHandler.confirmPendingNotetaker({ client, channel: CH, thread_ts: TS });
    const call = calls.find(c => c.method === 'updateEvent');
    assert.ok(call, 'updateEvent should fire on confirm');
    const emails = call.args[1].attendees.map(a => a.email);
    assert.ok(emails.includes('sam@acme.com'), 'existing attendee kept');
    assert.ok(emails.includes('fred@fireflies.ai'), 'Fred added');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_notetaker, null, 'pending cleared');
  });

  await ok('confirm notetaker remove → patches event attendees to drop Fred', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { pending_notetaker: {
      action: 'remove', eventId: 'EV9', eventSummary: 'Call', eventWhen: '', notetakerEmail: 'fred@fireflies.ai',
      attendees: [{ email: 'sam@acme.com' }, { email: 'fred@fireflies.ai' }]
    } });
    await commsHandler.confirmPendingNotetaker({ client, channel: CH, thread_ts: TS });
    const emails = calls.find(c => c.method === 'updateEvent').args[1].attendees.map(a => a.email);
    assert.ok(!emails.includes('fred@fireflies.ai'), 'Fred removed');
    assert.ok(emails.includes('sam@acme.com'), 'others kept');
  });

  // ── Email drafts (Gmail) ─────────────────────────────────────────────────────
  await ok('draft_email stages a draft + posts preview, does NOT create yet', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    const res = await tool('draft_email').run({
      to: ['sam@acme.com'], subject: 'Kickoff recap', body: 'Thanks Sam.', meeting_title: 'Acme kickoff'
    });
    const p = dataStore.getThreadData(CH, TS).pending_email_draft;
    assert.deepStrictEqual(p.to, ['sam@acme.com']);
    assert.strictEqual(p.subject, 'Kickoff recap');
    assert.ok(posted[posted.length - 1].blocks, 'draft preview card posted');
    assert.ok(!calls.some(c => c.method === 'createDraft'), 'must NOT create before confirm');
    assert.match(res, /Wait for them to confirm/);
  });

  await ok('draft_email accepts a comma-string of recipients', async () => {
    freshThread();
    await tool('draft_email').run({ to: 'a@x.com, b@y.com', subject: 'Hi', body: 'Body' });
    assert.deepStrictEqual(dataStore.getThreadData(CH, TS).pending_email_draft.to, ['a@x.com', 'b@y.com']);
  });

  await ok('draft_email rejects an empty body without staging', async () => {
    freshThread();
    const res = await tool('draft_email').run({ to: ['a@x.com'], subject: 'Hi', body: '   ' });
    assert.match(res, /body is empty/);
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_email_draft, null);
  });

  await ok('confirm email draft → createDraft called, pending cleared', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { pending_email_draft: {
      to: ['sam@acme.com'], cc: [], subject: 'Recap', body: 'Thanks.', meetingTitle: null
    } });
    await commsHandler.confirmPendingEmailDraft({ client, channel: CH, thread_ts: TS });
    const call = calls.find(c => c.method === 'createDraft');
    assert.ok(call, 'createDraft should fire on confirm');
    assert.strictEqual(call.args[0].subject, 'Recap');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_email_draft, null);
  });

  await ok('cancel email draft clears pending without creating', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { pending_email_draft: { to: ['a@x.com'], subject: 's', body: 'b' } });
    await commsHandler.cancelPendingEmailDraft({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_email_draft, null);
    assert.ok(!calls.some(c => c.method === 'createDraft'));
  });

  // ── Gmail service unit: MIME build + recipient hygiene ───────────────────────
  await ok('GmailService.buildRawMessage is base64url (no + / =) and round-trips headers', () => {
    const GmailCtor = gmailService.constructor;
    const raw = GmailCtor.buildRawMessage({ from: 'me@x.com', to: ['a@x.com'], cc: [], subject: 'Hi', body: 'Yo' });
    assert.ok(!/[+/=]/.test(raw), 'must be base64url');
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    assert.match(decoded, /To: a@x\.com/);
    assert.match(decoded, /Subject: Hi/);
    assert.match(decoded, /\r\n\r\nYo$/);
  });

  console.log(`\n${passed} checks passed.`);
}

main();
