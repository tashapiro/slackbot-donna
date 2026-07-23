// handlers/billing.js — preview-then-confirm flows for the QuickBooks invoice tools.
//   1. Create invoice — propose_invoice stages a full Invoice payload; user confirms → QBO invoice.
//   2. Edit invoice   — edit_invoice fetches + mutates the live invoice; user confirms → QBO update.
//
// Same pattern as handlers/comms.js: the tool stashes a `pending_*` object in dataStore and posts
// one of these cards; the matching app.action handler calls the confirm/cancel method here. Nothing
// touches QuickBooks until the user clicks — money movement always gets an explicit OK.

const dataStore = require('../utils/dataStore');
const quickbooksService = require('../services/quickbooks');

function money(n) {
  const v = Number(n) || 0;
  return `$${v.toFixed(2)}`;
}

// Render a set of {description, quantity, rate} lines as Slack bullet lines.
function lineLines(lines) {
  return (lines || []).map(l => {
    const qty = Number(l.quantity) || 1;
    const rate = Number(l.rate) || 0;
    const amt = Math.round(qty * rate * 100) / 100;
    return `• ${l.description || '(item)'} — ${qty} × ${money(rate)} = ${money(amt)}`;
  }).join('\n');
}

class BillingHandler {
  // ── Create invoice ───────────────────────────────────────────────────────────

  // Preview card for a staged new invoice. `pending` =
  //   { customerName, lines:[{description,quantity,rate}], total, dueDate, memo, payload }
  buildInvoicePreviewBlocks(pending, stableTs) {
    const due = pending.dueDate ? `\n*Due:* ${pending.dueDate}` : '';
    const memo = pending.memo ? `\n*Memo:* ${pending.memo}` : '';
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New invoice*\n*Customer:* ${pending.customerName}${due}${memo}`
        }
      },
      { type: 'section', text: { type: 'mrkdwn', text: `${lineLines(pending.lines) || '(no line items)'}\n\n*Total: ${money(pending.total)}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Nothing is created in QuickBooks until you confirm.' } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Create invoice' }, style: 'primary', action_id: 'donna_invoice_confirm', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, style: 'danger', action_id: 'donna_invoice_cancel', value: stableTs }
        ]
      }
    ];
  }

  async confirmPendingInvoice({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_invoice;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That invoice already cleared out — nothing pending to create.'
      });
    }
    try {
      const inv = await quickbooksService.createInvoice(pending.payload);
      dataStore.setThreadData(channel, thread_ts, {
        pending_invoice: null,
        last_action: 'created_invoice',
        last_action_time: Date.now()
      });
      const num = inv.DocNumber ? `#${inv.DocNumber}` : `(id ${inv.Id})`;
      const total = inv.TotalAmt != null ? money(inv.TotalAmt) : money(pending.total);
      await client.chat.postMessage({
        channel, thread_ts,
        text: `✅ Invoice ${num} created for *${pending.customerName}* — ${total}.\n${quickbooksService.invoiceUrl(inv.Id)}`
      });
    } catch (error) {
      console.error('Confirm invoice error:', error);
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't create the invoice: ${error.message}` });
    }
  }

  async cancelPendingInvoice({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_invoice: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Scrapped it — no invoice created.' });
  }

  // ── Edit invoice ─────────────────────────────────────────────────────────────

  // Preview card for a staged invoice edit. `pending` =
  //   { invoiceLabel, customerName, changeSummary, newTotal, payload }
  buildInvoiceEditPreviewBlocks(pending, stableTs) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Edit invoice ${pending.invoiceLabel}*${pending.customerName ? ` — ${pending.customerName}` : ''}`
        }
      },
      { type: 'section', text: { type: 'mrkdwn', text: `${pending.changeSummary}\n\n*New total: ${money(pending.newTotal)}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: 'The invoice in QuickBooks changes only when you confirm.' } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Save changes' }, style: 'primary', action_id: 'donna_invoice_edit_confirm', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, style: 'danger', action_id: 'donna_invoice_edit_cancel', value: stableTs }
        ]
      }
    ];
  }

  async confirmPendingInvoiceEdit({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_invoice_edit;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That edit already cleared out — nothing pending to save.'
      });
    }
    try {
      const inv = await quickbooksService.updateInvoice(pending.payload);
      dataStore.setThreadData(channel, thread_ts, {
        pending_invoice_edit: null,
        last_action: 'edited_invoice',
        last_action_time: Date.now()
      });
      const num = inv.DocNumber ? `#${inv.DocNumber}` : `(id ${inv.Id})`;
      const total = inv.TotalAmt != null ? money(inv.TotalAmt) : money(pending.newTotal);
      await client.chat.postMessage({
        channel, thread_ts,
        text: `✅ Invoice ${num} updated — ${total}.\n${quickbooksService.invoiceUrl(inv.Id)}`
      });
    } catch (error) {
      console.error('Confirm invoice edit error:', error);
      // A 400 here is usually a stale SyncToken (someone else touched the invoice). Say so plainly.
      const hint = /sync|stale|400/i.test(error.message)
        ? ' (the invoice may have changed in QuickBooks since I read it — ask me to try again)'
        : '';
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't update the invoice: ${error.message}${hint}` });
    }
  }

  async cancelPendingInvoiceEdit({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_invoice_edit: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Left the invoice as-is — nothing changed.' });
  }
}

module.exports = new BillingHandler();
