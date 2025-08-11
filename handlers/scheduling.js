// handlers/scheduling.js - Handle scheduling-related intents
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
      
      // Store link ID for potential future disable requests
      dataStore.setThreadData(channel, thread_ts, { last_link_id: id });
      
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
      
      // Clear the stored link ID since it's now deleted
      dataStore.setThreadData(channel, thread_ts, { last_link_id: null });
      
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
}

module.exports = new SchedulingHandler();