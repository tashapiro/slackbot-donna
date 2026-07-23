// handlers/comms.js — preview-then-confirm flows for the Phase 3 comms tools:
//   1. Email drafts (Gmail)         — draft_email tool stages a draft; user confirms → Gmail draft.
//   2. Notetaker on a call (Fred)   — toggle_notetaker tool stages an add/remove; user confirms →
//                                      the Fireflies notetaker guest is added to / removed from the
//                                      matching Google Calendar event.
//
// Both mirror the existing pending-action pattern (see handlers/scheduling.js): the tool posts one
// of these cards and stashes a `pending_*` object in dataStore; the matching app.action handler
// calls the confirm/cancel method here. Nothing touches Gmail or the calendar until the user clicks.

const dataStore = require('../utils/dataStore');
const gmailService = require('../services/gmail');
const googleCalendarService = require('../services/googleCalendar');

class CommsHandler {
  // ── Email drafts ───────────────────────────────────────────────────────────

  // Preview card for a staged email draft. `pending` =
  //   { to:[], cc:[], subject, body, meetingTitle }
  buildEmailDraftBlocks(pending, stableTs) {
    const to = (pending.to || []).join(', ');
    const cc = pending.cc && pending.cc.length ? `\n*Cc:* ${pending.cc.join(', ')}` : '';
    const ctx = pending.meetingTitle ? `\n_Follow-up to: ${pending.meetingTitle}_` : '';
    const body = pending.body || '';
    // Render the body the way it'll look in the email: **bold** → Slack *bold*, so the preview
    // matches the sent draft (Slack needs & < > escaped to show literally).
    const clipped = body.length > 2800 ? body.slice(0, 2800) + '\n… (truncated in preview)' : body;
    const preview = clipped
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '*$1*');
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Draft email*${ctx}\n\n*To:* ${to || '(no recipients)'}${cc}\n*Subject:* ${pending.subject || '(no subject)'}`
        }
      },
      { type: 'section', text: { type: 'mrkdwn', text: preview } },
      { type: 'section', text: { type: 'mrkdwn', text: "I'll save this as a Gmail draft — nothing gets sent." } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Save draft' }, style: 'primary', action_id: 'donna_create_draft', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, style: 'danger', action_id: 'donna_cancel_draft', value: stableTs }
        ]
      }
    ];
  }

  async confirmPendingEmailDraft({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_email_draft;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That draft already cleared out — nothing pending to save.'
      });
    }
    try {
      const draft = await gmailService.createDraft({
        to: pending.to,
        cc: pending.cc,
        subject: pending.subject,
        body: pending.body
      });
      dataStore.setThreadData(channel, thread_ts, {
        pending_email_draft: null,
        last_action: 'created_email_draft',
        last_action_time: Date.now()
      });
      const who = draft.to.join(', ');
      await client.chat.postMessage({
        channel, thread_ts,
        text: `✅ Draft saved to Gmail — *${pending.subject || '(no subject)'}* to ${who}.\n${draft.webLink}\n\nReview and send it whenever you're ready.`
      });
    } catch (error) {
      console.error('Confirm email draft error:', error);
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't save the draft: ${error.message}` });
    }
  }

  async cancelPendingEmailDraft({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_email_draft: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Scrapped it — no draft saved.' });
  }

  // ── Notetaker (Fred) on a calendar event ─────────────────────────────────────

  // Confirm card for adding/removing the notetaker. `pending` =
  //   { action:'add'|'remove', eventId, eventSummary, eventWhen, notetakerEmail, attendees:[] }
  buildNotetakerToggleBlocks(pending, stableTs) {
    const verb = pending.action === 'remove' ? 'Remove' : 'Add';
    const prep = pending.action === 'remove' ? 'from' : 'to';
    const when = pending.eventWhen ? ` (${pending.eventWhen})` : '';
    const consequence = pending.action === 'remove'
      ? "Fireflies won't join this meeting."
      : 'Fireflies will join and record this meeting.';
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${verb} *Fred* (${pending.notetakerEmail}) ${prep} *${pending.eventSummary}*${when}?\n${consequence}`
        }
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: `${verb} Fred` }, style: pending.action === 'remove' ? 'danger' : 'primary', action_id: 'donna_notetaker_confirm', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'donna_notetaker_cancel', value: stableTs }
        ]
      }
    ];
  }

  async confirmPendingNotetaker({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_notetaker;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That already cleared out — nothing pending to confirm.'
      });
    }
    try {
      const email = pending.notetakerEmail.toLowerCase();
      const current = Array.isArray(pending.attendees) ? pending.attendees : [];
      const others = current.filter(a => (a.email || '').toLowerCase() !== email);
      let newAttendees;
      if (pending.action === 'remove') {
        newAttendees = others;
      } else {
        newAttendees = others.concat([{ email: pending.notetakerEmail }]);
      }
      await googleCalendarService.updateEvent(pending.eventId, {
        attendees: newAttendees.map(a => ({ email: a.email }))
      });
      dataStore.setThreadData(channel, thread_ts, {
        pending_notetaker: null,
        last_action: `notetaker_${pending.action}`,
        last_action_time: Date.now()
      });
      const text = pending.action === 'remove'
        ? `✅ Removed Fred from *${pending.eventSummary}*. Fireflies won't join.`
        : `✅ Added Fred to *${pending.eventSummary}*. Fireflies will record it.`;
      await client.chat.postMessage({ channel, thread_ts, text });
    } catch (error) {
      console.error('Confirm notetaker toggle error:', error);
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't update the meeting: ${error.message}` });
    }
  }

  async cancelPendingNotetaker({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_notetaker: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Left the meeting as-is — nothing changed.' });
  }
}

module.exports = new CommsHandler();
