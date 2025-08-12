// app.js — Enhanced Donna with Thread Conversation Tracking & Modular Services + Timezone Support
require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');

// Enhanced architecture imports
const IntentClassifier = require('./utils/intentClassifier');
const dataStore = require('./utils/dataStore');
const ErrorHandler = require('./utils/errorHandler');

// Service imports
const savvyCalService = require('./services/savvycal');
const togglService = require('./services/toggl');
const asanaService = require('./services/asana');
const googleCalendarService = require('./services/googleCalendar');

// Handler imports
const schedulingHandler = require('./handlers/scheduling');
const timeTrackingHandler = require('./handlers/timeTracking');
const projectHandler = require('./handlers/projects');
const calendarHandler = require('./handlers/calendar');

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Configuration
// ─────────────────────────────────────────────────────────────────────────────
const SOCKET_MODE = String(process.env.SOCKET_MODE).toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SAVVYCAL_TOKEN = (process.env.SAVVYCAL_TOKEN || '').trim();

const AGENT_MODE = String(process.env.AGENT_MODE).toLowerCase() === 'true';

// Validation
const must = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SAVVYCAL_TOKEN'];
if (SOCKET_MODE) must.push('SLACK_APP_TOKEN');
const missing = must.filter(k => !process.env[k] || !String(process.env[k]).trim());
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}

console.log(`[env] Mode=${SOCKET_MODE ? 'Socket' : 'HTTP'} • Agent=${AGENT_MODE ? 'on' : 'off'} • Port=${PORT}`);

// Initialize enhanced intent classifier
const intentClassifier = new IntentClassifier();

// ─────────────────────────────────────────────────────────────────────────────
// Bolt app initialization (dual mode)
// ─────────────────────────────────────────────────────────────────────────────
let app;
if (SOCKET_MODE) {
  app = new App({
    token: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: SLACK_APP_TOKEN
  });
} else {
  const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
  receiver.router.use((req, _res, next) => { console.log(`[http] ${req.method} ${req.url}`); next(); });
  receiver.router.get('/', (_req, res) => res.send('OK'));
  app = new App({ token: SLACK_BOT_TOKEN, receiver });
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread conversation tracking
// ─────────────────────────────────────────────────────────────────────────────

// Track which threads Donna is actively participating in
function markThreadAsActive(channel, thread_ts, userId) {
  const threadKey = `${channel}::${thread_ts}`;
  dataStore.setThreadData(channel, thread_ts, { 
    donnaActive: true, 
    startedBy: userId,
    lastActivity: Date.now()
  });
  console.log(`Donna is now active in thread: ${threadKey}`);
}

function isThreadActive(channel, thread_ts) {
  if (!thread_ts) return false; // Not a thread
  const threadData = dataStore.getThreadData(channel, thread_ts);
  
  // Check if thread is active and not too old (24 hours)
  const isActive = threadData.donnaActive === true;
  const isRecent = threadData.lastActivity && (Date.now() - threadData.lastActivity) < 24 * 60 * 60 * 1000;
  
  return isActive && isRecent;
}

function isDirectMessage(channel) {
  // Direct message channels start with 'D' in Slack
  return channel.startsWith('D');
}

function updateThreadActivity(channel, thread_ts) {
  if (thread_ts && isThreadActive(channel, thread_ts)) {
    dataStore.setThreadData(channel, thread_ts, { lastActivity: Date.now() });
  }
}

function deactivateThread(channel, thread_ts) {
  if (thread_ts) {
    dataStore.setThreadData(channel, thread_ts, { donnaActive: false });
    console.log(`Donna left thread: ${channel}::${thread_ts}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Donna's personality helpers
// ─────────────────────────────────────────────────────────────────────────────

// Donna's signature opening lines (rotate for variety)
const donnaOpeningLines = [
  "You're here for answers. Lucky for you, I already have them.",
  "Let's skip the small talk — what's the real problem?",
  "Before you ask, yes, I've already thought of that.",
  "You clearly need my help. Good thing I'm Donna.",
  "I could tell you you're in good hands… but you already know that.",
  "Alright, let's cut to the chase — what are we solving today?",
  "I read people for a living. You're no exception."
];

function getRandomOpeningLine() {
  return donnaOpeningLines[Math.floor(Math.random() * donnaOpeningLines.length)];
}

// Simple question handler for basic queries
function handleSimpleQuestions(text) {
  const lowerText = text.toLowerCase().trim();
  
  // Handle greetings with opening lines
  if (lowerText.match(/^(hi|hello|hey|good morning|good afternoon|donna|what's up|how are you)$/)) {
    return getRandomOpeningLine();
  }
  
  // Only handle very specific time/date queries that don't need personality
  if (lowerText.match(/what time is it|current time|time right now/)) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', { 
      timeZone: 'America/New_York',
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    const dateString = now.toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
    return `It's ${timeString} ET on ${dateString}. I'm Donna. That's the whole explanation.`;
  }
  
  if (lowerText.match(/what.*date|today.*date|current date/)) {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      year: 'numeric',
      month: 'long', 
      day: 'numeric'
    });
    return `Today is ${today}. I already took care of knowing that for you.`;
  }
  
  return null; // Let LLM handle everything else for more natural conversation
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent routing - UPDATED with userId parameter
// ─────────────────────────────────────────────────────────────────────────────

async function handleIntent(intent, slots, client, channel, thread_ts, response = '', userId) {
  const params = { slots, client, channel, thread_ts, userId }; // ADDED userId
  
  switch (intent) {
    // SavvyCal/Scheduling intents
    case 'schedule_oneoff':
      await ErrorHandler.wrapHandler(schedulingHandler.handleCreateSchedulingLink.bind(schedulingHandler), 'SavvyCal')(params);
      break;
      
    case 'disable_link':
      await ErrorHandler.wrapHandler(schedulingHandler.handleDisableLink.bind(schedulingHandler), 'SavvyCal')(params);
      break;

    case 'list_links':
      await ErrorHandler.wrapHandler(schedulingHandler.handleListLinks.bind(schedulingHandler), 'SavvyCal')(params);
      break;

    case 'get_link':
      await ErrorHandler.wrapHandler(schedulingHandler.handleGetLink.bind(schedulingHandler), 'SavvyCal')(params);
      break;

    case 'delete_link':
      await ErrorHandler.wrapHandler(schedulingHandler.handleDeleteLink.bind(schedulingHandler), 'SavvyCal')(params);
      break;
      
    // Time tracking intents
    case 'log_time':
      await ErrorHandler.wrapHandler(timeTrackingHandler.handleTimeLog.bind(timeTrackingHandler), 'Toggl')(params);
      break;
      
    case 'query_time':
      await ErrorHandler.wrapHandler(timeTrackingHandler.handleTimeQuery.bind(timeTrackingHandler), 'Toggl')(params);
      break;
      
    // Project management intents
    case 'list_tasks':
      await ErrorHandler.wrapHandler(projectHandler.handleListTasks.bind(projectHandler), 'Asana')(params);
      break;
      
    case 'list_projects':
      await ErrorHandler.wrapHandler(projectHandler.handleListProjects.bind(projectHandler), 'Asana')(params);
      break;
      
    case 'debug_tasks':
      await ErrorHandler.wrapHandler(projectHandler.handleDebugTasks.bind(projectHandler), 'Asana')(params);
      break;
      
    case 'update_task':
      await ErrorHandler.wrapHandler(projectHandler.handleUpdateTask.bind(projectHandler), 'Asana')(params);
      break;
      
    case 'create_task':
      await ErrorHandler.wrapHandler(projectHandler.handleCreateTask.bind(projectHandler), 'Asana')(params);
      break;
      
    case 'complete_task':
      // Handle as a specific case of update_task
      await ErrorHandler.wrapHandler(async (params) => {
        const { slots } = params;
        const updateParams = {
          ...params,
          slots: { ...slots, field: 'completed', value: 'true' }
        };
        await projectHandler.handleUpdateTask(updateParams);
      }, 'Asana')(params);
      break;
      
    case 'daily_rundown':
      await ErrorHandler.wrapHandler(async ({ client, channel, thread_ts, userId }) => {
        const rundown = await projectHandler.generateDailyRundown();
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: rundown
        });
      }, 'Asana')(params);
      break;
      
    // Calendar intents - NOW WITH TIMEZONE SUPPORT
    case 'check_calendar':
      await ErrorHandler.wrapHandler(calendarHandler.handleCheckCalendar.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    case 'create_meeting':
      await ErrorHandler.wrapHandler(calendarHandler.handleCreateMeeting.bind(calendarHandler), 'Google Calendar')(params);
      break;

    case 'block_time':
      await ErrorHandler.wrapHandler(calendarHandler.handleBlockTime.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    case 'update_meeting':
      await ErrorHandler.wrapHandler(calendarHandler.handleUpdateMeeting.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    case 'delete_meeting':
      await ErrorHandler.wrapHandler(calendarHandler.handleDeleteMeeting.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    case 'next_meeting':
      await ErrorHandler.wrapHandler(calendarHandler.handleNextMeeting.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    case 'calendar_rundown':
      await ErrorHandler.wrapHandler(calendarHandler.handleCalendarRundown.bind(calendarHandler), 'Google Calendar')(params);
      break;
      
    // General conversation
    case 'general_chat':
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: response || "You clearly need my help. Good thing I'm Donna."
      });
      break;
      
    default:
      // Use a random opening line for unknown requests
      const openingLine = getRandomOpeningLine();
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `${openingLine}\n\nI handle scheduling, time tracking, task management, calendar management, and pretty much everything else.`
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main message processing function - UPDATED with userId support
// ─────────────────────────────────────────────────────────────────────────────

// Handle both mention and regular message processing
async function processDonnaMessage(text, event, client, logger, isMention = true) {
  const { channel, user, ts, thread_ts } = event;
  
  // Determine where to respond based on context
  let responseThreadTs = thread_ts;
  
  // For channel mentions (not DMs), always respond in a thread
  if (isMention && !isDirectMessage(channel) && !thread_ts) {
    responseThreadTs = ts; // Create a thread under the original message
    markThreadAsActive(channel, responseThreadTs, user);
    console.log(`Creating new thread under message ${ts} in channel ${channel} for user ${user}`);
  }
  
  // For existing threads, mark as active if it's a mention
  if (isMention && responseThreadTs && responseThreadTs !== ts) {
    markThreadAsActive(channel, responseThreadTs, user);
  }
  
  // Update activity for active threads or DMs
  if (responseThreadTs) {
    updateThreadActivity(channel, responseThreadTs);
  }

  const contextInfo = isDirectMessage(channel) ? 'DM' : 
                     responseThreadTs ? `thread: ${responseThreadTs}` : 'channel';
  logger.info(`${isMention ? 'mention' : 'message'}: "${text}" from user ${user} in ${channel} (${contextInfo})`);

  // Handle empty mentions or just "Donna" with opening lines
  if (!text || text.length === 0) {
    return client.chat.postMessage({
      channel,
      thread_ts: responseThreadTs,
      text: getRandomOpeningLine()
    });
  }

  // Handle simple greetings with opening lines first
  const simpleResponse = handleSimpleQuestions(text);
  if (simpleResponse) {
    return client.chat.postMessage({
      channel,
      thread_ts: responseThreadTs,
      text: simpleResponse
    });
  }

  // Check for exit commands in threads (not DMs)
  if (responseThreadTs && !isDirectMessage(channel) && text.match(/^(bye|goodbye|thanks|thank you|done|exit|leave)$/i)) {
    deactivateThread(channel, responseThreadTs);
    const exitResponses = [
      "I'm always here when you need me.",
      "You know where to find me.",
      "Call me when you need the best.",
      "I already took care of everything else.",
      "My work here is done."
    ];
    const exitResponse = exitResponses[Math.floor(Math.random() * exitResponses.length)];
    return client.chat.postMessage({
      channel,
      thread_ts: responseThreadTs,
      text: exitResponse
    });
  }

  // Fast path for very specific, unambiguous commands only
  if (text.match(/^what projects|^list projects|^show.*projects$/i)) {
    await ErrorHandler.wrapHandler(projectHandler.handleListProjects.bind(projectHandler), 'Asana')({
      slots: {}, client, channel, thread_ts: responseThreadTs, userId: user
    });
    return;
  }

  // Fast path for exact scheduling commands (backward compatibility)
  const strict = text.match(/^schedule\s+"([^"]+)"\s+(\d{1,3})$/i);
  if (strict) {
    const [, title, minutesStr] = strict;
    const minutes = parseInt(minutesStr, 10);

    await client.chat.postMessage({ channel, thread_ts: responseThreadTs, text: 'Already on it. This is what I do.' });
    try {
      const { url, id } = await savvyCalService.createSingleUseLink(title, minutes);
      dataStore.setThreadData(channel, responseThreadTs, { last_link_id: id });
      return client.chat.postMessage({ 
        channel, 
        thread_ts: responseThreadTs, 
        text: `Done. ${url}\n\nI already took care of it. You're welcome.` 
      });
    } catch (e) {
      logger.error(e);
      return ErrorHandler.handleApiError(e, client, channel, responseThreadTs, 'SavvyCal');
    }
  }

  // Let the LLM handle everything else with intelligent classification

  // Enhanced agentic path
  if (!AGENT_MODE || !intentClassifier.llm) {
    return client.chat.postMessage({
      channel, 
      thread_ts: responseThreadTs,
      text: 'My AI brain is taking a coffee break, but I can still handle the basics. Try: `schedule "Meeting name" 30` or `log time for ProjectName 2 hours`'
    });
  }

  try {
    const context = dataStore.getThreadData(channel, responseThreadTs);
    const routed = await intentClassifier.classify({ text, context });

    // Handle missing information
    if (!routed.intent && routed.missing?.length) {
      // Add some Donna flair to clarification requests
      const clarificationPrefixes = [
        "Let's skip the small talk — ",
        "Before you ask, yes, I've already thought of that. But ",
        "I read people for a living. You're no exception. ",
        "",  // Sometimes just be direct
        ""
      ];
      const prefix = clarificationPrefixes[Math.floor(Math.random() * clarificationPrefixes.length)];
      
      return client.chat.postMessage({
        channel, 
        thread_ts: responseThreadTs,
        text: `${prefix}${routed.missing[0]}`
      });
    }

    // Route to appropriate handler WITH userId
    await handleIntent(routed.intent, routed.slots, client, channel, responseThreadTs, routed.response, user);
    
  } catch (error) {
    logger.error('Enhanced message handler error:', error);
    await ErrorHandler.handleApiError(error, client, channel, responseThreadTs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command (using new service)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/schedule', async ({ command, ack, respond }) => {
  await ack();

  const m = command.text.match(/^"([^"]+)"\s+(\d{1,3})$/);
  if (!m) return respond('Usage: `/schedule "Meeting name" 30`');

  const [, title, minutesStr] = m;
  const minutes = parseInt(minutesStr, 10);

  try {
    const { url, id } = await savvyCalService.createSingleUseLink(title, minutes);
    dataStore.setThreadData(command.channel_id, command.thread_ts || command.trigger_id, { last_link_id: id });

    await respond({
      text: url,
      blocks: schedulingHandler.createSchedulingBlocks(title, minutes, url, id)
    });
  } catch (e) {
    await respond(`Couldn't create it: ${e.message}`);
  }
});

// Interactive button handlers
app.action('sc_disable', async ({ ack, body, client }) => {
  await ack();
  const linkId = body.actions?.[0]?.value;
  try {
    await savvyCalService.toggleLink(linkId);
    await client.chat.postMessage({
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      text: '✅ Disabled.'
    });
  } catch (e) {
    await client.chat.postMessage({
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      text: `Couldn't disable: ${e.message}`
    });
  }
});

app.action('sc_details', async ({ ack, body, client }) => {
  await ack();
  const linkId = body.actions?.[0]?.value;
  try {
    await schedulingHandler.handleGetLink({
      slots: { link_id: linkId },
      client,
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      userId: body.user?.id
    });
  } catch (e) {
    await client.chat.postMessage({
      channel: body.channel?.id || body.user?.id,
      thread_ts: body.message?.ts,
      text: `Couldn't get details: ${e.message}`
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers - UPDATED to pass userId
// ─────────────────────────────────────────────────────────────────────────────

// Handle @mentions (always respond)
app.event('app_mention', async ({ event, client, logger }) => {
  const raw = event.text || '';
  const text = raw.replace(/<@[^>]+>\s*/g, '').trim();
  await processDonnaMessage(text, event, client, logger, true);
});

// Handle regular messages 
app.event('message', async ({ event, client, logger }) => {
  // Skip bot messages
  if (event.bot_id) {
    return;
  }
  
  // Skip messages that are mentions (already handled by app_mention)
  if (event.text && event.text.includes('<@')) {
    return;
  }

  const isDM = isDirectMessage(event.channel);
  const isActiveThread = event.thread_ts && isThreadActive(event.channel, event.thread_ts);
  
  // Respond if it's a DM or an active thread
  if (isDM || isActiveThread) {
    const text = event.text || '';
    await processDonnaMessage(text, event, client, logger, false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup and startup
// ─────────────────────────────────────────────────────────────────────────────

// Periodic cleanup of cached data
setInterval(() => {
  dataStore.cleanupCache();
}, 3600000); // Every hour

(async () => {
  await app.start(PORT);
  console.log(`⚡ Donna Paulsen is now online in ${SOCKET_MODE ? 'Socket' : 'HTTP'} mode on :${PORT}`);
  console.log('💼 Managing: Scheduling, Time Tracking, Task Management, Calendar & Your Entire Professional Life');
  console.log('🌍 Now with timezone-aware calendar support - respecting every user\'s local time');
  
  // Test API connections on startup
  try {
    await savvyCalService.getLinks();
    console.log('✅ SavvyCal connection verified - Scheduling handled');
  } catch (error) {
    console.warn('⚠️ SavvyCal connection failed:', error.message);
  }

  try {
    await togglService.getWorkspaces();
    console.log('✅ Toggl connection verified - Time tracking handled');
  } catch (error) {
    console.warn('⚠️ Toggl connection failed:', error.message);
  }

  try {
    await asanaService.getWorkspaces();
    console.log('✅ Asana connection verified - Tasks under control');
  } catch (error) {
    console.warn('⚠️ Asana connection failed:', error.message);
  }
  
  try {
    await googleCalendarService.getCalendarInfo();
    console.log('✅ Google Calendar connection verified - Meetings managed');
  } catch (error) {
    console.warn('⚠️ Google Calendar connection failed:', error.message);
  }
  
  console.log('🎯 I\'m Donna. That\'s the whole explanation. Let\'s get to work.');
})();