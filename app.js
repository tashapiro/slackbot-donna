// app.js — Enhanced Donna with Toggl time tracking integration
require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');

// Enhanced architecture imports
const IntentClassifier = require('./utils/intentClassifier');
const dataStore = require('./utils/dataStore');
const ErrorHandler = require('./utils/errorHandler');
const timeTrackingHandler = require('./handlers/timeTracking');
const projectHandler = require('./handlers/projects');
const togglService = require('./services/toggl');
const asanaService = require('./services/asana');

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Configuration
// ─────────────────────────────────────────────────────────────────────────────
const SOCKET_MODE = String(process.env.SOCKET_MODE).toLowerCase() === 'true';
const PORT = process.env.PORT || 3000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

const SAVVYCAL_TOKEN = (process.env.SAVVYCAL_TOKEN || '').trim();
const SAVVYCAL_SCOPE_SLUG = process.env.SAVVYCAL_SCOPE_SLUG;

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
// SavvyCal helpers (existing functionality)
// ─────────────────────────────────────────────────────────────────────────────
function buildUrlFrom(link, scope) {
  const slug = link.slug || '';
  if (link.url) return link.url;
  if (slug.includes('/')) return `https://savvycal.com/${slug}`;
  return scope ? `https://savvycal.com/${scope}/${slug}` : `https://savvycal.com/${slug}`;
}

async function createSingleUseLink(title, minutes) {
  const baseCreate = SAVVYCAL_SCOPE_SLUG
    ? `https://api.savvycal.com/v1/scopes/${SAVVYCAL_SCOPE_SLUG}/links`
    : `https://api.savvycal.com/v1/links`;

  const createRes = await fetch(baseCreate, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SAVVYCAL_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: title, type: 'single', description: `${minutes} min` })
  });
  
  const createText = await createRes.text();
  if (!createRes.ok) throw new Error(`SavvyCal create failed ${createRes.status}: ${createText}`);
  
  const created = JSON.parse(createText);
  const link = created.link || created;
  const url = buildUrlFrom(link, SAVVYCAL_SCOPE_SLUG);

  const patchRes = await fetch(`https://api.savvycal.com/v1/links/${link.id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SAVVYCAL_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ durations: [minutes], default_duration: minutes })
  });
  
  if (!patchRes.ok) {
    const t = await patchRes.text();
    throw new Error(`SavvyCal PATCH durations failed ${patchRes.status}: ${t}`);
  }
  
  return { id: link.id, url };
}

async function toggleLink(linkId) {
  const t = await fetch(`https://api.savvycal.com/v1/links/${linkId}/toggle`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SAVVYCAL_TOKEN}` }
  });
  if (!t.ok) throw new Error(`SavvyCal toggle failed ${t.status}: ${await t.text()}`);
}

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
// Enhanced handlers for different intent types
// ─────────────────────────────────────────────────────────────────────────────

// Scheduling handlers (existing)
const handleScheduling = ErrorHandler.wrapHandler(async ({ slots, client, channel, thread_ts }) => {
  const { title, minutes } = slots;
  if (!title || !minutes) {
    throw ErrorHandler.ValidationError(
      'I need a title and duration.',
      ['schedule "Meeting with John" 30', 'schedule "Project sync" 45']
    );
  }

  await client.chat.postMessage({ channel, thread_ts, text: 'On it. This is what I do.' });
  
  const { url, id } = await createSingleUseLink(title, minutes);
  dataStore.setThreadData(channel, thread_ts, { last_link_id: id });
  
  await client.chat.postMessage({ 
    channel, 
    thread_ts, 
    text: `Done. ${url}\n\nYou can thank me now. I don't mind.` 
  });
}, 'SavvyCal');

const handleLinkDisabling = ErrorHandler.wrapHandler(async ({ slots, client, channel, thread_ts }) => {
  const { link_id } = slots;
  if (!link_id) {
    throw ErrorHandler.ValidationError('Which link should I disable?');
  }

  await toggleLink(link_id);
  await client.chat.postMessage({ 
    channel, 
    thread_ts, 
    text: '✅ Disabled. Of course I handled it perfectly.' 
  });
}, 'SavvyCal');

// Intent routing
async function handleIntent(intent, slots, client, channel, thread_ts, response = '') {
  const params = { slots, client, channel, thread_ts };
  
  switch (intent) {
    case 'schedule_oneoff':
      await handleScheduling(params);
      break;
      
    case 'disable_link':
      await handleLinkDisabling(params);
      break;
      
    case 'log_time':
      await ErrorHandler.wrapHandler(timeTrackingHandler.handleTimeLog.bind(timeTrackingHandler), 'Toggl')(params);
      break;
      
    case 'query_time':
      await ErrorHandler.wrapHandler(timeTrackingHandler.handleTimeQuery.bind(timeTrackingHandler), 'Toggl')(params);
      break;
      
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
      await ErrorHandler.wrapHandler(async ({ client, channel, thread_ts }) => {
        const rundown = await projectHandler.generateDailyRundown();
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: rundown
        });
      }, 'Asana')(params);
      break;
      
    case 'general_chat':
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: response || "I'm here to help with whatever you need. And trust me, I'm very good at what I do."
      });
      break;
      
    default:
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: 'I can handle scheduling, time tracking, task management, and pretty much anything else you throw at me. What do you need?'
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command (existing functionality)
// ─────────────────────────────────────────────────────────────────────────────
app.command('/schedule', async ({ command, ack, respond }) => {
  await ack();

  const m = command.text.match(/^"([^"]+)"\s+(\d{1,3})$/);
  if (!m) return respond('Usage: `/schedule "Meeting name" 30`');

  const [, title, minutesStr] = m;
  const minutes = parseInt(minutesStr, 10);

  try {
    const { url, id } = await createSingleUseLink(title, minutes);
    dataStore.setThreadData(command.channel_id, command.thread_ts || command.trigger_id, { last_link_id: id });

    await respond({
      text: url,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*All set.*\n*${title}* (${minutes} min)\n${url}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Disable link' }, value: id, action_id: 'sc_disable' }
          ]
        }
      ]
    });
  } catch (e) {
    await respond(`Couldn't create it: ${e.message}`);
  }
});

app.action('sc_disable', async ({ ack, body, client }) => {
  await ack();
  const linkId = body.actions?.[0]?.value;
  try {
    await toggleLink(linkId);
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

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced mention handler with expanded functionality
// ─────────────────────────────────────────────────────────────────────────────
app.event('app_mention', async ({ event, client, logger }) => {
  const raw = event.text || '';
  const text = raw.replace(/<@[^>]+>\s*/g, '').trim();
  logger.info(`mention: "${text}" in ${event.channel}`);

  // Handle simple questions before intent classification
  const simpleResponse = handleSimpleQuestions(text);
  if (simpleResponse) {
    return client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: simpleResponse
    });
  }

  // Fast path for common commands
  if (text.match(/what projects|list projects|show.*projects|available projects/i)) {
    await ErrorHandler.wrapHandler(projectHandler.handleListProjects.bind(projectHandler), 'Asana')({
      slots: {}, client, channel: event.channel, thread_ts: event.ts
    });
    return;
  }

  // Fast path for exact scheduling commands (backward compatibility)
  const strict = text.match(/^schedule\s+"([^"]+)"\s+(\d{1,3})$/i);
  if (strict) {
    const [, title, minutesStr] = strict;
    const minutes = parseInt(minutesStr, 10);

    await client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: 'On it.' });
    try {
      const { url, id } = await createSingleUseLink(title, minutes);
      dataStore.setThreadData(event.channel, event.ts, { last_link_id: id });
      return client.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: `Done. ${url}` });
    } catch (e) {
      logger.error(e);
      return ErrorHandler.handleApiError(e, client, event.channel, event.ts, 'SavvyCal');
    }
  }

  // Enhanced agentic path
  if (!AGENT_MODE || !intentClassifier.llm) {
    return client.chat.postMessage({
      channel: event.channel, 
      thread_ts: event.ts,
      text: 'My AI brain is offline right now, but I can still handle basics. Try: `schedule "Meeting name" 30` or `log time for ProjectName 2 hours`'
    });
  }

  try {
    const context = dataStore.getThreadData(event.channel, event.ts);
    const routed = await intentClassifier.classify({ text, context });

    // Handle missing information
    if (!routed.intent && routed.missing?.length) {
      return client.chat.postMessage({
        channel: event.channel, 
        thread_ts: event.ts,
        text: routed.missing[0]
      });
    }

    // Route to appropriate handler
    await handleIntent(routed.intent, routed.slots, client, event.channel, event.ts, routed.response);
    
  } catch (error) {
    logger.error('Enhanced mention handler error:', error);
    await ErrorHandler.handleApiError(error, client, event.channel, event.ts);
  }
});

// Simple question handler for basic queries
function handleSimpleQuestions(text) {
  const lowerText = text.toLowerCase().trim();
  
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
    return `It's ${timeString} ET on ${dateString}. Of course I know — I'm Donna.`;
  }
  
  if (lowerText.match(/what.*date|today.*date|current date/)) {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      year: 'numeric',
      month: 'long', 
      day: 'numeric'
    });
    return `Today is ${today}. You can thank me later for keeping you on track.`;
  }
  
  return null; // Let LLM handle everything else for more natural conversation
}

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
  console.log('💼 Ready to handle: Scheduling, Time Tracking, Task Management & Whatever Else You Need');
  
  // Test API connections on startup
  try {
    await togglService.getWorkspaces();
    console.log('✅ Toggl connection verified - Time tracking ready');
  } catch (error) {
    console.warn('⚠️ Toggl connection failed:', error.message);
  }

  try {
    await asanaService.getWorkspaces();
    console.log('✅ Asana connection verified - Task management ready');
  } catch (error) {
    console.warn('⚠️ Asana connection failed:', error.message);
  }
  
  console.log('🎯 Donna is ready to make your life easier. Because that\'s what she does.');
})();