// app.js — Enhanced Donna with Thread Conversation Tracking & Modular Services + Timezone Support + Enhanced General Chat + Daily Rundowns
require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');

// Enhanced architecture imports
const IntentClassifier = require('./utils/intentClassifier');
const dataStore = require('./utils/dataStore');
const ErrorHandler = require('./utils/errorHandler');
const TimezoneHelper = require('./utils/timezoneHelper');
const { fetchThreadTranscript } = require('./utils/threadReader');
const donnaBrain = require('./utils/donnaBrain');

// Service imports
const savvyCalService = require('./services/savvycal');
const togglService = require('./services/toggl');
const asanaService = require('./services/asana');
const googleCalendarService = require('./services/googleCalendar');
const pelotonService = require('./services/peloton');



// Handler imports
const schedulingHandler = require('./handlers/scheduling');
const timeTrackingHandler = require('./handlers/timeTracking');
const projectHandler = require('./handlers/projects');
const calendarHandler = require('./handlers/calendar');
const workoutHandler = require('./handlers/workout');


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
// Which brain to use for open-ended messages: 'agentic' → Claude Tool Runner
// (utils/donnaBrain.js); anything else → the existing OpenAI intent router.
const BRAIN = String(process.env.BRAIN || '').toLowerCase();

// Donna's own Slack user ID, resolved at startup. Used to label her own messages
// when reading a thread transcript so she doesn't mistake them for the user's.
let BOT_USER_ID = null;

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
// Enhanced general chat handler with context awareness
// ─────────────────────────────────────────────────────────────────────────────

async function handleGeneralChat({ slots, client, channel, thread_ts, userId, response, originalMessage }) {
    try {
      // Get thread context to see if there are recent actions (like created links)
      const threadContext = dataStore.getThreadData(channel, thread_ts);
      console.log('Thread context for general chat:', threadContext);
      console.log('LLM provided response:', response);
      
      // Check if this is an email drafting request
      const lowerMessage = originalMessage.toLowerCase();
      const isEmailRequest = lowerMessage.includes('draft') || lowerMessage.includes('write') || 
                            (lowerMessage.includes('email') && (lowerMessage.includes('to') || lowerMessage.includes('for')));
      
      if (isEmailRequest) {
        // Extract email details from slots or message
        const recipientName = slots.email_recipient || extractRecipientName(originalMessage);
        const topic = slots.email_topic || extractEmailTopic(originalMessage);
        
        // Generate modern, professional email
        const emailDraft = generateModernEmail({
          recipient: recipientName,
          topic: topic,
          originalMessage,
          recentLink: threadContext.last_link_url ? {
            url: threadContext.last_link_url,
            title: threadContext.last_link_title || 'Meeting'
          } : null
        });
        
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: emailDraft
        });
        return;
      }
      
      // If the LLM provided a substantive response, use it (it should be context-aware)
      if (response && response.trim() !== '' && response !== "You clearly need my help. Good thing I'm Donna.") {
        console.log('Using LLM-generated response');
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: response
        });
        return;
      }
      
      // Fallback context-aware responses when LLM doesn't provide specific content
      
      // Check if user is asking about a recent link specifically
      if (threadContext.last_link_id && (lowerMessage.includes('link') || lowerMessage.includes('url') || lowerMessage.includes('schedule'))) {
        const recentLinkUrl = threadContext.last_link_url || `https://savvycal.com/indievisual/${threadContext.last_link_id}`;
        const linkTitle = threadContext.last_link_title || 'Meeting';
        const timeAgo = threadContext.last_action_time ? 
          `${Math.round((Date.now() - threadContext.last_action_time) / 60000)} minutes ago` : 
          'recently';
        
        response = `Your most recent scheduling link (created ${timeAgo}):\n\n` +
                  `**${linkTitle}:** ${recentLinkUrl}\n\n` +
                  `Need me to help you use this in an email or somewhere else?`;
      }
      // Check if user is asking for help with emails in general
      else if (lowerMessage.includes('email') && lowerMessage.includes('help')) {
        response = `I can definitely help you draft emails! What kind of email are you looking to write?\n\n` +
                  `I'm particularly good at:\n` +
                  `• Professional follow-ups and project coordination\n` +
                  `• Including scheduling links in outreach\n` +
                  `• Meeting requests and confirmations\n` +
                  `• Client communications\n\n` +
                  `Just let me know the context and I'll draft something for you.`;
      }
      // Default Donna responses for general conversation
      else {
        const donnaResponses = [
          "You're asking the wrong question — but lucky for you, I have the right answer.",
          "I already took care of it. You're welcome.",
          "Please. I've handled worse before breakfast.",
          "I'm Donna. That's the whole explanation.",
          "You clearly need my help. Good thing I'm Donna.",
          "Let me guess — you need something handled perfectly? That's what I'm here for."
        ];
        
        response = donnaResponses[Math.floor(Math.random() * donnaResponses.length)];
      }
      
      // Send the response
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: response
      });
      
    } catch (error) {
      console.error('General chat handler error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: "Even I have my limits. Try rephrasing that?"
      });
    }
  }

// ─────────────────────────────────────────────────────────────────────────────
// Modern email generation helper
// ─────────────────────────────────────────────────────────────────────────────

function generateModernEmail({ recipient, topic, originalMessage, recentLink }) {
    // Extract purpose/context from original message
    const lowerMsg = originalMessage.toLowerCase();
    
    // Generate subject line based on context
    let subject = '';
    if (topic) {
      subject = `Re: ${topic}`;
    } else if (recentLink) {
      subject = `Connecting about ${recentLink.title.replace(/\b(call|meeting|with)\b/gi, '').trim()}`;
    } else {
      subject = 'Quick connect';
    }
    
    // Generate opening based on context
    let opening = `Hi${recipient ? ` ${recipient}` : ''},`;
    
    // Generate body based on message content and context
    let body = '';
    
    if (lowerMsg.includes('discovery') || lowerMsg.includes('learn how i can help')) {
      body = `I'd love to connect with you about how I can help${topic ? ` with ${topic}` : ''}. `;
    } else if (lowerMsg.includes('follow up') || lowerMsg.includes('followup')) {
      body = `Following up on our conversation${topic ? ` about ${topic}` : ''}. `;
    } else if (lowerMsg.includes('meeting') || lowerMsg.includes('connect')) {
      body = `I'd like to schedule some time to connect${topic ? ` about ${topic}` : ''}. `;
    } else {
      body = `I wanted to reach out${topic ? ` about ${topic}` : ''}. `;
    }
    
    // Add scheduling link if available
    if (recentLink) {
      if (lowerMsg.includes('this week')) {
        body += `Here's a link to grab time that works for you this week:\n\n${recentLink.url}`;
      } else {
        body += `I've set up a quick booking link to make scheduling easy:\n\n${recentLink.url}`;
      }
    }
    
    // Add context-specific closing
    let closing = '';
    if (lowerMsg.includes('look forward') || lowerMsg.includes('looking forward')) {
      closing = '\n\nLooking forward to connecting';
      if (lowerMsg.includes('this week')) {
        closing += ' this week';
      }
      closing += '.';
    } else if (recentLink) {
      closing = '\n\nTalk soon.';
    } else {
      closing = '\n\nLet me know what works best for you.';
    }
    
    // Construct final email
    const email = `I'll draft that email for you:\n\n` +
                 `**Subject:** ${subject}\n\n` +
                 `${opening}\n\n` +
                 `${body}${closing}\n\n` +
                 `[Your name]`;
    
    return email;
  }


  // Helper functions for email extraction
function extractRecipientName(message) {
    // Look for patterns like "email to John", "draft an email to Maura"
    const patterns = [
      /(?:email|write|draft).*?to\s+([A-Z][a-z]+)/i,
      /to\s+([A-Z][a-z]+)(?:\s|,|$)/i
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) return match[1];
    }
    return null;
  }
  
  function extractEmailTopic(message) {
    // Look for patterns like "about X", "regarding Y"
    const patterns = [
      /about\s+([^,\n]+)/i,
      /regarding\s+([^,\n]+)/i,
      /for\s+([^,\n]+)/i
    ];
    
    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) return match[1].trim();
    }
    return null;
  }

  async function handleMultiStep({ slots, client, channel, thread_ts, userId }) {
    try {
      const steps = slots.steps || [];
      
      if (steps.length === 0) {
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: "I see you want multiple things done, but I need you to break it down for me. What's the first thing you need?"
        });
        return;
      }
  
      // Execute the first step
      const firstStep = steps[0];
      const remainingSteps = steps.slice(1);
      
      // Store remaining steps in thread context for follow-up
      dataStore.setThreadData(channel, thread_ts, {
        pending_steps: remainingSteps,
        multi_step_in_progress: true
      });
      
      // Send instruction message
      let instruction = `I'll handle this step by step. First, let me ${getStepDescription(firstStep.intent)}.`;
      if (remainingSteps.length > 0) {
        const nextActions = remainingSteps.map(step => getStepDescription(step.intent));
        instruction += ` After that, ask me to ${nextActions.join(' and ')}.`;
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: instruction
      });
      
      // Execute the first step
      await handleIntent(firstStep.intent, firstStep.slots, client, channel, thread_ts, '', userId);
      
    } catch (error) {
      console.error('Multi-step handler error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: "Even I can't do everything at once. Let's tackle this one step at a time."
      });
    }
  }
  
  function getStepDescription(intent) {
    const descriptions = {
      'schedule_oneoff': 'create your scheduling link',
      'general_chat': 'draft that email',
      'create_meeting': 'set up your meeting',
      'block_time': 'block time on your calendar',
      'create_task': 'create that task',
      'list_tasks': 'show your tasks',
      'check_calendar': 'check your calendar'
    };
    return descriptions[intent] || `handle your ${intent} request`;
  }

// ─────────────────────────────────────────────────────────────────────────────
// Intent routing - UPDATED with userId parameter
// ─────────────────────────────────────────────────────────────────────────────

async function handleIntent(intent, slots, client, channel, thread_ts, response = '', userId, originalText = '') {
    const params = { slots, client, channel, thread_ts, userId };
    
    switch (intent) {
      // NEW: Multi-step handling
      case 'multi_step':
        await handleMultiStep(params);
        break;
        
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
        
      case 'update_task':
        await ErrorHandler.wrapHandler(projectHandler.handleUpdateTask.bind(projectHandler), 'Asana')(params);
        break;
        
      case 'create_task':
        await ErrorHandler.wrapHandler(projectHandler.handleCreateTask.bind(projectHandler), 'Asana')(params);
        break;

      // Read the thread's action items and turn them into Asana tasks (preview + confirm)
      case 'extract_tasks':
        await ErrorHandler.wrapHandler(projectHandler.handleExtractTasks.bind(projectHandler), 'Asana')(params);
        break;
        
      case 'complete_task':
        await ErrorHandler.wrapHandler(async (params) => {
          const { slots } = params;
          const updateParams = {
            ...params,
            slots: { ...slots, field: 'completed', value: 'true' }
          };
          await projectHandler.handleUpdateTask(updateParams);
        }, 'Asana')(params);
        break;
        
        
      // Calendar intents - UPDATED with new handlers
      case 'check_calendar':
        await ErrorHandler.wrapHandler(calendarHandler.handleCheckCalendar.bind(calendarHandler), 'Google Calendar')(params);
        break;
        
      case 'create_meeting':
        await ErrorHandler.wrapHandler(calendarHandler.handleCreateMeeting.bind(calendarHandler), 'Google Calendar')(params);
        break;
  
      case 'block_time':
        await ErrorHandler.wrapHandler(calendarHandler.handleBlockTime.bind(calendarHandler), 'Google Calendar')(params);
        break;
        
      case 'next_meeting':
        await ErrorHandler.wrapHandler(calendarHandler.handleNextMeeting.bind(calendarHandler), 'Google Calendar')(params);
        break;
        
      // NEW: Daily rundown and calendar management
      case 'daily_rundown':
        await ErrorHandler.wrapHandler(calendarHandler.handleDailyRundown.bind(calendarHandler), 'Daily Rundown')(params);
        break;
        
      case 'calendar_rundown':
        await ErrorHandler.wrapHandler(calendarHandler.handleCalendarRundown.bind(calendarHandler), 'Google Calendar')(params);
        break;
        
      case 'update_meeting':
        await ErrorHandler.wrapHandler(calendarHandler.handleUpdateMeeting.bind(calendarHandler), 'Google Calendar')(params);
        break;
        
      case 'delete_meeting':
        await ErrorHandler.wrapHandler(calendarHandler.handleDeleteMeeting.bind(calendarHandler), 'Google Calendar')(params);
        break;

        case 'workout_recommendation':
          await ErrorHandler.wrapHandler(workoutHandler.handleWorkoutRecommendation.bind(workoutHandler), 'Peloton')(params);
          break;
          
        case 'schedule_workout':
          await ErrorHandler.wrapHandler(workoutHandler.handleScheduleWorkout.bind(workoutHandler), 'Peloton')(params);
          break;
          
        case 'workout_history':
          await ErrorHandler.wrapHandler(workoutHandler.handleWorkoutHistory.bind(workoutHandler), 'Peloton')(params);
          break;
        
        // Temporary debug intent for troubleshooting instructors
        case 'list_instructors':
          await ErrorHandler.wrapHandler(workoutHandler.handleListInstructors.bind(workoutHandler), 'Peloton')(params);
          break;
        
      // General conversation - ENHANCED with modern email generation
      case 'general_chat':
        await handleGeneralChat({
          slots,
          client,
          channel,
          thread_ts,
          userId,
          response,
          originalMessage: originalText
        });
        break;
        
      default:
        const openingLine = getRandomOpeningLine();
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `${openingLine}\n\nI handle scheduling, time tracking, task management, calendar management, and pretty much everything else.`
        });
    }
  }

// ─────────────────────────────────────────────────────────────────────────────
// Main message processing function - UPDATED with userId support and enhanced context
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

  // If Donna extracted tasks and is waiting for the user to name a project,
  // treat this reply as the answer (project name, or a cancel).
  const pendingData = dataStore.getThreadData(channel, responseThreadTs);
  if (pendingData.pending_tasks_await_project && pendingData.pending_tasks?.length) {
    await ErrorHandler.wrapHandler(projectHandler.handleTaskProjectResponse.bind(projectHandler), 'Asana')({
      slots: { answer: text }, client, channel, thread_ts: responseThreadTs, userId: user
    });
    return;
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
      dataStore.setThreadData(channel, responseThreadTs, { 
        last_link_id: id, 
        last_link_url: url,
        last_link_title: title,
        last_action: 'created_scheduling_link',
        last_action_time: Date.now()
      });
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

  // Agentic brain (Claude Tool Runner) — Phase 1 spike, gated behind BRAIN=agentic.
  // Runs alongside the OpenAI router; when enabled it handles everything past the
  // exact-command fast paths above.
  if (BRAIN === 'agentic' && donnaBrain.isEnabled()) {
    await donnaBrain.handleMessage({
      text,
      client,
      channel,
      thread_ts: responseThreadTs,
      userId: user,
      botUserId: BOT_USER_ID,
      logger
    });
    return;
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
    // Read the thread so Donna understands what was said before she was tagged
    // (e.g. a Fireflies/Fred recap). Stored on the thread so handlers can reuse it.
    if (responseThreadTs) {
      const transcript = await fetchThreadTranscript(client, channel, responseThreadTs, { botUserId: BOT_USER_ID });
      if (transcript.length) {
        dataStore.setThreadData(channel, responseThreadTs, {
          recent_messages: transcript.map(m => ({ author: m.author, text: m.text }))
        });
        console.log(`🧵 Read ${transcript.length} message(s) from thread ${channel}::${responseThreadTs}`);
      }
    }

    const threadData = dataStore.getThreadData(channel, responseThreadTs);
    const userTimezone = await TimezoneHelper.getUserTimezone(client, user); // Get user timezone
    
    // Build enhanced context for the LLM
    const enhancedContext = {
      last_link_id: threadData.last_link_id || null,
      last_link_url: threadData.last_link_url || null,
      last_link_title: threadData.last_link_title || null,
      last_action: threadData.last_action || null,
      last_action_time: threadData.last_action_time || null,
      user_timezone: userTimezone,
      current_time: new Date().toISOString(),
      thread_history: threadData.recent_messages || [],
      // Add helpful flags for context awareness
      has_recent_link: !!(threadData.last_link_id && threadData.last_action_time && (Date.now() - threadData.last_action_time) < 300000), // 5 minutes
      thread_active_since: threadData.startedBy ? new Date(threadData.lastActivity || Date.now()).toISOString() : null
    };
    
    console.log('Enhanced context for intent classification:', enhancedContext);
    
    const routed = await intentClassifier.classify({ text, context: enhancedContext });

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
    await handleIntent(routed.intent, routed.slots, client, channel, responseThreadTs, routed.response, user, text);
    
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
    dataStore.setThreadData(command.channel_id, command.thread_ts || command.trigger_id, { 
      last_link_id: id,
      last_link_url: url,
      last_link_title: title,
      last_action: 'created_scheduling_link',
      last_action_time: Date.now()
    });

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

// Confirm creation of the tasks Donna extracted from a thread
app.action('donna_create_tasks', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id || body.user?.id;
  const value = body.actions?.[0]?.value;
  const thread_ts = value && value !== 'root' ? value : (body.message?.thread_ts || undefined);
  await ErrorHandler.wrapHandler(projectHandler.confirmPendingTasks.bind(projectHandler), 'Asana')({
    client, channel, thread_ts, userId: body.user?.id
  });
});

// Cancel the pending task extraction
app.action('donna_cancel_tasks', async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id || body.user?.id;
  const value = body.actions?.[0]?.value;
  const thread_ts = value && value !== 'root' ? value : (body.message?.thread_ts || undefined);
  dataStore.setThreadData(channel, thread_ts, {
    pending_tasks: null,
    pending_tasks_project: null,
    pending_tasks_await_project: false
  });
  await client.chat.postMessage({
    channel,
    thread_ts,
    text: "Scrapped it — nothing added to Asana. Say the word if you change your mind."
  });
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

  // Resolve Donna's own user ID so she can recognize her own messages when reading threads
  try {
    const auth = await app.client.auth.test();
    BOT_USER_ID = auth.user_id;
    console.log(`🪪 Donna's user ID: ${BOT_USER_ID}`);
  } catch (error) {
    console.warn('⚠️ Could not resolve bot user ID:', error.message);
  }

  // Report which brain is handling open-ended messages
  if (BRAIN === 'agentic') {
    if (donnaBrain.isEnabled()) {
      console.log(`🧠 Brain: agentic (Claude Tool Runner, model ${donnaBrain.MODEL})`);
    } else {
      console.warn('⚠️ BRAIN=agentic but the agentic brain is not ready (missing ANTHROPIC_API_KEY or SDK) — falling back to the OpenAI router.');
    }
  } else {
    console.log('🧠 Brain: OpenAI intent router (set BRAIN=agentic to use the Claude Tool Runner)');
  }
  console.log('💼 Managing: Scheduling, Time Tracking, Task Management, Calendar & Your Entire Professional Life');
  console.log('🌍 Now with timezone-aware calendar support - respecting every user\'s local time');
  console.log('🧠 Enhanced with context-aware general conversation - helping you draft emails, coordinate projects & more');
  console.log('📅 NEW: Daily rundowns and comprehensive calendar intelligence');
  
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