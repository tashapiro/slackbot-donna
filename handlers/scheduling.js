// handlers/scheduling.js - Handle scheduling-related intents with enhanced context storage
const savvyCalService = require('../services/savvycal');
const dataStore = require('../utils/dataStore');

class SchedulingHandler {
  // Handle creating single-use scheduling links
  async handleCreateSchedulingLink({ slots, client, channel, thread_ts }) {
    try {
      const { title, minutes } = slots;
      
      if (!title || !minutes) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a title and duration. Try: `schedule "Meeting with John" 30` or `schedule "Project sync" 45`'
        });
      }

      // Validate and clean up inputs
      const validatedDuration = savvyCalService.validateDuration(minutes);
      const cleanTitle = savvyCalService.generateLinkTitle(title, validatedDuration);

      // Send initial "working on it" message
      await client.chat.postMessage({ 
        channel, 
        thread_ts, 
        text: 'Already on it. This is what I do.' 
      });
      
      // Create the link
      const { url, id } = await savvyCalService.createSingleUseLink(cleanTitle, validatedDuration);
      
      // Store comprehensive link context for future reference and AI awareness
      dataStore.setThreadData(channel, thread_ts, { 
        last_link_id: id, 
        last_link_url: url,
        last_link_title: cleanTitle,
        last_link_duration: validatedDuration,
        last_action: 'created_scheduling_link',
        last_action_time: Date.now(),
        // Additional context that might be useful
        link_created_at: new Date().toISOString(),
        link_type: 'single_use'
      });
      
      console.log(`Created scheduling link: ${cleanTitle} (${validatedDuration} min) - ${url}`);
      console.log(`Stored context for thread ${channel}::${thread_ts}`);
      
      // Send success message
      await client.chat.postMessage({ 
        channel, 
        thread_ts, 
        text: `Done. ${url}\n\nI already took care of it. You're welcome.` 
      });
      
    } catch (error) {
      console.error('Create scheduling link error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't create that link: ${error.message}`
      });
    }
  }

  // Handle disabling/toggling links
  async handleDisableLink({ slots, client, channel, thread_ts }) {
    try {
      let { link_id } = slots;
      
      // If no link ID provided, try to use the last created link in this thread
      if (!link_id) {
        const threadData = dataStore.getThreadData(channel, thread_ts);
        link_id = threadData.last_link_id;
        
        if (!link_id) {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: 'Which link should I disable? I don\'t see any recent links in this conversation.'
          });
        }
      }

      await savvyCalService.toggleLink(link_id);
      
      // Update thread context to reflect the action
      const threadData = dataStore.getThreadData(channel, thread_ts);
      dataStore.setThreadData(channel, thread_ts, {
        ...threadData,
        last_action: 'disabled_scheduling_link',
        last_action_time: Date.now(),
        link_disabled_at: new Date().toISOString()
      });
      
      await client.chat.postMessage({ 
        channel, 
        thread_ts, 
        text: '✅ Disabled. Please. I\'ve handled worse before breakfast.' 
      });
      
    } catch (error) {
      console.error('Disable link error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't disable that link: ${error.message}`
      });
    }
  }

  // Handle listing all links
  async handleListLinks({ client, channel, thread_ts }) {
    try {
      const links = await savvyCalService.getLinks();
      
      if (links.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'No SavvyCal links found. Want me to create one?'
        });
      }

      let message = '*Your SavvyCal links:*\n\n';
      
      links.slice(0, 10).forEach((link, index) => {
        const url = savvyCalService.buildUrlFrom(link);
        const status = link.enabled ? '🟢' : '🔴';
        message += `${index + 1}. ${status} *${link.name}*\n`;
        message += `   ${url}\n`;
        if (link.description) {
          message += `   _${link.description}_\n`;
        }
        message += '\n';
      });

      if (links.length > 10) {
        message += `_...and ${links.length - 10} more_`;
      }

      // Update thread context to remember this action
      dataStore.setThreadData(channel, thread_ts, {
        last_action: 'listed_scheduling_links',
        last_action_time: Date.now(),
        total_links_count: links.length
      });

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message.trim()
      });
      
    } catch (error) {
      console.error('List links error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't fetch your links: ${error.message}`
      });
    }
  }

  // Handle getting link details
  async handleGetLink({ slots, client, channel, thread_ts }) {
    try {
      let { link_id } = slots;
      
      // If no link ID provided, try to use the last created link in this thread
      if (!link_id) {
        const threadData = dataStore.getThreadData(channel, thread_ts);
        link_id = threadData.last_link_id;
        
        if (!link_id) {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: 'Which link do you want details for? I don\'t see any recent links in this conversation.'
          });
        }
      }

      const link = await savvyCalService.getLink(link_id);
      const url = savvyCalService.buildUrlFrom(link);
      const status = link.enabled ? '🟢 Active' : '🔴 Disabled';
      
      let message = `*Link Details:*\n\n`;
      message += `**${link.name}**\n`;
      message += `Status: ${status}\n`;
      message += `URL: ${url}\n`;
      
      if (link.description) {
        message += `Description: ${link.description}\n`;
      }
      
      if (link.durations && link.durations.length > 0) {
        message += `Durations: ${link.durations.join(', ')} minutes\n`;
      }
      
      if (link.default_duration) {
        message += `Default: ${link.default_duration} minutes\n`;
      }

      // Update thread context
      dataStore.setThreadData(channel, thread_ts, {
        last_action: 'viewed_link_details',
        last_action_time: Date.now(),
        viewed_link_id: link_id
      });

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Get link error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't get details for that link: ${error.message}`
      });
    }
  }

  // Handle deleting links
  async handleDeleteLink({ slots, client, channel, thread_ts }) {
    try {
      let { link_id } = slots;
      
      // If no link ID provided, try to use the last created link in this thread
      if (!link_id) {
        const threadData = dataStore.getThreadData(channel, thread_ts);
        link_id = threadData.last_link_id;
        
        if (!link_id) {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: 'Which link should I delete? I don\'t see any recent links in this conversation.'
          });
        }
      }

      await savvyCalService.deleteLink(link_id);
      
      // Clear the stored link ID since it's now deleted, but keep record of the action
      const threadData = dataStore.getThreadData(channel, thread_ts);
      dataStore.setThreadData(channel, thread_ts, { 
        ...threadData,
        last_link_id: null,
        last_link_url: null,
        last_action: 'deleted_scheduling_link',
        last_action_time: Date.now(),
        deleted_link_id: link_id,
        deleted_at: new Date().toISOString()
      });
      
      await client.chat.postMessage({ 
        channel, 
        thread_ts, 
        text: '🗑️ Link deleted. Gone. Like it never existed.' 
      });
      
    } catch (error) {
      console.error('Delete link error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't delete that link: ${error.message}`
      });
    }
  }

  // ── Agentic confirm flows (used by the Claude Tool Runner brain) ─────────────
  // Creating a link is direct; disabling/deleting a link or poll, and sending a
  // poll, go through a Confirm/Cancel card. The tool stages the pending action in
  // dataStore and posts one of the cards below; the matching app.action handler
  // calls the confirm method here.

  // Confirm card for a guarded link/poll action (disable link, delete link,
  // delete poll). `pending` = { kind, id, name }.
  buildScActionConfirmBlocks(pending, stableTs) {
    const what = pending.kind === 'delete_poll' ? 'poll' : 'link';
    const verb = pending.kind === 'disable_link' ? 'Disable' : 'Delete';
    const name = pending.name ? `*${pending.name}*` : `this ${what}`;
    const consequence = pending.kind === 'disable_link'
      ? 'It stops taking new bookings — you can re-enable it anytime.'
      : "This can't be undone.";
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `${verb} ${name}? ${consequence}` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: verb }, style: 'danger', action_id: 'sc_action_confirm', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'sc_action_cancel', value: stableTs }
        ]
      }
    ];
  }

  // Execute the staged link/poll action (triggered by the Confirm button).
  async confirmPendingScAction({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_sc_action;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That already cleared out — nothing pending to confirm.'
      });
    }
    try {
      let text;
      if (pending.kind === 'disable_link') {
        await savvyCalService.toggleLink(pending.id);
        text = `✅ Disabled ${pending.name ? `*${pending.name}*` : 'that link'}. Toggle it back whenever.`;
      } else if (pending.kind === 'delete_link') {
        await savvyCalService.deleteLink(pending.id);
        text = `🗑️ Deleted ${pending.name ? `*${pending.name}*` : 'that link'}. Gone.`;
      } else if (pending.kind === 'delete_poll') {
        await savvyCalService.deletePoll(pending.id);
        text = `🗑️ Deleted the poll ${pending.name ? `*${pending.name}*` : ''}.`.trim();
      } else {
        text = 'I lost track of what to confirm — mind asking again?';
      }
      dataStore.setThreadData(channel, thread_ts, {
        pending_sc_action: null,
        last_action: pending.kind,
        last_action_time: Date.now(),
        ...(pending.kind === 'delete_link' ? { last_link_id: null, last_link_url: null } : {})
      });
      await client.chat.postMessage({ channel, thread_ts, text });
    } catch (error) {
      console.error('Confirm SavvyCal action error:', error);
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't do that: ${error.message}` });
    }
  }

  // Cancel a staged link/poll action.
  async cancelPendingScAction({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_sc_action: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Left it as-is — nothing changed.' });
  }

  // Preview card for a scheduling poll before it's created/sent.
  // `pending` = { name, durationMinutes, slots:[{start_at,end_at}], attendees:[] }.
  buildPollPreviewBlocks(pending, stableTs, timezone) {
    const fmt = iso => {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone
      });
    };
    const slotLines = (pending.slots || [])
      .map((s, i) => `${i + 1}. ${fmt(s.start_at || s.start)}`)
      .join('\n');
    let detail = `*${pending.name}* · ${pending.durationMinutes} min\n\n*Proposed times:*\n${slotLines}`;
    if (pending.attendees && pending.attendees.length) {
      detail += `\n\n*People:* ${pending.attendees.join(', ')}`;
    }
    const hasPeople = pending.attendees && pending.attendees.length;
    const sendLabel = hasPeople ? 'Send poll' : 'Create poll';
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*Scheduling poll:*\n\n${detail}` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: sendLabel }, style: 'primary', action_id: 'sc_poll_send', value: stableTs },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, style: 'danger', action_id: 'sc_poll_cancel', value: stableTs }
        ]
      }
    ];
  }

  // Create + send the staged poll (triggered by the Send button).
  async confirmPendingScPoll({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const pending = threadData.pending_sc_poll;
    if (!pending) {
      return await client.chat.postMessage({
        channel, thread_ts, text: 'That poll already cleared out — nothing pending to send.'
      });
    }
    try {
      const { id, url, slotCount, invited } = await savvyCalService.createPoll({
        name: pending.name,
        durationMinutes: pending.durationMinutes,
        slots: pending.slots,
        attendees: pending.attendees
      });
      dataStore.setThreadData(channel, thread_ts, {
        pending_sc_poll: null,
        last_poll_id: id || null,
        last_action: 'created_scheduling_poll',
        last_action_time: Date.now()
      });
      let msg = `✅ Poll *${pending.name}* is live with ${slotCount} time${slotCount === 1 ? '' : 's'} to vote on.`;
      if (invited) msg += ` Invited ${invited} ${invited === 1 ? 'person' : 'people'}.`;
      if (url) msg += `\n${url}`;
      if (!invited && url) msg += `\n\nShare that link with the group so they can vote.`;
      await client.chat.postMessage({ channel, thread_ts, text: msg });
    } catch (error) {
      console.error('Confirm poll error:', error);
      await client.chat.postMessage({ channel, thread_ts, text: `Couldn't create the poll: ${error.message}` });
    }
  }

  // Cancel a staged poll.
  async cancelPendingScPoll({ client, channel, thread_ts }) {
    dataStore.setThreadData(channel, thread_ts, { pending_sc_poll: null });
    await client.chat.postMessage({ channel, thread_ts, text: 'Scrapped the poll — nothing sent.' });
  }

  // Generate scheduling blocks for Slack interactive components
  createSchedulingBlocks(title, minutes, url, linkId) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*All set.*\n*${title}* (${minutes} min)\n${url}`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Disable link' },
            value: linkId,
            action_id: 'sc_disable',
            style: 'danger'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Get details' },
            value: linkId,
            action_id: 'sc_details'
          }
        ]
      }
    ];
  }

  // Helper method to get recent scheduling activity context
  getRecentSchedulingContext(channel, thread_ts) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    
    // Check if there's recent scheduling activity (within last 10 minutes)
    if (threadData.last_action_time && (Date.now() - threadData.last_action_time) < 600000) {
      return {
        hasRecentActivity: true,
        lastAction: threadData.last_action,
        lastLinkId: threadData.last_link_id,
        lastLinkUrl: threadData.last_link_url,
        lastLinkTitle: threadData.last_link_title,
        minutesSinceAction: Math.floor((Date.now() - threadData.last_action_time) / 60000)
      };
    }
    
    return {
      hasRecentActivity: false
    };
  }
}

module.exports = new SchedulingHandler();