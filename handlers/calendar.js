// handlers/calendar.js - Updated to get and use user timezone
const googleCalendarService = require('../services/googleCalendar');
const TimezoneHelper = require('../utils/timezoneHelper');
const dataStore = require('../utils/dataStore');

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

  // ... Other methods (handleUpdateMeeting, handleDeleteMeeting, etc.) 
  // also need similar updates to include userId parameter and get user timezone

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