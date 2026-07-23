#!/usr/bin/env node
// Offline behavioral checks for the Phase 5 QuickBooks invoice tools — no network, no Slack.
//
// The quickbooks service singleton is monkeypatched: isEnabled() forced true and the network
// methods (findCustomer/findItem/createInvoice/getInvoice/findInvoiceByNumber/updateInvoice/
// listInvoices) replaced with fakes that record calls and return canned data. That lets us assert
// the *tool + confirm-flow logic* — which method fires, what invoice payload is built and staged,
// and that nothing hits QuickBooks before the user confirms — without reaching Intuit's API (which
// the build sandbox can't, and which needs the real OAuth seed anyway). The live end-to-end check
// (sandbox realm on Render) is documented in docs/README.md / docs/quickbooks-design.md.
//
// Run via `npm run check:qbo` (also runs inside `npm test`).

const assert = require('assert');
const quickbooksService = require('../services/quickbooks');
const tokenStore = require('../services/quickbooksTokenStore');
const dataStore = require('../utils/dataStore');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`✓ ${name}`); })
    .catch(err => { console.error(`✗ ${name}\n  ${err.message}`); process.exitCode = 1; });
}

// ── Assert the defensive gate BEFORE monkeypatching ──────────────────────────
// With no DATABASE_URL in the sandbox, the token store is disabled, so QuickBooks is disabled.
const gateStartsClosed = quickbooksService.isEnabled() === false && tokenStore.isEnabled() === false;

// ── Test doubles ─────────────────────────────────────────────────────────────
const calls = [];
const CUSTOMERS = { 'Acme Co': { Id: 'C1', DisplayName: 'Acme Co' } };
const ITEMS = { services: { Id: 'I1', Name: 'Services' }, design: { Id: 'I2', Name: 'Design' } };
const INVOICE = {
  Id: '42', SyncToken: '3', DocNumber: '1001',
  CustomerRef: { value: 'C1', name: 'Acme Co' },
  Line: [
    { Id: '1', DetailType: 'SalesItemLineDetail', Amount: 1500, Description: 'Consulting',
      SalesItemLineDetail: { ItemRef: { value: 'I1', name: 'Services' }, Qty: 10, UnitPrice: 150 } },
    { DetailType: 'SubTotalLineDetail', Amount: 1500, SubTotalLineDetail: {} }
  ],
  TotalAmt: 1500, Balance: 1500, DueDate: '2026-08-01'
};

quickbooksService.clientId = 'test-id';
quickbooksService.clientSecret = 'test-secret';
quickbooksService.realmId = 'R1';
quickbooksService.defaultItemName = 'Services';
quickbooksService.isEnabled = () => true;
quickbooksService.findCustomer = async (name) => { calls.push({ method: 'findCustomer', args: [name] }); return CUSTOMERS[name] || null; };
quickbooksService.findItem = async (name) => { calls.push({ method: 'findItem', args: [name] }); return ITEMS[String(name).toLowerCase()] || null; };
quickbooksService.createInvoice = async (payload) => { calls.push({ method: 'createInvoice', args: [payload] }); return { ...payload, Id: '99', DocNumber: '1002', TotalAmt: quickbooksService.constructor.lineTotal((payload.Line || []).map(l => ({ quantity: l.SalesItemLineDetail.Qty, rate: l.SalesItemLineDetail.UnitPrice }))) }; };
quickbooksService.getInvoice = async (id) => { calls.push({ method: 'getInvoice', args: [id] }); return JSON.parse(JSON.stringify(INVOICE)); };
quickbooksService.findInvoiceByNumber = async (n) => { calls.push({ method: 'findInvoiceByNumber', args: [n] }); return n === INVOICE.DocNumber ? JSON.parse(JSON.stringify(INVOICE)) : null; };
quickbooksService.updateInvoice = async (payload) => { calls.push({ method: 'updateInvoice', args: [payload] }); return { ...payload, TotalAmt: 2000 }; };
quickbooksService.listInvoices = async (opts) => { calls.push({ method: 'listInvoices', args: [opts] }); return [INVOICE]; };

// buildTools requires the (patched) service, so load after patching.
const { buildTools } = require('../utils/donnaTools');
const billingHandler = require('../handlers/billing');

const posted = [];
const client = { chat: { postMessage: async (m) => { posted.push(m); return { ok: true }; } } };
const CH = 'C_TEST';
const TS = 'T_TEST';

function freshThread() {
  dataStore.setThreadData(CH, TS, { pending_invoice: null, pending_invoice_edit: null });
}
const baseTools = buildTools({ client, channel: CH, thread_ts: TS, userId: 'U1' });
const clientTools = buildTools({ client, channel: CH, thread_ts: TS, userId: 'U1', activeClient: { key: 'CLI-1', name: 'Acme Co' }, clientStatus: 'confident' });
const tool = (set, name) => {
  const t = set.find(x => x.name === name);
  if (!t) throw new Error(`tool "${name}" not registered`);
  return t;
};

async function main() {
  await ok('defensive gate: QuickBooks disabled without DATABASE_URL', () => {
    assert.ok(gateStartsClosed, 'quickbooks + token store should report disabled before config');
  });

  await ok('all 4 QuickBooks tools are registered', () => {
    ['list_invoices', 'get_invoice', 'propose_invoice', 'edit_invoice'].forEach(n => tool(baseTools, n));
  });

  // ── Pure payload builders ────────────────────────────────────────────────────
  await ok('buildInvoicePayload maps customer, lines, item refs, and amounts', () => {
    const payload = quickbooksService.constructor.buildInvoicePayload(
      { Id: 'C1', DisplayName: 'Acme Co' },
      [{ description: 'Design', quantity: 10, rate: 150, item: { Id: 'I2', Name: 'Design' } }],
      { dueDate: '2026-08-01', memo: 'Thanks' }
    );
    assert.deepStrictEqual(payload.CustomerRef, { value: 'C1', name: 'Acme Co' });
    assert.strictEqual(payload.Line[0].Amount, 1500);
    assert.strictEqual(payload.Line[0].SalesItemLineDetail.ItemRef.value, 'I2');
    assert.strictEqual(payload.Line[0].SalesItemLineDetail.Qty, 10);
    assert.strictEqual(payload.DueDate, '2026-08-01');
    assert.strictEqual(payload.CustomerMemo.value, 'Thanks');
  });

  await ok('lineTotal sums quantity × rate to 2dp', () => {
    assert.strictEqual(quickbooksService.constructor.lineTotal([{ quantity: 3, rate: 99.99 }, { quantity: 1, rate: 0.02 }]), 299.99);
  });

  await ok('invoiceUrl points at the sandbox app by default', () => {
    assert.match(quickbooksService.invoiceUrl('42'), /app\.sandbox\.qbo\.intuit\.com\/app\/invoice\?txnId=42/);
  });

  await ok('_esc escapes single quotes in SQL literals', () => {
    assert.strictEqual(quickbooksService.constructor._esc("O'Brien"), "O\\'Brien");
  });

  // ── list / get reads ─────────────────────────────────────────────────────────
  await ok('list_invoices formats number, customer, total, status', async () => {
    calls.length = 0;
    const res = await tool(baseTools, 'list_invoices').run({ client: 'Acme Co' });
    assert.ok(calls.find(c => c.method === 'findCustomer'), 'resolves the customer first');
    assert.match(res, /#1001/);
    assert.match(res, /\$1500\.00/);
  });

  await ok('get_invoice by number shows line items and balance', async () => {
    const res = await tool(baseTools, 'get_invoice').run({ invoice_number: '1001' });
    assert.match(res, /#1001/);
    assert.match(res, /Consulting/);
    assert.match(res, /Total: \$1500\.00/);
    assert.match(res, /Balance: \$1500\.00/);
  });

  // ── propose_invoice (create) ──────────────────────────────────────────────────
  await ok('propose_invoice stages payload + posts card, does NOT create', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    const res = await tool(baseTools, 'propose_invoice').run({
      customer: 'Acme Co',
      line_items: [{ description: 'Consulting', quantity: 10, rate: 150 }],
      due_date: '2026-08-01'
    });
    const p = dataStore.getThreadData(CH, TS).pending_invoice;
    assert.ok(p, 'pending_invoice staged');
    assert.strictEqual(p.customerName, 'Acme Co');
    assert.strictEqual(p.total, 1500);
    assert.strictEqual(p.payload.CustomerRef.value, 'C1');
    assert.strictEqual(p.payload.Line[0].SalesItemLineDetail.ItemRef.value, 'I1', 'defaults to the Services item');
    assert.ok(posted[posted.length - 1].blocks, 'a preview card is posted');
    assert.ok(!calls.some(c => c.method === 'createInvoice'), 'must NOT create before confirm');
    assert.match(res, /do not claim it is created yet/);
  });

  await ok('propose_invoice defaults the customer to the active client', async () => {
    freshThread();
    await tool(clientTools, 'propose_invoice').run({ line_items: [{ description: 'Retainer', rate: 2000 }] });
    const p = dataStore.getThreadData(CH, TS).pending_invoice;
    assert.strictEqual(p.customerName, 'Acme Co', 'active client used when no customer named');
    assert.strictEqual(p.total, 2000);
  });

  await ok('propose_invoice with no customer and no active client asks which client', async () => {
    freshThread();
    const res = await tool(baseTools, 'propose_invoice').run({ line_items: [{ description: 'x', rate: 10 }] });
    assert.match(res, /Which client/i);
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice, null, 'nothing staged');
  });

  await ok('propose_invoice with an unknown customer does not stage', async () => {
    freshThread();
    const res = await tool(baseTools, 'propose_invoice').run({ customer: 'Nobody Inc', line_items: [{ description: 'x', rate: 10 }] });
    assert.match(res, /No QuickBooks customer/);
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice, null);
  });

  await ok('propose_invoice with an unknown item reports it and does not stage', async () => {
    freshThread();
    const res = await tool(baseTools, 'propose_invoice').run({
      customer: 'Acme Co',
      line_items: [{ description: 'Special', rate: 10, item: 'Nonexistent' }]
    });
    assert.match(res, /aren't in QuickBooks/);
    assert.match(res, /Nonexistent/);
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice, null);
  });

  await ok('confirm invoice → createInvoice fires with the staged payload, pending cleared', async () => {
    freshThread(); calls.length = 0;
    const payload = quickbooksService.constructor.buildInvoicePayload(
      { Id: 'C1', DisplayName: 'Acme Co' }, [{ description: 'Consulting', quantity: 10, rate: 150, item: { Id: 'I1', Name: 'Services' } }], {});
    dataStore.setThreadData(CH, TS, { pending_invoice: { customerName: 'Acme Co', lines: [], total: 1500, payload } });
    await billingHandler.confirmPendingInvoice({ client, channel: CH, thread_ts: TS });
    const call = calls.find(c => c.method === 'createInvoice');
    assert.ok(call, 'createInvoice should fire on confirm');
    assert.strictEqual(call.args[0].CustomerRef.value, 'C1');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice, null, 'pending cleared');
  });

  await ok('cancel invoice clears pending without creating', async () => {
    freshThread(); calls.length = 0;
    dataStore.setThreadData(CH, TS, { pending_invoice: { customerName: 'Acme Co', payload: {} } });
    await billingHandler.cancelPendingInvoice({ client, channel: CH, thread_ts: TS });
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice, null);
    assert.ok(!calls.some(c => c.method === 'createInvoice'));
  });

  // ── edit_invoice ──────────────────────────────────────────────────────────────
  await ok('edit_invoice add line item stages full payload w/ Id+SyncToken, does NOT update', async () => {
    freshThread(); calls.length = 0; posted.length = 0;
    const res = await tool(baseTools, 'edit_invoice').run({
      invoice_number: '1001',
      changes: { add_line_items: [{ description: 'Extra work', quantity: 1, rate: 500 }] }
    });
    const p = dataStore.getThreadData(CH, TS).pending_invoice_edit;
    assert.ok(p, 'pending_invoice_edit staged');
    assert.strictEqual(p.payload.Id, '42', 'Id preserved for read-modify-write');
    assert.strictEqual(p.payload.SyncToken, '3', 'SyncToken preserved');
    // Subtotal line dropped, original sales line kept, new line appended.
    assert.ok(!p.payload.Line.some(l => l.DetailType === 'SubTotalLineDetail'), 'subtotal line removed (QBO recomputes)');
    assert.strictEqual(p.payload.Line.length, 2, 'original sales line + 1 new');
    assert.strictEqual(p.newTotal, 2000, '1500 + 500');
    assert.ok(posted[posted.length - 1].blocks, 'edit preview posted');
    assert.ok(!calls.some(c => c.method === 'updateInvoice'), 'must NOT update before confirm');
    assert.match(res, /do not claim it is changed yet/);
  });

  await ok('edit_invoice due_date + memo changes are summarized', async () => {
    freshThread();
    await tool(baseTools, 'edit_invoice').run({ invoice_number: '1001', changes: { due_date: '2026-09-01', memo: 'Net 30' } });
    const p = dataStore.getThreadData(CH, TS).pending_invoice_edit;
    assert.strictEqual(p.payload.DueDate, '2026-09-01');
    assert.strictEqual(p.payload.CustomerMemo.value, 'Net 30');
    assert.match(p.changeSummary, /Due date/);
    assert.match(p.changeSummary, /Memo/);
  });

  await ok('edit_invoice with no changes does not stage', async () => {
    freshThread();
    const res = await tool(baseTools, 'edit_invoice').run({ invoice_number: '1001', changes: {} });
    assert.match(res, /No changes/);
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice_edit, null);
  });

  await ok('edit_invoice on a missing invoice reports not found', async () => {
    freshThread();
    const res = await tool(baseTools, 'edit_invoice').run({ invoice_number: '9999', changes: { memo: 'x' } });
    assert.match(res, /No invoice found/);
  });

  await ok('confirm edit → updateInvoice fires with the full object, pending cleared', async () => {
    freshThread(); calls.length = 0;
    const payload = { Id: '42', SyncToken: '3', DocNumber: '1001', CustomerRef: { value: 'C1', name: 'Acme Co' }, Line: [] };
    dataStore.setThreadData(CH, TS, { pending_invoice_edit: { invoiceLabel: '#1001', changeSummary: 'x', newTotal: 2000, payload } });
    await billingHandler.confirmPendingInvoiceEdit({ client, channel: CH, thread_ts: TS });
    const call = calls.find(c => c.method === 'updateInvoice');
    assert.ok(call, 'updateInvoice should fire on confirm');
    assert.strictEqual(call.args[0].Id, '42');
    assert.strictEqual(call.args[0].SyncToken, '3');
    assert.strictEqual(dataStore.getThreadData(CH, TS).pending_invoice_edit, null, 'pending cleared');
  });

  // ── Token store (pure bits; no live DB) ───────────────────────────────────────
  await ok('token store sslOption: off for localhost, on otherwise, forced by env', () => {
    const { sslOption } = tokenStore._internal;
    assert.strictEqual(sslOption('postgres://u:p@localhost:5432/db'), false);
    assert.deepStrictEqual(sslOption('postgres://u:p@db.render.com/x'), { rejectUnauthorized: false });
  });

  console.log(`\n${passed} checks passed.`);
}

main();
