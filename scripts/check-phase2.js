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

// ── Fixtures (shaped like the real IndieVisual Hub after parsing) ────────────
const CLIENTS = [
  { id: 'CLI-002', key: 'CLI-002', name: 'Lockton Companies LLC', aliases: ['Lockton'], emailDomains: ['lockton.com'], status: 'active' },
  { id: 'CLI-003', key: 'CLI-003', name: 'R for the Rest of Us', aliases: [], emailDomains: ['rfortherestofus.com'], status: 'active' },
  { id: 'CLI-004', key: 'CLI-004', name: 'Acme Corp', aliases: ['Acme'], emailDomains: ['acme.com'], status: 'active' }
];

// ── clientResolver ──────────────────────────────────────────────────────────
ok('resolver: casual mention matches derived alias → confident', () => {
  const r = resolveClient({ text: 'add a task for the Lockton launch', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'CLI-002');
});

ok('resolver: formal name still matches', () => {
  const r = resolveClient({ text: 'invoice Lockton Companies LLC', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'CLI-002');
});

ok('resolver: email domain match → confident', () => {
  const r = resolveClient({ text: 'follow up with stacy.warren@lockton.com', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'CLI-002');
});

ok('resolver: two clients in one message → ambiguous', () => {
  const r = resolveClient({ text: 'compare Lockton and Acme workloads', clients: CLIENTS });
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.candidates.length, 2);
});

ok('resolver: no match → none', () => {
  assert.strictEqual(resolveClient({ text: 'remind me to buy milk', clients: CLIENTS }).status, 'none');
});

ok('resolver: explicit override wins over transcript', () => {
  const r = resolveClient({
    text: 'for Acme, summarize the notes',
    transcript: 'Lockton Lockton Lockton call recap ...',
    clients: CLIENTS
  });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'CLI-004');
  assert.strictEqual(r.source, 'override');
});

ok('resolver: falls back to transcript when message has no client', () => {
  const r = resolveClient({ text: 'turn these into tasks', transcript: 'R for the Rest of Us kickoff', clients: CLIENTS });
  assert.strictEqual(r.status, 'confident');
  assert.strictEqual(r.client.key, 'CLI-003');
  assert.strictEqual(r.source, 'transcript');
});

ok('resolver: empty registry → none', () => {
  assert.strictEqual(resolveClient({ text: 'Lockton', clients: [] }).status, 'none');
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

// ── clientRegistry: parses the real IndieVisual Hub schema ──────────────────
const { parseClients, contactDomainsByClient, deriveAliases, domainFromWebsite, domainFromEmail } =
  clientRegistry._internal;

ok('registry: keys clients by the sheet id, derives nickname + domain', () => {
  const rows = [
    ['id', 'name', 'color', 'status', 'email', 'phone', 'website', 'is_deleted'],
    ['CLI-002', 'Lockton Companies LLC', '#2C91CF', 'active', '', '', 'https://global.lockton.com/us/en', '0']
  ];
  const clients = parseClients(rows);
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].key, 'CLI-002');           // keyed by stable id, not name
  assert.strictEqual(clients[0].name, 'Lockton Companies LLC');
  assert.ok(clients[0].aliases.includes('Lockton'));        // corporate suffixes stripped
  assert.ok(clients[0].emailDomains.includes('lockton.com')); // registrable domain from website
});

ok('registry: skips soft-deleted rows', () => {
  const rows = [
    ['id', 'name', 'status', 'is_deleted'],
    ['CLI-009', 'Gone Inc', 'active', '1'],
    ['CLI-010', 'Kept LLC', 'active', '0']
  ];
  const clients = parseClients(rows);
  assert.strictEqual(clients.length, 1);
  assert.strictEqual(clients[0].key, 'CLI-010');
});

ok('registry: honors an explicit aliases column when present', () => {
  const rows = [
    ['id', 'name', 'status', 'aliases'],
    ['CLI-011', 'Contoso Corporation', 'active', 'Contoso, CTS']
  ];
  const clients = parseClients(rows);
  assert.ok(clients[0].aliases.includes('CTS'));
  assert.ok(clients[0].aliases.includes('Contoso'));
});

ok('registry: Contacts tab yields per-client domains', () => {
  const rows = [
    ['id', 'client_id', 'first_name', 'last_name', 'email'],
    ['CON-1', 'CLI-002', 'Stacy', 'Warren', 'stacy.warren@lockton.com'],
    ['CON-2', 'CLI-003', 'David', 'Keyes', 'david@rfortherestofus.com']
  ];
  const byClient = contactDomainsByClient(rows);
  assert.ok(byClient.get('CLI-002').has('lockton.com'));
  assert.ok(byClient.get('CLI-003').has('rfortherestofus.com'));
});

ok('registry: free-mail addresses are ignored as domains', () => {
  assert.strictEqual(domainFromEmail('someone@gmail.com'), 'gmail.com'); // extracted...
  const rows = [['id', 'client_id', 'email'], ['CON-3', 'CLI-004', 'freelancer@gmail.com']];
  assert.strictEqual(contactDomainsByClient(rows).has('CLI-004'), false); // ...but not used
});

ok('registry: domain + alias helpers', () => {
  assert.strictEqual(domainFromWebsite('https://indievisual.tech/'), 'indievisual.tech');
  assert.deepStrictEqual(deriveAliases('Acme Corp', []), ['Acme']);
});

console.log(`\n${passed} checks passed.`);
