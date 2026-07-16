// services/memoryStore.js — Donna's persistent, scope-isolated memory.
//
// THIS IS THE ONLY MODULE THAT TOUCHES THE DATABASE. That's deliberate: the client-isolation
// guarantee (never mix one client's context into another's — a confidentiality requirement,
// see docs/roadmap.md → Phase 2) lives HERE, in the storage layer, not in a prompt. Every read
// applies the scope filter, and it is not optional — no caller can widen it to read across
// clients. Donna is only ever *handed* the active scope's memory; she can't leak what she was
// never given.
//
// Storage: Postgres (Render Postgres), via `pg`, from DATABASE_URL. Defensive: with no
// DATABASE_URL (or no `pg`), isEnabled() is false and the memory tools report "not configured" —
// the bot runs exactly as before. Schema (from the roadmap):
//
//   memories(id, scope, client_key, kind, content, created_at, updated_at)
//     scope ∈ 'personal' | 'business' | 'client'
//     every read: WHERE scope = ? AND (scope <> 'client' OR client_key = ?)

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (err) {
  console.warn('⚠️ pg not available; persistent memory disabled:', err.message);
}

const VALID_SCOPES = ['personal', 'business', 'client'];

let pool = null;
let initPromise = null;

function connectionString() {
  return process.env.DATABASE_URL || '';
}

/** Render (and most hosted PG) need SSL for external connections; local doesn't. */
function sslOption(connStr) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  // Auto: enable SSL unless clearly a local connection.
  if (/@(localhost|127\.0\.0\.1)/.test(connStr)) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!Pool || !connectionString()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      ssl: sslOption(connectionString()),
      max: 3
    });
    pool.on('error', err => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

/** True when a database is configured and the driver is present. */
function isEnabled() {
  return !!getPool();
}

/** Create the table + index if absent. Idempotent; safe to call repeatedly (runs once). */
function init() {
  if (!isEnabled()) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS memories (
        id          BIGSERIAL PRIMARY KEY,
        scope       TEXT NOT NULL CHECK (scope IN ('personal','business','client')),
        client_key  TEXT,
        kind        TEXT,
        content     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_memories_scope_client ON memories (scope, client_key);
    `).then(() => true).catch(err => {
      console.error('memoryStore.init failed:', err.message);
      initPromise = null; // allow a later retry
      return false;
    });
  }
  return initPromise;
}

async function ensureReady() {
  if (!isEnabled()) throw new Error('Memory is not configured (set DATABASE_URL).');
  await init();
}

function assertScope(scope) {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(`Invalid memory scope "${scope}" (expected personal | business | client).`);
  }
}

/**
 * Store a memory. For scope='client' a client_key is REQUIRED and is the only place the row is
 * bound to a client; non-client rows never carry a client_key.
 * @returns {Promise<Object>} the inserted row.
 */
async function remember({ scope, client_key = null, kind = null, content }) {
  await ensureReady();
  assertScope(scope);
  if (!content || !String(content).trim()) throw new Error('Cannot remember empty content.');
  if (scope === 'client' && !client_key) throw new Error('Client-scoped memory requires a client_key.');
  const key = scope === 'client' ? client_key : null;
  const res = await getPool().query(
    `INSERT INTO memories (scope, client_key, kind, content)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [scope, key, kind, String(content).trim()]
  );
  return res.rows[0];
}

// ── The enforced scope filters (pure builders, exported for offline tests) ──────────────────

/** Single-scope read filter. For 'client', client_key is always constrained. */
function _buildScopeWhere({ scope, client_key = null }) {
  return {
    text: `scope = $1 AND (scope <> 'client' OR client_key = $2)`,
    values: [scope, client_key]
  };
}

/**
 * The "visible context" filter: personal + business-global + (only) the active client.
 * With client_key null, the client branch never matches (NULL comparison), so no client rows
 * leak — the safe default when no client is resolved.
 */
function _buildVisibleWhere({ client_key = null }) {
  return {
    text: `(scope = 'personal' OR scope = 'business' OR (scope = 'client' AND client_key = $1))`,
    values: [client_key]
  };
}

/**
 * Recall memories in a single scope. The scope filter is applied non-optionally.
 * @returns {Promise<Array>} rows, newest first.
 */
async function recall({ scope, client_key = null, kind = null, limit = 50 }) {
  await ensureReady();
  assertScope(scope);
  const where = _buildScopeWhere({ scope, client_key });
  const values = where.values.slice();
  let sql = `SELECT * FROM memories WHERE ${where.text}`;
  if (kind) { values.push(kind); sql += ` AND kind = $${values.length}`; }
  values.push(Math.min(Number(limit) || 50, 200));
  sql += ` ORDER BY updated_at DESC LIMIT $${values.length}`;
  const res = await getPool().query(sql, values);
  return res.rows;
}

/**
 * Recall everything Donna is allowed to see for the active context:
 * personal + business + (only) the active client's rows. This is the retrieval the brain uses.
 * @returns {Promise<Array>} rows, newest first.
 */
async function recallVisible({ client_key = null, kind = null, limit = 100 }) {
  await ensureReady();
  const where = _buildVisibleWhere({ client_key });
  const values = where.values.slice();
  let sql = `SELECT * FROM memories WHERE ${where.text}`;
  if (kind) { values.push(kind); sql += ` AND kind = $${values.length}`; }
  values.push(Math.min(Number(limit) || 100, 300));
  sql += ` ORDER BY scope, updated_at DESC LIMIT $${values.length}`;
  const res = await getPool().query(sql, values);
  return res.rows;
}

module.exports = {
  isEnabled,
  init,
  remember,
  recall,
  recallVisible,
  VALID_SCOPES,
  // exported for offline tests (scope-filter isolation checks without a live DB)
  _internal: { _buildScopeWhere, _buildVisibleWhere, sslOption }
};
