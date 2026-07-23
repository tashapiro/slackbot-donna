// services/quickbooksTokenStore.js — durable storage for the QuickBooks Online OAuth2 tokens.
//
// THIS IS THE ONLY MODULE THAT TOUCHES THE qbo_tokens TABLE. QBO is Donna's first integration
// that uses OAuth2 with a *rotating* refresh token (Intuit re-issues the refresh token on every
// refresh and the old one eventually stops working), so unlike every other service — which reads
// a static key from an env var — QBO needs somewhere durable to keep a token that changes over
// time. `.env` can't (it's static) and the in-memory dataStore is wiped on every Render restart,
// so it lives in Postgres, reusing the same DATABASE_URL as services/memoryStore.js.
//
// Defensive, exactly like memoryStore: with no DATABASE_URL (or no `pg`), isEnabled() is false and
// the QuickBooks tools report "not configured" — the bot runs exactly as before. Single business
// (IndieVisual) ⇒ effectively one row, keyed by realm_id.
//
//   qbo_tokens(realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (err) {
  console.warn('⚠️ pg not available; QBO token store disabled:', err.message);
}

let pool = null;
let initPromise = null;

function connectionString() {
  return process.env.DATABASE_URL || '';
}

/** Render (and most hosted PG) need SSL for external connections; local doesn't. */
function sslOption(connStr) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  if (/@(localhost|127\.0\.0\.1)/.test(connStr)) return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!Pool || !connectionString()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      ssl: sslOption(connectionString()),
      max: 2
    });
    pool.on('error', err => console.error('QBO token store pool error:', err.message));
  }
  return pool;
}

/** True when a database is configured and the driver is present. */
function isEnabled() {
  return !!getPool();
}

/** Create the table if absent. Idempotent; safe to call repeatedly (runs once). */
function init() {
  if (!isEnabled()) return Promise.resolve(false);
  if (!initPromise) {
    initPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS qbo_tokens (
        realm_id           TEXT PRIMARY KEY,
        access_token       TEXT,
        access_expires_at  TIMESTAMPTZ,
        refresh_token      TEXT NOT NULL,
        refresh_expires_at TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).then(() => true).catch(err => {
      console.error('quickbooksTokenStore.init failed:', err.message);
      initPromise = null; // allow a later retry
      return false;
    });
  }
  return initPromise;
}

async function ensureReady() {
  if (!isEnabled()) throw new Error('QBO token store is not configured (set DATABASE_URL).');
  await init();
}

/** Load the stored token row for a realm, or null if none is stored yet. */
async function load(realmId) {
  if (!isEnabled()) return null;
  await init();
  const res = await getPool().query('SELECT * FROM qbo_tokens WHERE realm_id = $1', [realmId]);
  return res.rows[0] || null;
}

/**
 * Upsert the token row. Called after every refresh so the ROTATED refresh token is never lost —
 * losing it means re-doing the manual OAuth seed. refresh_token is required (the durable secret);
 * access_token / expiries may be null (e.g. to force a refresh on the next call).
 */
async function save({ realmId, accessToken = null, accessExpiresAt = null, refreshToken, refreshExpiresAt = null }) {
  await ensureReady();
  if (!realmId) throw new Error('save requires a realmId.');
  if (!refreshToken) throw new Error('save requires a refreshToken.');
  const res = await getPool().query(
    `INSERT INTO qbo_tokens (realm_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (realm_id) DO UPDATE SET
       access_token       = EXCLUDED.access_token,
       access_expires_at  = EXCLUDED.access_expires_at,
       refresh_token      = EXCLUDED.refresh_token,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       updated_at         = now()
     RETURNING *`,
    [realmId, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt]
  );
  return res.rows[0];
}

module.exports = {
  isEnabled,
  init,
  load,
  save,
  // exported for offline tests
  _internal: { sslOption }
};
