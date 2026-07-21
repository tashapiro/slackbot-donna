#!/usr/bin/env node
// Offline checks for DM conversation memory — no network, no Slack.
//
// In a DM there's no thread_ts, so the thread reader can't see any history and Donna
// would answer each message in isolation. fetchRecentHistory() closes that gap by
// pulling conversations.history. These checks stub the Slack client and assert the
// transcript is oldest-first, labels Donna's own lines, drops blanks, and degrades to
// [] on error. Run via `npm run check:dm-memory` (also part of `npm test`).

const assert = require('assert');
const { fetchRecentHistory, fetchThreadTranscript } = require('../utils/threadReader');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch(err => { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; });
}

const BOT = 'UDONNA';
// conversations.history returns NEWEST first — the reader must reverse it.
function fakeClient(messages) {
  return {
    conversations: { history: async ({ channel, limit }) => ({ messages }) },
    users: { info: async ({ user }) => ({ user: { profile: { display_name: user === 'UTANYA' ? 'Tanya' : user } } }) }
  };
}

async function main() {
  await ok('fetchRecentHistory returns oldest→newest and labels Donna + users', async () => {
    const client = fakeClient([
      { user: BOT, text: 'A couple options: Aug 3–7?', ts: '3' },      // newest
      { user: 'UTANYA', text: 'set up a poll next week', ts: '2' },
      { user: BOT, text: "You're OOO all week", ts: '1' }              // oldest
    ]);
    const t = await fetchRecentHistory(client, 'D123', { botUserId: BOT });
    assert.strictEqual(t.length, 3);
    assert.strictEqual(t[0].text, "You're OOO all week", 'should be reversed to oldest-first');
    assert.strictEqual(t[0].author, 'Donna');
    assert.strictEqual(t[1].author, 'Tanya');
    assert.strictEqual(t[2].author, 'Donna');
  });

  await ok('fetchRecentHistory drops blank messages', async () => {
    const client = fakeClient([
      { user: 'UTANYA', text: '   ', ts: '2' },
      { user: 'UTANYA', text: 'real message', ts: '1' }
    ]);
    const t = await fetchRecentHistory(client, 'D123', { botUserId: BOT });
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].text, 'real message');
  });

  await ok('fetchRecentHistory degrades to [] on API error (e.g. missing scope)', async () => {
    const client = { conversations: { history: async () => { throw new Error('missing_scope'); } } };
    const t = await fetchRecentHistory(client, 'D123', { botUserId: BOT });
    assert.deepStrictEqual(t, []);
  });

  await ok('fetchRecentHistory returns [] for a missing channel', async () => {
    assert.deepStrictEqual(await fetchRecentHistory(fakeClient([]), null, {}), []);
  });

  await ok('fetchThreadTranscript still returns [] without a thread_ts (unchanged)', async () => {
    assert.deepStrictEqual(await fetchThreadTranscript(fakeClient([]), 'C1', null, {}), []);
  });

  console.log(`\n${passed} checks passed.`);
}

main();
