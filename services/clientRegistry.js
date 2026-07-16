// services/clientRegistry.js — the client registry, sourced from the user's Google Sheet.
//
// The Sheet is the source of truth for clients/projects (see docs/roadmap.md → Phase 2).
// This module reads it via services/googleSheets.js and turns the rows into a normalized
// registry: one { key, name, aliases[], asanaProject, emailDomain, status } per client.
//
// Column mapping is CONFIG-DRIVEN, not hard-coded — the user's headers may differ from the
// roadmap's suggested layout. We detect each logical field by matching the header row against
// a set of accepted names (case-insensitive, punctuation-insensitive), overridable per field
// via env (CLIENT_REGISTRY_COL_*). This makes the resolver robust to the actual sheet.
//
// Results are cached briefly (via dataStore's cache) so we don't hit Sheets on every message.
// Defensive: with no sheet configured/available, getClients() returns [] and the rest of the
// system treats "no client" as the default — nothing breaks.

const sheets = require('./googleSheets');
const dataStore = require('../utils/dataStore');

const CACHE_KEY = 'client_registry';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Accepted header names per logical field (normalized: lowercased, non-alphanumerics stripped).
const FIELD_ALIASES = {
  name: ['client', 'clientname', 'name', 'company', 'account'],
  aliases: ['aliases', 'alias', 'aka', 'othernames', 'abbreviations', 'nicknames', 'shortnames'],
  asanaProject: ['asanaproject', 'asana', 'project', 'asanaprojectname', 'projectname'],
  emailDomain: ['emaildomain', 'emaildomains', 'domain', 'domains', 'email'],
  status: ['status', 'state', 'active', 'archived']
};

// Optional per-field header override from env, e.g. CLIENT_REGISTRY_COL_NAME="Account".
const ENV_OVERRIDES = {
  name: 'CLIENT_REGISTRY_COL_NAME',
  aliases: 'CLIENT_REGISTRY_COL_ALIASES',
  asanaProject: 'CLIENT_REGISTRY_COL_ASANA',
  emailDomain: 'CLIENT_REGISTRY_COL_DOMAIN',
  status: 'CLIENT_REGISTRY_COL_STATUS'
};

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Turn a display name into a stable namespace key (the memory client_key). */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Split an aliases cell on common separators. */
function parseAliases(cell) {
  return String(cell || '')
    .split(/[,;|\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** A client is "active" unless the status cell clearly marks it archived/inactive. */
function isActiveStatus(statusCell) {
  const s = String(statusCell || '').toLowerCase().trim();
  if (!s) return true; // blank status → treat as active
  return !/(archiv|inactive|disabled|closed|former|dormant|paused)/.test(s) && s !== 'no' && s !== 'false';
}

/**
 * Map the header row to column indexes for each logical field.
 * @param {string[]} headerRow
 * @returns {Object} { name: idx|-1, aliases, asanaProject, emailDomain, status }
 */
function mapColumns(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  const map = {};
  for (const field of Object.keys(FIELD_ALIASES)) {
    // 1) explicit env override wins
    const override = process.env[ENV_OVERRIDES[field]];
    if (override) {
      const idx = normalized.indexOf(normalizeHeader(override));
      map[field] = idx; // may be -1 if the named header isn't present
      continue;
    }
    // 2) otherwise detect by accepted header names
    let idx = -1;
    for (const accepted of FIELD_ALIASES[field]) {
      idx = normalized.indexOf(accepted);
      if (idx !== -1) break;
    }
    map[field] = idx;
  }
  return map;
}

/**
 * Parse raw sheet rows (including the header row) into client objects.
 * @param {Array<Array<string>>} rows
 * @returns {Array<{key,name,aliases,asanaProject,emailDomain,status}>}
 */
function parseRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const [header, ...body] = rows;
  const cols = mapColumns(header);
  if (cols.name === -1) {
    console.warn('⚠️ Client registry: no recognizable client-name column in the sheet header ' +
      `(${header.join(', ')}). Set CLIENT_REGISTRY_COL_NAME to the right header.`);
    return [];
  }
  const at = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] : '');
  const clients = [];
  for (const row of body) {
    const name = at(row, cols.name).trim();
    if (!name) continue;
    clients.push({
      key: slugify(name),
      name,
      aliases: parseAliases(at(row, cols.aliases)),
      asanaProject: at(row, cols.asanaProject).trim(),
      emailDomain: at(row, cols.emailDomain).toLowerCase().trim(),
      status: at(row, cols.status).trim()
    });
  }
  return clients;
}

/** True when a registry sheet is configured and the Sheets client can read it. */
function isEnabled() {
  return !!process.env.CLIENT_REGISTRY_SHEET_ID && sheets.isEnabled();
}

/**
 * Load the registry (cached). Never throws — logs and returns [] on failure so a
 * bad/absent sheet can't take Donna down.
 * @param {boolean} [force] bypass the cache
 * @returns {Promise<Array>} client objects (possibly empty)
 */
async function getClients(force = false) {
  if (!isEnabled()) return [];
  if (!force) {
    const cached = dataStore.getCachedData(CACHE_KEY, CACHE_TTL_MS);
    if (cached) return cached;
  }
  try {
    const range = process.env.CLIENT_REGISTRY_SHEET_RANGE || 'A:Z';
    const rows = await sheets.getRows(process.env.CLIENT_REGISTRY_SHEET_ID, range);
    const clients = parseRows(rows);
    dataStore.setCachedData(CACHE_KEY, clients);
    return clients;
  } catch (err) {
    console.error('Client registry load failed:', err.message);
    return [];
  }
}

/** Active clients only (status not archived/inactive). */
async function getActiveClients(force = false) {
  const clients = await getClients(force);
  return clients.filter(c => isActiveStatus(c.status));
}

/** Look up a client by its canonical key. */
async function findByKey(key) {
  if (!key) return null;
  const clients = await getClients();
  return clients.find(c => c.key === key) || null;
}

module.exports = {
  isEnabled,
  getClients,
  getActiveClients,
  findByKey,
  // exported for offline tests
  _internal: { parseRows, mapColumns, slugify, parseAliases, isActiveStatus, normalizeHeader }
};
