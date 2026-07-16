#!/usr/bin/env node
// Offline behavioral checks for Phase 2 (memory & client context) — no DB, no network.
//
// Two things worth asserting without live infra:
//   1) clientResolver picks the right client (confident / ambiguous / none / explicit override).
//   2) memoryStore's scope filters ALWAYS constrain client_key for client scope — this is the
//      isolation guarantee, so we test the pure SQL builders directly.
//
// Run via `npm run check:phase2`. The live end-to-end check (Postgres + a shared sheet) is
// documented in docs/README.md — it needs config this script deliberately doesn't require.

const assert = require('assert');
const { resolveClient } = require('../utils/clientResolver');
const memoryStore = require('../services/memoryStore');
const clientRegistry = require('../services/clientRegistry');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLIENTS = [
  { key: 'acme', name: 'Acme', aliases: ['Acme Corp', 'ACM'], asanaProject: 'Acme', emailDomain: 'acme.com', status: 'active' },
  { key: 'beta-industries', name: 'Beta Industries', aliases: ['Beta'], asanaProject: 'Beta', emailDomain: 'beta.io', status: 'active' },
  { key: 'gamma', name: 'Gamma', aliases: [], asanaProject: 'Gamma', emailDomain: '', status: 'active' }
];

// ── clientResolver ──────────────────────────────────────────────────────────
ok('resolver: single mention in message → confident', () => {
  const r = resolveClient({ text: 'add a task for the Acme launch', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'acme');
});

ok('resolver: alias match → confident', () => {
  const r = resolveClient({ text: 'what did Beta decide on the timeline?', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'beta-industries');
});

ok('resolver: email domain match → confident', () => {
  const r = resolveClient({ text: 'follow up with jane@acme.com', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'acme');
});

ok('resolver: two clients in one message → ambiguous', () => {
  const r = resolveClient({ text: 'compare Acme and Gamma workloads', clients: CLIENTS });
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.candidates.length, 2);
});

ok('resolver: no match → none', () => {
  const r = resolveClient({ text: 'remind me to buy milk', clients: CLIENTS });
  assert.strictEqual(r.status, 'none');
});

ok('resolver: explicit override wins over transcript', () => {
  const r = resolveClient({
    text: 'for Beta, summarize the notes',
    transcript: 'Acme Acme Acme call recap ...', // transcript is all Acme
    clients: CLIENTS
  });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'beta-industries');
  assert.strictEqual(r.source, 'override');
});

ok('resolver: falls back to transcript when message has no client', () => {
  const r = resolveClient({ text: 'turn these into tasks', transcript: 'Gamma kickoff notes', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'gamma');
  assert.strictEqual(r.source, 'transcript');
});

ok('resolver: empty registry → none', () => {
  assert.strictEqual(resolveClient({ text: 'Acme', clients: [] }).status, 'none');
});

// ── memoryStore scope filters (the isolation guarantee) ─────────────────────
const { _buildScopeWhere, _buildVisibleWhere } = memoryStore._internal;

ok('scope filter: client scope always constrains client_key', () => {
  const w = _buildScopeWhere({ scope: 'client', client_key: 'acme' });
  assert.match(w.text, /client_key = \$2/);
  assert.deepStrictEqual(w.values, ['client', 'acme']);
});

ok('scope filter: non-client scope cannot leak client rows', () => {
  // For personal/business, the guard `scope <> 'client' OR client_key = ?` is trivially true,
  // so only personal/business rows return — and no client row can match (its scope IS 'client').
  const w = _buildScopeWhere({ scope: 'personal', client_key: null });
  assert.match(w.text, /scope <> 'client' OR client_key = \$2/);
});

ok('visible filter: only the active client branch is client-scoped', () => {
  const w = _buildVisibleWhere({ client_key: 'acme' });
  assert.match(w.text, /scope = 'personal'/);
  assert.match(w.text, /scope = 'business'/);
  assert.match(w.text, /scope = 'client' AND client_key = \$1/);
  assert.deepStrictEqual(w.values, ['acme']);
});

ok('visible filter: null client_key means no client rows leak', () => {
  // client_key = NULL never matches in SQL, so the client branch is inert → personal+business only.
  const w = _buildVisibleWhere({ client_key: null });
  assert.deepStrictEqual(w.values, [null]);
});

// ── clientRegistry column mapping (config-driven, header-detected) ──────────
const { parseRows } = clientRegistry._internal;

ok('registry: parses roadmap-style headers', () => {
  const rows = [
    ['Client', 'Aliases', 'Asana project', 'Email domain', 'Status'],
    ['Acme', 'Acme Corp, ACM', 'Acme', 'acme.com', 'active']
  ];
  const clients = parseRows(rows);
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].key, 'acme');
  assert.deepStrictEqual(clients[0].aliases, ['Acme Corp', 'ACM']);
  assert.strictEqual(clients[0].asanaProject, 'Acme');
});

ok('registry: adapts to differently-named headers', () => {
  const rows = [
    ['Company', 'AKA', 'Project', 'Domain', 'State'],
    ['Beta Industries', 'Beta', 'Beta', 'beta.io', 'active']
  ];
  const clients = parseRows(rows);
  assert.strictEqual(clients[0].key, 'beta-industries');
  assert.deepStrictEqual(clients[0].aliases, ['Beta']);
  assert.strictEqual(clients[0].emailDomain, 'beta.io');
});

console.log(`\n${passed} checks passed.`);
