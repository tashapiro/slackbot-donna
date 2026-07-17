// services/clientRegistry.js — the client registry, sourced from the user's Google Sheet.
//
// The Sheet (the "IndieVisual Hub") is a small relational CRM. This module reads the `Clients`
// tab (and, for detection, the `Contacts` tab) via services/googleSheets.js and turns the rows
// into a normalized registry: one client per row, keyed by the sheet's own stable id (CLI-001),
// with derived nicknames and email domains for matching.
//
// Design notes for THIS sheet (see docs/roadmap.md → Phase 2):
//   • Canonical key = the `id` column (CLI-xxx) — rename-proof, and the join key the sheet itself
//     uses (Projects.client_id, Contacts.client_id). The display name is `name`.
//   • There is no aliases column, and names are formal ("Lockton Companies LLC"), so we AUTO-DERIVE
//     nicknames by stripping corporate suffixes ("Lockton"). An explicit `aliases` column is
//     honored too if you add one.
//   • Email domains for detection are derived from `website` + `email` and, per client, from the
//     `Contacts` tab's emails (e.g. anything @lockton.com → Lockton). Free-mail domains are ignored.
//   • Column headers are auto-detected and each is overridable via env (CLIENT_REGISTRY_COL_*).
//
// Cached ~5 min. Defensive: with no sheet configured/available, getClients() returns [] and the
// rest of the system treats "no client" as the default — nothing breaks.

const sheets = require('./googleSheets');
const dataStore = require('../utils/dataStore');

const CACHE_KEY = 'client_registry';
const CACHE_TTL_MS = 5 * 60 * 1000;

// Header detection: logical field → accepted header names (normalized: lowercased, non-alnum stripped).
const CLIENT_FIELD_ALIASES = {
  id: ['id', 'clientid'],
  name: ['name', 'client', 'clientname', 'company', 'account'],
  status: ['status', 'state'],
  aliases: ['aliases', 'alias', 'aka', 'nicknames', 'othernames', 'abbreviations'],
  website: ['website', 'url', 'site', 'web'],
  email: ['email', 'emailaddress'],
  isDeleted: ['isdeleted', 'deleted']
};
const CLIENT_ENV = {
  id: 'CLIENT_REGISTRY_COL_ID',
  name: 'CLIENT_REGISTRY_COL_NAME',
  status: 'CLIENT_REGISTRY_COL_STATUS',
  aliases: 'CLIENT_REGISTRY_COL_ALIASES',
  website: 'CLIENT_REGISTRY_COL_WEBSITE',
  email: 'CLIENT_REGISTRY_COL_EMAIL',
  isDeleted: 'CLIENT_REGISTRY_COL_DELETED'
};

const CONTACT_FIELD_ALIASES = {
  clientId: ['clientid', 'client'],
  email: ['email', 'emailaddress']
};
const CONTACT_ENV = {
  clientId: 'CLIENT_REGISTRY_CONTACTS_COL_CLIENTID',
  email: 'CLIENT_REGISTRY_CONTACTS_COL_EMAIL'
};

// Trailing tokens stripped when deriving a nickname from a formal name.
const CORP_SUFFIXES = new Set([
  'llc', 'llc.', 'inc', 'inc.', 'incorporated', 'ltd', 'ltd.', 'limited', 'llp', 'lp',
  'co', 'co.', 'corp', 'corp.', 'corporation', 'company', 'companies', 'group', 'holdings',
  'gmbh', 'pllc', 'pc', 'pbc', 'sa', 'ag', 'plc'
]);

// Ignored as detection domains — too generic to identify a client.
const FREEMAIL = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'live.com', 'msn.com', 'me.com'
]);

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function truthyFlag(v) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

/** A client is "active" unless status clearly marks it archived/inactive. */
function isActiveStatus(statusCell) {
  const s = String(statusCell || '').toLowerCase().trim();
  if (!s) return true;
  return !/(archiv|inactive|disabled|closed|former|dormant|paused|lost|churn)/.test(s) && s !== 'no' && s !== 'false';
}

/** Reduce a host/domain to its registrable form (last two labels; www stripped). */
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').trim();
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

function domainFromWebsite(url) {
  if (!url) return '';
  let s = String(url).trim().replace(/^https?:\/\//i, '').replace(/^\/\//, '');
  s = s.split(/[\/?#]/)[0].split('@').pop();
  return s.includes('.') ? registrableDomain(s) : '';
}

function domainFromEmail(email) {
  if (!email || !String(email).includes('@')) return '';
  return registrableDomain(String(email).split('@').pop());
}

/** Derive nickname aliases from a formal name by stripping trailing corporate suffixes. */
function deriveAliases(name, explicit) {
  const out = new Set();
  for (const a of explicit || []) if (a && a.trim()) out.add(a.trim());
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  let end = tokens.length;
  while (end > 1 && CORP_SUFFIXES.has(tokens[end - 1].toLowerCase().replace(/[.,]/g, ''))) end--;
  const core = tokens.slice(0, end).join(' ');
  if (core && core.toLowerCase() !== String(name).toLowerCase()) out.add(core);
  return [...out];
}

function parseAliasesCell(cell) {
  return String(cell || '').split(/[,;|\n]+/).map(s => s.trim()).filter(Boolean);
}

/** Map a header row to column indexes for the given field→aliases spec, honoring env overrides. */
function mapColumns(headerRow, fieldAliases, envMap) {
  const normalized = (headerRow || []).map(normalizeHeader);
  const map = {};
  for (const field of Object.keys(fieldAliases)) {
    const override = envMap && envMap[field] && process.env[envMap[field]];
    if (override) { map[field] = normalized.indexOf(normalizeHeader(override)); continue; }
    let idx = -1;
    for (const accepted of fieldAliases[field]) { idx = normalized.indexOf(accepted); if (idx !== -1) break; }
    map[field] = idx;
  }
  return map;
}

/**
 * Parse the Clients tab into client objects (no Contacts join yet).
 * @param {Array<Array<string>>} rows  including the header row.
 */
function parseClients(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const [header, ...body] = rows;
  const cols = mapColumns(header, CLIENT_FIELD_ALIASES, CLIENT_ENV);
  if (cols.name === -1) {
    console.warn('⚠️ Client registry: no client-name column found in the Clients header ' +
      `(${header.join(', ')}). Set CLIENT_REGISTRY_COL_NAME.`);
    return [];
  }
  const at = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] : '');
  const clients = [];
  for (const row of body) {
    const name = at(row, cols.name).trim();
    if (!name) continue;
    if (cols.isDeleted !== -1 && truthyFlag(at(row, cols.isDeleted))) continue;

    const id = at(row, cols.id).trim();
    const explicit = parseAliasesCell(at(row, cols.aliases));
    const domains = new Set();
    const wd = domainFromWebsite(at(row, cols.website));
    const ed = domainFromEmail(at(row, cols.email));
    if (wd && !FREEMAIL.has(wd)) domains.add(wd);
    if (ed && !FREEMAIL.has(ed)) domains.add(ed);

    clients.push({
      id: id || null,
      key: id || slugify(name),
      name,
      aliases: deriveAliases(name, explicit),
      emailDomains: [...domains],
      asanaProject: '', // per-project mapping lives in the Projects tab; wired in a later phase
      status: at(row, cols.status).trim()
    });
  }
  return clients;
}

/** Build a map of client_id → Set(domains) from the Contacts tab. */
function contactDomainsByClient(rows) {
  const map = new Map();
  if (!Array.isArray(rows) || rows.length < 2) return map;
  const [header, ...body] = rows;
  const cols = mapColumns(header, CONTACT_FIELD_ALIASES, CONTACT_ENV);
  if (cols.clientId === -1 || cols.email === -1) return map;
  const at = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] : '');
  for (const row of body) {
    const cid = at(row, cols.clientId).trim();
    const dom = domainFromEmail(at(row, cols.email));
    if (!cid || !dom || FREEMAIL.has(dom)) continue;
    if (!map.has(cid)) map.set(cid, new Set());
    map.get(cid).add(dom);
  }
  return map;
}

function sheetId() {
  return process.env.CLIENT_REGISTRY_SHEET_ID || '';
}

/** True when a registry sheet is configured and the Sheets client can read it. */
function isEnabled() {
  return !!sheetId() && sheets.isEnabled();
}

/**
 * Load the registry (cached). Never throws — logs and returns [] on failure so a bad/absent
 * sheet can't take Donna down.
 */
async function getClients(force = false) {
  if (!isEnabled()) return [];
  if (!force) {
    const cached = dataStore.getCachedData(CACHE_KEY, CACHE_TTL_MS);
    if (cached) return cached;
  }
  try {
    const clientsRange = process.env.CLIENT_REGISTRY_CLIENTS_RANGE ||
      process.env.CLIENT_REGISTRY_SHEET_RANGE || 'Clients';
    let clients = parseClients(await sheets.getRows(sheetId(), clientsRange));

    // Enrich with per-client email domains from the Contacts tab (set CONTACTS_RANGE="" to skip).
    const contactsRange = process.env.CLIENT_REGISTRY_CONTACTS_RANGE === undefined
      ? 'Contacts'
      : process.env.CLIENT_REGISTRY_CONTACTS_RANGE;
    if (contactsRange) {
      try {
        const byClient = contactDomainsByClient(await sheets.getRows(sheetId(), contactsRange));
        clients = clients.map(c => {
          const extra = c.id && byClient.get(c.id);
          if (!extra) return c;
          return { ...c, emailDomains: [...new Set([...c.emailDomains, ...extra])] };
        });
      } catch (err) {
        console.warn('Client registry: Contacts read failed (domains from Clients tab only):', err.message);
      }
    }

    dataStore.setCachedData(CACHE_KEY, clients);
    return clients;
  } catch (err) {
    console.error('Client registry load failed:', err.message);
    return [];
  }
}

async function getActiveClients(force = false) {
  const clients = await getClients(force);
  return clients.filter(c => isActiveStatus(c.status));
}

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
  _internal: {
    parseClients, contactDomainsByClient, mapColumns, deriveAliases,
    domainFromWebsite, domainFromEmail, registrableDomain, isActiveStatus, slugify
  }
};
