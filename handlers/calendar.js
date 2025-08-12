// handlers/calendar.js - Handle calendar-related intents
const googleCalendarService = require('../services/googleCalendar');
const dataStore = require('../utils/dataStore');

class CalendarHandler {
  // Handle requests to check calendar/meetings
  async handleCheckCalendar({ slots, client, channel, thread_ts }) {
    try {
      const { date, period = 'today' } = slots;
      
      let events = [];
      let title = '';
      
      if (date && date !== 'today' && date !== 'tomorrow') {
        // Specific date requested (not today/tomorrow keywords)
        events = await googleCalendarService.getEventsForDate(date);
        const dateObj = new Date(date);
        title = `*Meetings on ${dateObj.toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric',
          timeZone: 'America/New_York'
        })}:*`;
      } else {
        // Period-based or keyword-based request
        const requestedPeriod = date || period; // Use date if it's 'today'/'tomorrow', otherwise use period
        
        switch (requestedPeriod.toLowerCase()) {
          case 'today':
            events = await googleCalendarService.getEventsToday();
            title = '*Today\'s meetings:*';
            break;
            
          case 'tomorrow':
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            events = await googleCalendarService.getEventsForDate(tomorrow);
            title = `*Tomorrow's meetings (${tomorrow.toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric',
              timeZone: 'America/New_York'
            })}):*`;
            break;
            
          case 'this week':
          case 'this_week':
          case 'week':
            events = await googleCalendarService.getEventsThisWeek();
            title = '*This week\'s meetings:*';
            break;
            
          default:
            events = await googleCalendarService.getEventsToday();
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
      
      // Format events for display
      let message = title + '\n\n';
      
      if (period === 'this week' || period === 'week') {
        // Group by day for weekly view
        const groupedEvents = googleCalendarService.groupEventsByDate(events);
        
        for (const [date, dayEvents] of Object.entries(groupedEvents)) {
          message += `*${date}:*\n`;
          message += dayEvents.map(e => googleCalendarService.formatEvent(e, true)).join('\n') + '\n\n';
        }
      } else {
        // Simple list for single day
        message += events.map(e => googleCalendarService.formatEvent(e, true)).join('\n\n');
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

  // Handle blocking time on calendar (personal time blocking)
  async handleBlockTime({ slots, client, channel, thread_ts }) {
    try {
      const { 
        title, 
        date, 
        start_time, 
        end_time,
        duration = 60
      } = slots;
      
      if (!title || !date || !start_time) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a title, date, and start time to block calendar time. Try: "block time for deep work tomorrow 2-4pm"'
        });
      }
      
      // Parse date and time
      let startTime, endTime;
      
      if (end_time) {
        // User provided both start and end time - use time range parser
        const timeRange = googleCalendarService.parseTimeRange(date, start_time, end_time);
        startTime = timeRange.startTime;
        endTime = timeRange.endTime;
      } else {
        // Use duration
        const { startTime: parsedStart, endTime: parsedEnd } = googleCalendarService.parseDateTime(date, start_time, duration);
        startTime = parsedStart;
        endTime = parsedEnd;
      }
      
      // Create the calendar event (no attendees for time blocking)
      const event = await googleCalendarService.createEvent({
        summary: title,
        description: 'Time blocked via Donna',
        startTime,
        endTime,
        attendees: [], // No attendees for personal time blocking
        location: '',
        meetingType: null
      });
      
      // Format confirmation message
      const eventDate = new Date(event.start.dateTime);
      const eventEndDate = new Date(event.end.dateTime);
      const timeStr = `${eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
      })} - ${eventEndDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
      })}`;
      const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York'
      });
      
      let message = `✅ Time blocked: *${event.summary}*\n`;
      message += `📅 ${dateStr} at ${timeStr}\n`;
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
  async handleCreateMeeting({ slots, client, channel, thread_ts }) {
    try {
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
      
      // Parse date and time
      const { startTime, endTime } = googleCalendarService.parseDateTime(date, start_time, duration);
      
      // Parse attendees (split by comma if it's a string)
      const attendeeList = typeof attendees === 'string' ? 
        attendees.split(',').map(email => email.trim()) : 
        attendees;
      
      // Create the event
      const event = await googleCalendarService.createEvent({
        summary: title,
        description,
        startTime,
        endTime,
        attendees: attendeeList,
        location,
        meetingType: meeting_type
      });
      
      // Format confirmation message
      const eventDate = new Date(event.start.dateTime);
      const timeStr = eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
      });
      const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'America/New_York'
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

  // Handle updating existing meetings
  async handleUpdateMeeting({ slots, client, channel, thread_ts }) {
    try {
      const { event_id, field, value } = slots;
      
      if (!event_id || !field || value === undefined) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need an event ID, field to update, and new value. Try: "reschedule meeting ABC123 to 3pm" or "add john@company.com to meeting ABC123"'
        });
      }
      
      let updateData = {};
      
      switch (field.toLowerCase()) {
        case 'title':
        case 'summary':
          updateData.summary = value;
          break;
          
        case 'time':
        case 'start_time':
          // This would need more complex logic to parse and update start/end times
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: 'Time updates are complex. It\'s easier to delete and recreate the meeting. Want me to help with that?'
          });
          
        case 'location':
          updateData.location = value;
          break;
          
        case 'description':
        case 'notes':
          updateData.description = value;
          break;
          
        case 'attendees':
          // Add attendee
          updateData.attendees = value.split(',').map(email => ({ email: email.trim() }));
          break;
          
        default:
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `I don't know how to update "${field}". I can update: title, location, description, or attendees.`
          });
      }
      
      const updatedEvent = await googleCalendarService.updateEvent(event_id, updateData);
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `✅ Updated meeting: *${updatedEvent.summary}*\nChange: ${field} → ${value}`
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

  // Handle deleting meetings
  async handleDeleteMeeting({ slots, client, channel, thread_ts }) {
    try {
      const { event_id } = slots;
      
      if (!event_id) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need the event ID to delete a meeting. Which meeting should I cancel?'
        });
      }
      
      await googleCalendarService.deleteEvent(event_id);
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: '✅ Meeting deleted and attendees notified.\n_That felt satisfying, didn\'t it?_'
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

  // Handle "what's next" type queries
  async handleNextMeeting({ client, channel, thread_ts }) {
    try {
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
      
      // Add meeting details
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

  // Generate a daily calendar rundown
  async handleCalendarRundown({ client, channel, thread_ts }) {
    try {
      const todayEvents = await googleCalendarService.getEventsToday();
      const tomorrowEvents = await googleCalendarService.getEventsForDate(
        new Date(Date.now() + 24 * 60 * 60 * 1000)
      );
      
      let rundown = '*Calendar Rundown*\n\n';
      
      // Today's meetings
      if (todayEvents.length > 0) {
        rundown += '*Today:*\n';
        rundown += todayEvents.map(e => googleCalendarService.formatEvent(e, false)).join('\n') + '\n\n';
      } else {
        rundown += '*Today:* Clear calendar ✨\n\n';
      }
      
      // Tomorrow preview
      if (tomorrowEvents.length > 0) {
        rundown += '*Tomorrow preview:*\n';
        rundown += tomorrowEvents.slice(0, 3).map(e => googleCalendarService.formatEvent(e, false)).join('\n');
        if (tomorrowEvents.length > 3) {
          rundown += `\n_...and ${tomorrowEvents.length - 3} more_`;
        }
        rundown += '\n\n';
      }
      
      // Add context based on schedule
      if (todayEvents.length === 0) {
        rundown += '_Perfect day to focus on deep work._';
      } else if (todayEvents.length >= 5) {
        rundown += '_Heavy meeting day. Block time between calls to breathe._';
      } else {
        rundown += '_Balanced day ahead. Make it count._';
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: rundown
      });
      
    } catch (error) {
      console.error('Calendar rundown error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't generate your calendar rundown: ${error.message}`
      });
    }
  }

  // Helper: Format time until next event
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

  // Helper: Find meeting by partial title (for updates/deletes)
  async findMeetingByTitle(title, timeframe = 'today') {
    let events;
    
    switch (timeframe) {
      case 'today':
        events = await googleCalendarService.getEventsToday();
        break;
      case 'this week':
        events = await googleCalendarService.getEventsThisWeek();
        break;
      default:
        events = await googleCalendarService.getEventsToday();
    }
    
    const searchTitle = title.toLowerCase().trim();
    
    // Exact match first
    let match = events.find(e => e.summary && e.summary.toLowerCase() === searchTitle);
    if (match) return match;
    
    // Partial match
    match = events.find(e => e.summary && e.summary.toLowerCase().includes(searchTitle));
    if (match) return match;
    
    return null;
  }
}

module.exports = new CalendarHandler();