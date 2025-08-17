// handlers/calendar.js - Complete Enhanced Calendar Handler with Daily Rundowns
const googleCalendarService = require('../services/googleCalendar');
const TimezoneHelper = require('../utils/timezoneHelper');
const dataStore = require('../utils/dataStore');
const asanaService = require('../services/asana');

class CalendarHandler {
  // UPDATED: Handle requests to check calendar/meetings with user timezone
  async handleCheckCalendar({ slots, client, channel, thread_ts, userId }) {
    try {
      // GET USER TIMEZONE FIRST
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      console.log(`Checking calendar for user ${userId} in timezone: ${userTimezone}`);

      const { date, period = 'today' } = slots;
      
      let events = [];
      let title = '';
      
      if (date && date !== 'today' && date !== 'tomorrow') {
        // Specific date requested (not today/tomorrow keywords)
        events = await googleCalendarService.getEventsForDate(date, userTimezone);
        const dateObj = new Date(date);
        title = `*Meetings on ${dateObj.toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric',
          timeZone: userTimezone
        })}:*`;
      } else {
        // Period-based or keyword-based request
        const requestedPeriod = date || period;
        
        switch (requestedPeriod.toLowerCase()) {
          case 'today':
            events = await googleCalendarService.getEventsToday(userTimezone);
            title = '*Today\'s meetings:*';
            break;
            
          case 'tomorrow':
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            events = await googleCalendarService.getEventsForDate(tomorrow, userTimezone);
            title = `*Tomorrow's meetings (${tomorrow.toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric',
              timeZone: userTimezone
            })}):*`;
            break;
            
          case 'this week':
          case 'this_week':
          case 'week':
            events = await googleCalendarService.getEventsThisWeek(userTimezone);
            title = '*This week\'s meetings:*';
            break;
            
          default:
            events = await googleCalendarService.getEventsToday(userTimezone);
            title = '*Today\'s meetings:*';
        }
      }
      
      if (events.length === 0) {
        const requestedPeriod = date || period;
        let freeMessage;
        
        switch (requestedPeriod.toLowerCase()) {
          case 'today':
            freeMessage = 'Your calendar is clear today! Time to tackle that task list.';
            break;
          case 'tomorrow':
            freeMessage = 'Nothing on the books tomorrow. Perfect day for deep work.';
            break;
          case 'this week':
          case 'this_week':
          case 'week':
            freeMessage = 'Light week ahead! Good time to plan your next moves.';
            break;
          default:
            freeMessage = `No meetings scheduled. Lucky you.`;
        }
          
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `${title}\n${freeMessage} ✨`
        });
      }
      
      // Format events for display with user timezone
      let message = title + '\n\n';
      
      if (period === 'this week' || period === 'week') {
        // Group by day for weekly view
        const groupedEvents = googleCalendarService.groupEventsByDate(events, userTimezone);
        
        for (const [date, dayEvents] of Object.entries(groupedEvents)) {
          message += `*${date}:*\n`;
          message += dayEvents.map(e => googleCalendarService.formatEvent(e, true, userTimezone)).join('\n') + '\n\n';
        }
      } else {
        // Simple list for single day
        message += events.map(e => googleCalendarService.formatEvent(e, true, userTimezone)).join('\n\n');
      }
      
      // Add helpful context
      if (events.length > 0) {
        const hasVideoMeetings = events.some(e => googleCalendarService.extractMeetingLink(e));
        if (hasVideoMeetings) {
          message += '\n\n_Need help prepping for any of these? Just ask._';
        }
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message.trim()
      });
      
    } catch (error) {
      console.error('Check calendar error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble accessing your calendar: ${error.message}`
      });
    }
  }

  // UPDATED: Handle blocking time on calendar with user timezone
  async handleBlockTime({ slots, client, channel, thread_ts, userId }) {
    try {
      // GET USER TIMEZONE FIRST
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      console.log(`Blocking time for user ${userId} in timezone: ${userTimezone}`);

      let { 
        title, 
        date, 
        start_time, 
        end_time,
        duration = 60
      } = slots;
      
      // Default title if not provided
      if (!title || title.trim() === '') {
        title = 'Focus Time';
      }
      
      // Default date if not provided
      if (!date || date.trim() === '') {
        date = 'today';
      }
      
      if (!start_time) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a start time to block calendar time. Try: "block time tomorrow 2-4pm" or "block calendar 9am to 5pm"'
        });
      }
      
      console.log(`Blocking time: ${title} on ${date} from ${start_time} to ${end_time || `${duration} mins`} in timezone ${userTimezone}`);
      
      // Parse date and time WITH USER TIMEZONE
      let startTime, endTime;
      
      if (end_time) {
        // User provided both start and end time - use time range parser
        const timeRange = googleCalendarService.parseTimeRange(date, start_time, end_time, userTimezone);
        startTime = timeRange.startTime;
        endTime = timeRange.endTime;
      } else {
        // Use duration
        const { startTime: parsedStart, endTime: parsedEnd } = googleCalendarService.parseDateTime(date, start_time, duration, userTimezone);
        startTime = parsedStart;
        endTime = parsedEnd;
      }
      
      console.log(`Creating calendar event: ${startTime} to ${endTime}`);
      
      // Create the calendar event with user's timezone
      const event = await googleCalendarService.createEvent({
        summary: title,
        description: 'Time blocked via Donna',
        startTime,
        endTime,
        attendees: [],
        location: '',
        meetingType: null,
        timeZone: userTimezone  // Pass user's timezone
      });
      
      // Format confirmation message with user's timezone
      const eventDate = new Date(event.start.dateTime);
      const eventEndDate = new Date(event.end.dateTime);
      const timeStr = `${eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      })} - ${eventEndDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      })}`;
      const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: userTimezone
      });
      
      // Get timezone info for display
      const timezoneInfo = TimezoneHelper.getTimezoneInfo(userTimezone);
      
      let message = `✅ Time blocked: *${event.summary}*\n`;
      message += `📅 ${dateStr} at ${timeStr}\n`;
      message += `🌍 ${timezoneInfo.name} (${timezoneInfo.offset})\n`;
      message += '\n_Your calendar is now protected. Focus time secured._';
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Block time error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't block that time: ${error.message}`
      });
    }
  }

  // UPDATED: Handle creating meetings with user timezone
  async handleCreateMeeting({ slots, client, channel, thread_ts, userId }) {
    try {
      // GET USER TIMEZONE FIRST
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      console.log(`Creating meeting for user ${userId} in timezone: ${userTimezone}`);

      const { 
        title, 
        date, 
        start_time, 
        duration = 60, 
        attendees = [], 
        location = '',
        description = '',
        meeting_type 
      } = slots;
      
      if (!title || !date || !start_time) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need at least a title, date, and start time to create a meeting. Try: "schedule Meeting with John tomorrow at 2pm"'
        });
      }
      
      // Parse date and time with user timezone
      const { startTime, endTime } = googleCalendarService.parseDateTime(date, start_time, duration, userTimezone);
      
      // Parse attendees (split by comma if it's a string)
      const attendeeList = typeof attendees === 'string' ? 
        attendees.split(',').map(email => email.trim()) : 
        attendees;
      
      // Create the event with user's timezone
      const event = await googleCalendarService.createEvent({
        summary: title,
        description,
        startTime,
        endTime,
        attendees: attendeeList,
        location,
        meetingType: meeting_type,
        timeZone: userTimezone
      });
      
      // Format confirmation message with user's timezone
      const eventDate = new Date(event.start.dateTime);
      const timeStr = eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      });
      const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: userTimezone
      });
      
      let message = `✅ Created meeting: *${event.summary}*\n`;
      message += `📅 ${dateStr} at ${timeStr}\n`;
      
      if (attendeeList.length > 0) {
        message += `👥 Attendees: ${attendeeList.join(', ')}\n`;
      }
      
      const meetingLink = googleCalendarService.extractMeetingLink(event);
      if (meetingLink) {
        message += `🔗 ${meetingLink}\n`;
      }
      
      if (location && !googleCalendarService.isMeetingLink(location)) {
        message += `📍 ${location}\n`;
      }
      
      // Check if attendees were successfully invited
      if (event._attendeesInvited === false) {
        message += '\n⚠️ _Note: Attendees need to be invited manually (API limitation)_';
      }
      
      message += '\n_Calendar invite sent. You\'re all set._';
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Create meeting error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't create that meeting: ${error.message}`
      });
    }
  }

  // UPDATED: Handle "what's next" type queries with user timezone
  async handleNextMeeting({ client, channel, thread_ts, userId }) {
    try {
      // GET USER TIMEZONE FIRST
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      
      const now = new Date();
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
      
      const upcomingEvents = await googleCalendarService.getEvents({
        timeMin: now.toISOString(),
        timeMax: endOfDay.toISOString(),
        maxResults: 5
      });
      
      if (upcomingEvents.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'No more meetings today. Time to focus on what matters.'
        });
      }
      
      const nextEvent = upcomingEvents[0];
      const startTime = new Date(nextEvent.start.dateTime);
      const timeUntil = this.formatTimeUntil(startTime);
      
      let message = `*Next up:* ${nextEvent.summary}\n`;
      message += `🕐 ${timeUntil}\n`;
      
      // Add meeting details with user timezone
      const meetingLink = googleCalendarService.extractMeetingLink(nextEvent);
      if (meetingLink) {
        message += `🔗 ${meetingLink}\n`;
      }
      
      if (nextEvent.attendees && nextEvent.attendees.length > 0) {
        const attendeeNames = nextEvent.attendees
          .map(a => a.displayName || a.email.split('@')[0])
          .slice(0, 3);
        message += `👥 ${attendeeNames.join(', ')}\n`;
      }
      
      // Add prep suggestion if meeting is soon
      const minutesUntil = Math.floor((startTime - now) / (1000 * 60));
      if (minutesUntil <= 15) {
        message += '\n_Better wrap up what you\'re doing. Meeting starts soon._';
      } else if (minutesUntil <= 30) {
        message += '\n_Good time to review your notes and prep._';
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Next meeting error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble checking your upcoming meetings: ${error.message}`
      });
    }
  }
// handlers/calendar.js - FIXED: Variable scope issue
// Replace the handleDailyRundown method with this scope-corrected version:

async handleDailyRundown({ client, channel, thread_ts, userId }) {
  try {
    const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
    console.log(`Generating daily rundown for user ${userId} in timezone: ${userTimezone}`);

    // Get all data in parallel for speed
    const [
      todaysEvents,
      todaysTasks, 
      overdueTasks,
      nextMeeting
    ] = await Promise.all([
      googleCalendarService.getEventsToday(userTimezone),
      asanaService.getTasksDueToday(),
      asanaService.getOverdueTasks(),
      this.getNextMeetingToday(userTimezone)
    ]);

    console.log(`Retrieved ${todaysEvents.length} events, ${todaysTasks.length} today tasks, ${overdueTasks.length} overdue tasks`);

    // Build comprehensive rundown with Slack-friendly formatting
    let rundown = `*Good morning! Here's your day ahead:*\n\n`;
    
    // Current time context
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true,
      timeZone: userTimezone
    });
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: userTimezone
    });
    
    rundown += `📅 *${dateStr}* • ${timeStr}\n\n`;

    // Next meeting focus
    if (nextMeeting) {
      const startTime = new Date(nextMeeting.start.dateTime);
      const timeUntil = this.formatTimeUntil(startTime);
      rundown += `🔜 *Next up:* ${nextMeeting.summary} ${timeUntil}\n`;
      
      const meetingLink = googleCalendarService.extractMeetingLink(nextMeeting);
      if (meetingLink) {
        rundown += `   🔗 ${meetingLink}\n`;
      }
      rundown += '\n';
    }

    // TODAY'S CALENDAR
    if (todaysEvents.length > 0) {
      rundown += `📆 *Today's Calendar* (${todaysEvents.length} meetings):\n`;
      rundown += todaysEvents.map(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const timeStr = start.toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit',
          hour12: true,
          timeZone: userTimezone
        });
        return `   • ${timeStr} - ${e.summary}`;
      }).join('\n') + '\n\n';
    } else {
      rundown += `📆 *Calendar:* No meetings today - perfect for deep work!\n\n`;
    }

    // ENHANCED TASK SECTION WITH PROJECT BREAKDOWN
    const allRelevantTasks = [...overdueTasks, ...todaysTasks];
    const uniqueTasks = this.deduplicateTasks(allRelevantTasks);
    
    // FIXED: Define projectRollup outside the if block
    let projectRollup = {
      byProject: {},
      hasMultipleProjects: false,
      totalProjects: 0
    };
    
    console.log(`Processing ${uniqueTasks.length} unique tasks`);
    
    if (uniqueTasks.length > 0) {
      projectRollup = await this.generateProjectRollup(uniqueTasks, overdueTasks, todaysTasks);
      
      console.log(`Generated project rollup with ${projectRollup.totalProjects} projects`);
      
     // handlers/calendar.js - IMPROVED: Better project display formatting
// Replace the project display section in handleDailyRundown (around line 110-160):

if (projectRollup.hasMultipleProjects && uniqueTasks.length > 8) {
  // Show detailed project breakdown with tasks
  rundown += `📊 *Project Workload* (${uniqueTasks.length} total tasks):\n\n`;
  
  // FIXED: Better sorting with defensive programming
  const sortedProjects = Object.entries(projectRollup.byProject || {})
    .sort(([,a], [,b]) => {
      // Ensure arrays exist before accessing length
      const aOverdue = (a && a.overdueTasks) ? a.overdueTasks.length : 0;
      const bOverdue = (b && b.overdueTasks) ? b.overdueTasks.length : 0;
      const aTotal = (a && a.allTasks) ? a.allTasks.length : 0;
      const bTotal = (b && b.allTasks) ? b.allTasks.length : 0;
      
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return bTotal - aTotal;
    });
  
  console.log(`Sorted ${sortedProjects.length} projects for display`);
  
  for (const [projectName, projectData] of sortedProjects) {
    if (!projectData) {
      console.warn(`Skipping undefined project data for ${projectName}`);
      continue;
    }
    
    const allProjectTasks = projectData.allTasks || [];
    const overdueProjectTasks = projectData.overdueTasks || [];
    const todayProjectTasks = projectData.todayTasks || [];
    
    // IMPROVED: Show total task count in parentheses
    const totalTaskCount = allProjectTasks.length;
    
    // Create project name as hyperlink to Asana board
    const projectLink = projectData.url ? 
      `<${projectData.url}|${projectName}>` : 
      projectName;
    
    // IMPROVED: Format with task count
    rundown += `*${projectLink}* (${totalTaskCount} tasks)\n`;
    
    // IMPROVED: Get top 3 most urgent tasks (prioritize overdue, then due today)
    const mostUrgentTasks = [
      ...overdueProjectTasks, // All overdue tasks first
      ...todayProjectTasks.filter(t => !overdueProjectTasks.some(o => o.gid === t.gid)) // Today tasks that aren't already overdue
    ]
    .slice(0, 3); // Take top 3 most urgent
    
    // IMPROVED: Display tasks as bullet points
    if (mostUrgentTasks.length > 0) {
      for (const task of mostUrgentTasks) {
        if (!task || !task.name) continue; // Skip invalid tasks
        
        const isOverdue = overdueProjectTasks.some(t => t && t.gid === task.gid);
        const prefix = isOverdue ? '🚨' : '📋';
        rundown += `   ${prefix} ${task.name}\n`;
      }
    } else {
      rundown += `   📋 No urgent tasks\n`;
    }
    
    // Show remaining count if there are more tasks
    const remainingCount = totalTaskCount - mostUrgentTasks.length;
    if (remainingCount > 0) {
      rundown += `   _...and ${remainingCount} more tasks_\n`;
    }
    
    rundown += '\n'; // Add space between projects
  }
} else {
  // Show simplified view for manageable workload (keep existing logic)
  if (overdueTasks.length > 0) {
    rundown += `🚨 *Priority: Overdue Tasks* (${overdueTasks.length} total):\n`;
    rundown += overdueTasks.slice(0, 4).map(t => {
      const projectName = this.getTaskProjectName(t);
      return `   • ${t.name}${projectName ? ` _[${projectName}]_` : ''}`;
    }).join('\n');
    if (overdueTasks.length > 4) {
      rundown += `\n   _...and ${overdueTasks.length - 4} more overdue_`;
    }
    rundown += '\n\n';
  }

  const uniqueTodayTasks = todaysTasks.filter(t => !overdueTasks.some(o => o.gid === t.gid));
  if (uniqueTodayTasks.length > 0) {
    rundown += `✅ *Due Today* (${uniqueTodayTasks.length} total):\n`;
    rundown += uniqueTodayTasks.slice(0, 4).map(t => {
      const projectName = this.getTaskProjectName(t);
      return `   • ${t.name}${projectName ? ` _[${projectName}]_` : ''}`;
    }).join('\n');
    if (uniqueTodayTasks.length > 4) {
      rundown += `\n   _...and ${uniqueTodayTasks.length - 4} more due today_`;
    }
    rundown += '\n\n';
  }
}
    }

    // FIXED: Now projectRollup is always defined
    const insights = this.generateFocusedDailyInsights({
      events: todaysEvents,
      tasks: todaysTasks,
      overdue: overdueTasks,
      timezone: userTimezone,
      projectCount: Object.keys(projectRollup.byProject || {}).length
    });
    
    if (insights) {
      rundown += `💡 *Donna's Take:*\n${insights}\n\n`;
    }

    // Call to action
    rundown += `_Ready to tackle the day? I'm here when you need me._`;

    await client.chat.postMessage({
      channel,
      thread_ts,
      text: rundown
    });

  } catch (error) {
    console.error('Daily rundown error:', error);
    console.error('Error stack:', error.stack);
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Sorry, I had trouble generating your rundown: ${error.message}`
    });
  }
}


// FIXED: Enhanced project rollup with better error handling
async generateProjectRollup(allTasks, overdueTasks, todaysTasks) {
  console.log(`Generating project rollup for ${allTasks.length} tasks`);
  
  const rollup = {
    byProject: {},
    hasMultipleProjects: false,
    totalProjects: 0
  };
  
  try {
    const projectCache = new Map();
    
    // Organize tasks by project
    for (const task of allTasks) {
      if (!task) continue; // Skip invalid tasks
      
      const projectInfo = this.getTaskProjectInfo(task);
      const projectName = projectInfo.name;
      
      if (!rollup.byProject[projectName]) {
        rollup.byProject[projectName] = {
          allTasks: [],
          overdueTasks: [],
          todayTasks: [],
          projectId: projectInfo.id,
          url: null
        };
        
        // Get Asana project URL
        if (projectInfo.id && !projectCache.has(projectInfo.id)) {
          const projectUrl = `https://app.asana.com/0/${projectInfo.id}`;
          projectCache.set(projectInfo.id, projectUrl);
        }
        rollup.byProject[projectName].url = projectCache.get(projectInfo.id);
      }
      
      // Add to appropriate task lists with null checks
      rollup.byProject[projectName].allTasks.push(task);
      
      if (overdueTasks && overdueTasks.some(o => o && o.gid === task.gid)) {
        rollup.byProject[projectName].overdueTasks.push(task);
      }
      
      if (todaysTasks && todaysTasks.some(t => t && t.gid === task.gid)) {
        rollup.byProject[projectName].todayTasks.push(task);
      }
    }
    
    rollup.totalProjects = Object.keys(rollup.byProject).length;
    rollup.hasMultipleProjects = rollup.totalProjects > 1;
    
    console.log(`Project rollup complete: ${rollup.totalProjects} projects, multiple: ${rollup.hasMultipleProjects}`);
    
    return rollup;
    
  } catch (error) {
    console.error('Error in generateProjectRollup:', error);
    return {
      byProject: {},
      hasMultipleProjects: false,
      totalProjects: 0
    };
  }
}




// UPDATED: Enhanced project rollup with separate task categorization
async generateProjectRollup(allTasks, overdueTasks, todaysTasks) {
  const rollup = {
    byProject: {},
    hasMultipleProjects: false,
    totalProjects: 0
  };
  
  const projectCache = new Map();
  
  // Organize tasks by project
  for (const task of allTasks) {
    const projectInfo = this.getTaskProjectInfo(task);
    const projectName = projectInfo.name;
    
    if (!rollup.byProject[projectName]) {
      rollup.byProject[projectName] = {
        allTasks: [],
        overdueTasks: [],
        todayTasks: [],
        projectId: projectInfo.id,
        url: null
      };
      
      // Get Asana project URL
      if (projectInfo.id && !projectCache.has(projectInfo.id)) {
        const projectUrl = `https://app.asana.com/0/${projectInfo.id}`;
        projectCache.set(projectInfo.id, projectUrl);
      }
      rollup.byProject[projectName].url = projectCache.get(projectInfo.id);
    }
    
    // Add to appropriate task lists
    rollup.byProject[projectName].allTasks.push(task);
    
    if (overdueTasks.some(o => o.gid === task.gid)) {
      rollup.byProject[projectName].overdueTasks.push(task);
    }
    
    if (todaysTasks.some(t => t.gid === task.gid)) {
      rollup.byProject[projectName].todayTasks.push(task);
    }
  }
  
  rollup.totalProjects = Object.keys(rollup.byProject).length;
  rollup.hasMultipleProjects = rollup.totalProjects > 1;
  
  return rollup;
}

// UPDATED: Better project info extraction
getTaskProjectInfo(task) {
  if (task.projects && task.projects.length > 0) {
    const project = task.projects[0]; // Use primary project
    return {
      name: project.name || 'Unnamed Project',
      id: project.gid
    };
  }
  return {
    name: 'No Project',
    id: null
  };
}


// NEW: Generate project rollup with Asana board links
async generateProjectRollup(tasks) {
  const rollup = {
    byProject: {},
    hasMultipleProjects: false,
    totalProjects: 0
  };
  
  const projectCache = new Map(); // Cache project details to avoid duplicate API calls
  
  for (const task of tasks) {
    if (task.projects && task.projects.length > 0) {
      const project = task.projects[0]; // Use primary project
      const projectName = project.name || 'Unnamed Project';
      
      if (!rollup.byProject[projectName]) {
        rollup.byProject[projectName] = {
          tasks: [],
          projectId: project.gid,
          url: null
        };
        
        // Try to get project URL (Asana board link)
        try {
          if (!projectCache.has(project.gid)) {
            // Construct Asana project URL
            const baseUrl = 'https://app.asana.com/0';
            const projectUrl = `${baseUrl}/${project.gid}`;
            projectCache.set(project.gid, projectUrl);
          }
          rollup.byProject[projectName].url = projectCache.get(project.gid);
        } catch (error) {
          console.log(`Could not get URL for project ${projectName}:`, error.message);
        }
      }
      
      rollup.byProject[projectName].tasks.push(task);
    } else {
      // Tasks without projects
      if (!rollup.byProject['No Project']) {
        rollup.byProject['No Project'] = {
          tasks: [],
          projectId: null,
          url: null
        };
      }
      rollup.byProject['No Project'].tasks.push(task);
    }
  }
  
  rollup.totalProjects = Object.keys(rollup.byProject).length;
  rollup.hasMultipleProjects = rollup.totalProjects > 1;
  
  return rollup;
}

// NEW: Remove duplicate tasks (tasks that appear in both overdue and due today)
deduplicateTasks(tasks) {
  const seen = new Set();
  return tasks.filter(task => {
    if (seen.has(task.gid)) {
      return false;
    }
    seen.add(task.gid);
    return true;
  });
}

// NEW: Get primary project name for a task
getTaskProjectName(task) {
  if (task.projects && task.projects.length > 0) {
    return task.projects[0].name;
  }
  return null;
}

// UPDATED: Enhanced insights with project context
generateFocusedDailyInsights({ events, tasks, overdue, timezone, projectCount }) {
  const insights = [];
  
  // Calendar-first insights
  if (events.length === 0) {
    insights.push("Clear calendar today - perfect for tackling those overdue tasks.");
  } else if (events.length >= 4) {
    insights.push("Heavy meeting day - block 15-min buffers between calls.");
  } else if (events.length >= 2) {
    insights.push("Solid meeting schedule - good mix of collaboration and focus time.");
  }
  
  // Enhanced task insights with project context
  if (overdue.length > 15) {
    insights.push(`Major backlog across ${projectCount} projects - consider doing a priority triage session.`);
  } else if (overdue.length > 5) {
    insights.push("Focus on clearing overdue tasks before starting new work.");
  }
  
  if (projectCount > 4) {
    insights.push("Multi-project day - consider batching work by project for better focus.");
  }
  
  if (tasks.length > 10) {
    insights.push("Ambitious task list - pick your top 3 priorities for today.");
  }
  
  // Time management
  const now = new Date();
  const hour = new Date(now.toLocaleString('en-US', { timeZone: timezone })).getHours();
  
  if (hour < 9 && events.length > 0) {
    insights.push("Early start - prep for your first meeting with coffee in hand.");
  }
  
  // Back-to-back meeting detection
  if (this.hasBackToBackMeetings(events, timezone)) {
    insights.push("Back-to-back meetings ahead - schedule bathroom/stretch breaks.");
  }
  
  return insights.length > 0 ? insights.join(' ') : null;
}
  // NEW: Calendar rundown for specific periods
  async handleCalendarRundown({ slots, client, channel, thread_ts, userId }) {
    try {
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      const { period = 'week' } = slots;
      
      let events = [];
      let title = '';
      
      switch (period.toLowerCase()) {
        case 'week':
        case 'this week':
          events = await googleCalendarService.getEventsThisWeek(userTimezone);
          title = '*This Week\'s Calendar Overview:*';
          break;
        case 'today':
          events = await googleCalendarService.getEventsToday(userTimezone);
          title = '*Today\'s Calendar:*';
          break;
        case 'tomorrow':
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          events = await googleCalendarService.getEventsForDate(tomorrow, userTimezone);
          title = '*Tomorrow\'s Calendar:*';
          break;
        default:
          events = await googleCalendarService.getEventsThisWeek(userTimezone);
          title = '*Calendar Overview:*';
      }
      
      if (events.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `${title}\nNo meetings scheduled. Time for deep work! 🎯`
        });
      }
      
      let message = title + '\n\n';
      
      if (period === 'week' || period === 'this week') {
        // Group by day for weekly view
        const groupedEvents = googleCalendarService.groupEventsByDate(events, userTimezone);
        
        for (const [date, dayEvents] of Object.entries(groupedEvents)) {
          message += `*${date}:*\n`;
          message += dayEvents.map(e => googleCalendarService.formatEvent(e, false, userTimezone)).join('\n') + '\n\n';
        }
        
        // Add weekly insights
        const busyDays = Object.keys(groupedEvents).filter(date => groupedEvents[date].length >= 3);
        if (busyDays.length > 0) {
          message += `📊 *This week:* ${busyDays.length} busy day${busyDays.length > 1 ? 's' : ''}, ${events.length} total meetings\n`;
        }
      } else {
        // Simple list for single day
        message += events.map(e => googleCalendarService.formatEvent(e, true, userTimezone)).join('\n\n');
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message.trim()
      });
      
    } catch (error) {
      console.error('Calendar rundown error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble generating your calendar rundown: ${error.message}`
      });
    }
  }

  // NEW: Update existing meeting
  async handleUpdateMeeting({ slots, client, channel, thread_ts, userId }) {
    try {
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      const { event_id, field, value } = slots;
      
      if (!event_id || !field || value === undefined) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need an event ID, field to update, and new value. Try: "update meeting abc123 title to New Meeting Name"'
        });
      }
      
      let updateData = {};
      
      // Parse different field types
      switch (field.toLowerCase()) {
        case 'title':
        case 'summary':
          updateData.summary = value;
          break;
          
        case 'time':
        case 'start_time':
          // This would need more complex parsing for time updates
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: 'Time updates are complex. Try rescheduling the meeting instead.'
          });
          
        case 'location':
          updateData.location = value;
          break;
          
        case 'description':
        case 'notes':
          updateData.description = value;
          break;
          
        default:
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `I don't know how to update "${field}". I can update: title, location, or description.`
          });
      }
      
      const updatedEvent = await googleCalendarService.updateEvent(event_id, updateData);
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `✅ Updated meeting: *${updatedEvent.summary}*`
      });
      
    } catch (error) {
      console.error('Update meeting error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't update that meeting: ${error.message}`
      });
    }
  }

  // NEW: Delete meeting
  async handleDeleteMeeting({ slots, client, channel, thread_ts, userId }) {
    try {
      const { event_id } = slots;
      
      if (!event_id) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need an event ID to delete a meeting. Try: "delete meeting abc123"'
        });
      }
      
      await googleCalendarService.deleteEvent(event_id);
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: '🗑️ Meeting deleted. Gone like it never existed.'
      });
      
    } catch (error) {
      console.error('Delete meeting error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't delete that meeting: ${error.message}`
      });
    }
  }

  // NEW: Helper to get next meeting today only
  async getNextMeetingToday(userTimezone) {
    try {
      const now = new Date();
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      
      const events = await googleCalendarService.getEvents({
        timeMin: now.toISOString(),
        timeMax: endOfDay.toISOString(),
        maxResults: 1
      });
      
      return events.length > 0 ? events[0] : null;
    } catch (error) {
      console.error('Error getting next meeting:', error);
      return null;
    }
  }

  // NEW: Generate intelligent daily insights
  generateDailyInsights({ events, tasks, overdue, timezone }) {
    const insights = [];
    
    // Meeting density analysis
    if (events.length >= 5) {
      insights.push("Heavy meeting day - block buffer time between calls.");
    } else if (events.length >= 3) {
      insights.push("Solid meeting day - consider prepping in batches.");
    } else if (events.length === 0) {
      insights.push("Clear calendar day - perfect for deep project work.");
    }
    
    // Task management insights
    if (overdue.length > 3) {
      insights.push("Priority alert: Clear overdue tasks before starting new work.");
    } else if (overdue.length > 0) {
      insights.push("Quick wins: Tackle those overdue tasks first.");
    }
    
    if (tasks.length > 7) {
      insights.push("Ambitious task list - focus on the top 3 priorities.");
    } else if (tasks.length === 0 && events.length === 0) {
      insights.push("Light day ahead - good time for strategic planning.");
    }
    
    // Time management based on current hour
    const now = new Date();
    const hour = new Date(now.toLocaleString('en-US', { timeZone: timezone })).getHours();
    
    if (hour < 9 && events.length > 0) {
      insights.push("Early start - grab coffee and prep for your first meeting.");
    } else if (hour >= 9 && hour < 12 && events.filter(e => {
      const eventHour = new Date(e.start.dateTime).getHours();
      return eventHour < 12;
    }).length >= 2) {
      insights.push("Morning is packed - energy drinks and focused execution.");
    }
    
    // Meeting pattern insights
    const backToBackMeetings = this.hasBackToBackMeetings(events, timezone);
    if (backToBackMeetings) {
      insights.push("Back-to-back meetings detected - schedule 5-min breaks.");
    }
    
    return insights.length > 0 ? insights.join(' ') : null;
  }

  // Helper: Check for back-to-back meetings
  hasBackToBackMeetings(events, timezone) {
    if (events.length < 2) return false;
    
    for (let i = 0; i < events.length - 1; i++) {
      const currentEnd = new Date(events[i].end.dateTime);
      const nextStart = new Date(events[i + 1].start.dateTime);
      
      // Less than 15 minutes between meetings = back-to-back
      const timeBetween = (nextStart - currentEnd) / (1000 * 60);
      if (timeBetween < 15) {
        return true;
      }
    }
    
    return false;
  }

  // Helper: Format time until next event (unchanged)
  formatTimeUntil(eventTime) {
    const now = new Date();
    const diff = eventTime - now;
    const minutes = Math.floor(diff / (1000 * 60));
    
    if (minutes < 0) {
      return 'Started ' + Math.abs(minutes) + ' minutes ago';
    } else if (minutes === 0) {
      return 'Starting now';
    } else if (minutes < 60) {
      return `In ${minutes} minutes`;
    } else {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      if (remainingMinutes === 0) {
        return `In ${hours} hour${hours > 1 ? 's' : ''}`;
      } else {
        return `In ${hours}h ${remainingMinutes}m`;
      }
    }
  }
}

module.exports = new CalendarHandler();