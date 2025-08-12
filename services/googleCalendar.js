// services/googleCalendar.js - Google Calendar API integration with timezone support (CORRECTED)
const { google } = require('googleapis');
const dataStore = require('../utils/dataStore');

class GoogleCalendarService {
  constructor() {
    this.credentials = this.parseCredentials();
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.auth = null;
    this.calendar = null;
    // Keep default timezone for backward compatibility
    this.defaultTimezone = 'America/New_York';
    
    if (this.credentials) {
      this.initializeAuth();
    } else {
      console.warn('Google Calendar credentials not configured');
    }
  }

  parseCredentials() {
    // Support both service account JSON file and environment variables
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      } catch (error) {
        console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', error.message);
        return null;
      }
    }
    
    // Alternative: individual environment variables
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      return {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        project_id: process.env.GOOGLE_PROJECT_ID
      };
    }
    
    return null;
  }

  async initializeAuth() {
    try {
      this.auth = new google.auth.GoogleAuth({
        credentials: this.credentials,
        scopes: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.events'
        ]
      });
      
      this.calendar = google.calendar({ version: 'v3', auth: this.auth });
      console.log('✅ Google Calendar API initialized');
    } catch (error) {
      console.error('Failed to initialize Google Calendar API:', error.message);
      throw error;
    }
  }

  async ensureAuth() {
    if (!this.calendar) {
      throw new Error('Google Calendar not configured. Please set GOOGLE_SERVICE_ACCOUNT_JSON or individual credential environment variables.');
    }
  }

  // Helper to create date in specific timezone (enhanced)
  createDateInUserTimezone(dateComponents, userTimezone = this.defaultTimezone) {
    const { year, month, day, hours = 0, minutes = 0, seconds = 0 } = dateComponents;
    
    console.log(`Creating date in timezone ${userTimezone}:`, dateComponents);
    
    // Create a properly formatted date string for the user's timezone
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    const dateString = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    
    // Create the date in the user's timezone using a more reliable method
    const isoString = `${dateString}T${timeString}`;
    
    // Get the timezone offset for the user's timezone at this specific date
    const tempDate = new Date(isoString);
    const utcTime = tempDate.getTime() + (tempDate.getTimezoneOffset() * 60000);
    
    // Get the offset for the user's timezone
    const userTimezoneOffset = this.getTimezoneOffset(tempDate, userTimezone);
    
    // Create the final date adjusted for the user's timezone
    const userTime = new Date(utcTime + (userTimezoneOffset * 60000));
    
    return userTime;
  }

  // Get timezone offset for a specific timezone and date
  getTimezoneOffset(date, timeZone) {
    try {
      // Use Intl.DateTimeFormat to get the timezone offset
      const utcDate = new Date(date.toISOString());
      const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
      
      // The difference between UTC and timezone gives us the offset in milliseconds
      const offsetMs = tzDate.getTime() - utcDate.getTime();
      
      // Convert to minutes
      return offsetMs / (1000 * 60);
    } catch (error) {
      console.error(`Error calculating timezone offset for ${timeZone}:`, error);
      return 0; // Default to UTC
    }
  }

  // Get current date in specific timezone
  getCurrentDateInUserTimezone(userTimezone = this.defaultTimezone) {
    try {
      const now = new Date();
      
      // Get components in user's timezone
      const userDate = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
      
      return {
        year: userDate.getFullYear(),
        month: userDate.getMonth(),
        day: userDate.getDate()
      };
    } catch (error) {
      console.error(`Error getting current date in timezone ${userTimezone}:`, error);
      // Fallback to system time
      const now = new Date();
      return {
        year: now.getFullYear(),
        month: now.getMonth(),
        day: now.getDate()
      };
    }
  }

  // Get events for a specific date range
  async getEvents({
    timeMin = new Date().toISOString(),
    timeMax = null,
    maxResults = 50,
    orderBy = 'startTime',
    singleEvents = true
  } = {}) {
    await this.ensureAuth();

    const cacheKey = `gcal_events_${timeMin}_${timeMax}_${maxResults}`;
    const cached = dataStore.getCachedData(cacheKey, 300000); // 5 min cache
    if (cached) return cached;

    try {
      const params = {
        calendarId: this.calendarId,
        timeMin,
        maxResults,
        singleEvents,
        orderBy
      };
      
      if (timeMax) params.timeMax = timeMax;

      const response = await this.calendar.events.list(params);
      const events = response.data.items || [];
      
      dataStore.setCachedData(cacheKey, events);
      return events;
    } catch (error) {
      console.error('Error fetching calendar events:', error);
      throw new Error(`Google Calendar API error: ${error.message}`);
    }
  }

  // Get events for today (with optional timezone)
  async getEventsToday(userTimezone = this.defaultTimezone) {
    const { startOfDay, endOfDay } = this.getTodayDateRange(userTimezone);
    
    return this.getEvents({
      timeMin: startOfDay,
      timeMax: endOfDay
    });
  }

  // Get events for this week (with optional timezone)
  async getEventsThisWeek(userTimezone = this.defaultTimezone) {
    const { startOfWeek, endOfWeek } = this.getWeekDateRange(userTimezone);
    
    return this.getEvents({
      timeMin: startOfWeek,
      timeMax: endOfWeek
    });
  }

  // Get events for a specific date (with optional timezone)
  async getEventsForDate(date, userTimezone = this.defaultTimezone) {
    const { startOfDay, endOfDay } = this.getDateRange(date, userTimezone);
    
    return this.getEvents({
      timeMin: startOfDay,
      timeMax: endOfDay
    });
  }

  // Get today's date range in specific timezone
  getTodayDateRange(userTimezone = this.defaultTimezone) {
    const today = this.getCurrentDateInUserTimezone(userTimezone);
    
    const startOfDay = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day,
      hours: 0,
      minutes: 0,
      seconds: 0
    }, userTimezone);
    
    const endOfDay = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day,
      hours: 23,
      minutes: 59,
      seconds: 59
    }, userTimezone);
    
    return {
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString()
    };
  }

  // Get week date range in specific timezone
  getWeekDateRange(userTimezone = this.defaultTimezone) {
    const today = this.getCurrentDateInUserTimezone(userTimezone);
    
    // Get the current day of the week (0 = Sunday)
    const currentDate = this.createDateInUserTimezone(today, userTimezone);
    const dayOfWeek = currentDate.getDay();
    
    // Calculate start of week (Sunday)
    const startOfWeek = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day - dayOfWeek,
      hours: 0,
      minutes: 0,
      seconds: 0
    }, userTimezone);
    
    // Calculate end of week (Saturday)
    const endOfWeek = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day - dayOfWeek + 6,
      hours: 23,
      minutes: 59,
      seconds: 59
    }, userTimezone);
    
    return {
      startOfWeek: startOfWeek.toISOString(),
      endOfWeek: endOfWeek.toISOString()
    };
  }

  // Get specific date range in timezone
  getDateRange(dateInput, userTimezone = this.defaultTimezone) {
    if (typeof dateInput === 'string' && dateInput.toLowerCase() === 'today') {
      return this.getTodayDateRange(userTimezone);
    }
    
    let targetDate;
    
    if (typeof dateInput === 'string' && dateInput.toLowerCase() === 'tomorrow') {
      // Get tomorrow in user's timezone
      const today = this.getCurrentDateInUserTimezone(userTimezone);
      targetDate = {
        year: today.year,
        month: today.month,
        day: today.day + 1
      };
    } else if (typeof dateInput === 'string') {
      // Parse date string in user's timezone
      const parsed = this.parseDate(dateInput, userTimezone);
      targetDate = {
        year: parsed.year,
        month: parsed.month,
        day: parsed.day
      };
    } else {
      // Handle Date object
      try {
        const userDate = new Date(dateInput.toLocaleString('en-US', { timeZone: userTimezone }));
        targetDate = {
          year: userDate.getFullYear(),
          month: userDate.getMonth(),
          day: userDate.getDate()
        };
      } catch (error) {
        console.error(`Error parsing date in timezone ${userTimezone}:`, error);
        targetDate = {
          year: dateInput.getFullYear(),
          month: dateInput.getMonth(),
          day: dateInput.getDate()
        };
      }
    }
    
    const startOfDay = this.createDateInUserTimezone({
      ...targetDate,
      hours: 0,
      minutes: 0,
      seconds: 0
    }, userTimezone);
    
    const endOfDay = this.createDateInUserTimezone({
      ...targetDate,
      hours: 23,
      minutes: 59,
      seconds: 59
    }, userTimezone);
    
    return {
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString()
    };
  }

  // Create a new calendar event
  async createEvent({
    summary,
    description = '',
    startTime,
    endTime,
    attendees = [],
    location = '',
    meetingType = null, // 'google-meet', 'zoom', or null
    timeZone = 'America/New_York'
  }) {
    await this.ensureAuth();

    const eventData = {
      summary,
      description,
      location,
      start: {
        dateTime: startTime,
        timeZone
      },
      end: {
        dateTime: endTime,
        timeZone
      },
      attendees: attendees.map(email => ({ email })),
      reminders: {
        useDefault: true
      }
    };

    // Add Google Meet if requested
    if (meetingType === 'google-meet') {
      eventData.conferenceData = {
        createRequest: {
          requestId: this.generateRequestId(),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      };
    }

    try {
      const response = await this.calendar.events.insert({
        calendarId: this.calendarId,
        resource: eventData,
        conferenceDataVersion: meetingType === 'google-meet' ? 1 : 0
      });

      // Clear cache to force refresh
      dataStore.apiCache.clear();
      
      return response.data;
    } catch (error) {
      console.error('Error creating calendar event:', error);
      throw new Error(`Failed to create calendar event: ${error.message}`);
    }
  }

  // Update an existing event
  async updateEvent(eventId, updates) {
    await this.ensureAuth();

    try {
      const response = await this.calendar.events.patch({
        calendarId: this.calendarId,
        eventId,
        resource: updates
      });

      dataStore.apiCache.clear();
      return response.data;
    } catch (error) {
      console.error('Error updating calendar event:', error);
      throw new Error(`Failed to update calendar event: ${error.message}`);
    }
  }

  // Delete a calendar event
  async deleteEvent(eventId) {
    await this.ensureAuth();

    try {
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId
      });

      dataStore.apiCache.clear();
      return true;
    } catch (error) {
      console.error('Error deleting calendar event:', error);
      throw new Error(`Failed to delete calendar event: ${error.message}`);
    }
  }

  // Helper: Format event for display in Slack (with optional timezone)
  formatEvent(event, includeDetails = true, userTimezone = this.defaultTimezone) {
    const start = new Date(event.start.dateTime || event.start.date);
    const end = new Date(event.end.dateTime || event.end.date);
    
    // Handle all-day events
    const isAllDay = !event.start.dateTime;
    
    let timeStr = '';
    if (isAllDay) {
      timeStr = 'All day';
    } else {
      const startTime = start.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      });
      const endTime = end.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      });
      timeStr = `${startTime} - ${endTime}`;
    }

    let formatted = `• *${event.summary || 'Untitled Event'}* (${timeStr})`;
    
    if (includeDetails) {
      // Add attendees info
      if (event.attendees && event.attendees.length > 0) {
        const attendeeNames = event.attendees
          .filter(a => a.email !== process.env.GOOGLE_CALENDAR_EMAIL) // Exclude self
          .map(a => a.displayName || a.email.split('@')[0])
          .slice(0, 3); // Limit to first 3
        
        if (attendeeNames.length > 0) {
          formatted += `\n  _with ${attendeeNames.join(', ')}${event.attendees.length > 3 ? ' +others' : ''}_`;
        }
      }
      
      // Add meeting link
      const meetingLink = this.extractMeetingLink(event);
      if (meetingLink) {
        formatted += `\n  🔗 ${meetingLink}`;
      }
      
      // Add location
      if (event.location && !this.isMeetingLink(event.location)) {
        formatted += `\n  📍 ${event.location}`;
      }
    }
    
    return formatted;
  }

  // Helper: Extract meeting links from event
  extractMeetingLink(event) {
    // Check conference data (Google Meet)
    if (event.conferenceData && event.conferenceData.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
      if (videoEntry) return videoEntry.uri;
    }
    
    // Check location field for Zoom/other links
    if (event.location && this.isMeetingLink(event.location)) {
      return event.location;
    }
    
    // Check description for meeting links
    if (event.description) {
      const linkPattern = /(https?:\/\/[^\s]+(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)[^\s]*)/i;
      const match = event.description.match(linkPattern);
      if (match) return match[1];
    }
    
    return null;
  }

  // Helper: Check if string is a meeting link
  isMeetingLink(str) {
    return /https?:\/\/[^\s]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)/i.test(str);
  }

  // Helper: Group events by date (with optional timezone)
  groupEventsByDate(events, userTimezone = this.defaultTimezone) {
    const grouped = {};
    
    events.forEach(event => {
      const date = new Date(event.start.dateTime || event.start.date);
      const dateStr = date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: userTimezone
      });
      
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(event);
    });
    
    return grouped;
  }

  // Parse natural language time to ISO string in specific timezone
  parseDateTime(dateStr, timeStr, defaultDuration = 60, userTimezone = this.defaultTimezone) {
    const dateComponents = this.parseDate(dateStr, userTimezone);
    
    if (timeStr) {
      const time = this.parseTime(timeStr);
      
      const startDate = this.createDateInUserTimezone({
        year: dateComponents.year,
        month: dateComponents.month,
        day: dateComponents.day,
        hours: time.hours,
        minutes: time.minutes,
        seconds: 0
      }, userTimezone);
      
      const endDate = new Date(startDate.getTime() + defaultDuration * 60 * 1000);
      
      return { 
        startTime: startDate.toISOString(), 
        endTime: endDate.toISOString() 
      };
    }
    
    // Default to current time if no time specified
    const now = new Date();
    const currentTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
    
    const startDate = this.createDateInUserTimezone({
      year: dateComponents.year,
      month: dateComponents.month,
      day: dateComponents.day,
      hours: currentTime.getHours(),
      minutes: currentTime.getMinutes(),
      seconds: 0
    }, userTimezone);
    
    const endDate = new Date(startDate.getTime() + defaultDuration * 60 * 1000);
    
    return { 
      startTime: startDate.toISOString(), 
      endTime: endDate.toISOString() 
    };
  }

  // Parse natural language dates in specific timezone
  parseDate(dateStr, userTimezone = this.defaultTimezone) {
    const str = dateStr.toLowerCase().trim();
    
    // Get current date in user's timezone
    const today = this.getCurrentDateInUserTimezone(userTimezone);
    
    switch (str) {
      case 'today':
        return today;
        
      case 'tomorrow':
        return {
          year: today.year,
          month: today.month,
          day: today.day + 1
        };
        
      case 'yesterday':
        return {
          year: today.year,
          month: today.month,
          day: today.day - 1
        };
        
      case 'next week':
        return {
          year: today.year,
          month: today.month,
          day: today.day + 7
        };
        
      default:
        // Handle weekday names
        const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = weekdays.indexOf(str);
        
        if (targetDay !== -1) {
          const currentDate = this.createDateInUserTimezone(today, userTimezone);
          const currentDay = currentDate.getDay();
          let daysUntilTarget = targetDay - currentDay;
          if (daysUntilTarget <= 0) daysUntilTarget += 7; // Next occurrence
          
          return {
            year: today.year,
            month: today.month,
            day: today.day + daysUntilTarget
          };
        }
        
        // Try to parse as a standard date
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          try {
            const userParsed = new Date(parsed.toLocaleString('en-US', { timeZone: userTimezone }));
            return {
              year: userParsed.getFullYear(),
              month: userParsed.getMonth(),
              day: userParsed.getDate()
            };
          } catch (error) {
            console.error(`Error parsing date in timezone ${userTimezone}:`, error);
            return {
              year: parsed.getFullYear(),
              month: parsed.getMonth(),
              day: parsed.getDate()
            };
          }
        }
        throw new Error(`Cannot parse date: ${dateStr}`);
    }
  }

  // Helper: Parse time strings to local hours/minutes
  parseTime(timeStr) {
    const timeRegex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const match = timeStr.match(timeRegex);
    
    if (!match) throw new Error(`Cannot parse time: ${timeStr}`);
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2] || '0');
    const ampm = match[3]?.toLowerCase();
    
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    
    return { hours, minutes };
  }

  // Parse time range (e.g., "8am to 5pm") in specific timezone
  parseTimeRange(dateStr, startTimeStr, endTimeStr, userTimezone = this.defaultTimezone) {
    const dateComponents = this.parseDate(dateStr, userTimezone);
    
    const startTime = this.parseTime(startTimeStr);
    const endTime = this.parseTime(endTimeStr);
    
    console.log(`Parsing time range in ${userTimezone}: ${dateStr} from ${startTimeStr} to ${endTimeStr}`);
    console.log(`Date components:`, dateComponents);
    console.log(`Start time:`, startTime);
    console.log(`End time:`, endTime);
    
    // Create dates in user's timezone
    const startDate = this.createDateInUserTimezone({
      year: dateComponents.year,
      month: dateComponents.month,
      day: dateComponents.day,
      hours: startTime.hours,
      minutes: startTime.minutes,
      seconds: 0
    }, userTimezone);
    
    const endDate = this.createDateInUserTimezone({
      year: dateComponents.year,
      month: dateComponents.month,
      day: dateComponents.day,
      hours: endTime.hours,
      minutes: endTime.minutes,
      seconds: 0
    }, userTimezone);
    
    console.log(`Final times - Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
    
    return {
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };
  }

  // Helper: Generate unique request ID for conference creation
  generateRequestId() {
    return `donna-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // FIXED: Helper: Get user's primary calendar info (THIS WAS MISSING!)
  async getCalendarInfo() {
    await this.ensureAuth();
    
    try {
      const response = await this.calendar.calendars.get({
        calendarId: this.calendarId
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching calendar info:', error);
      throw error;
    }
  }
}

module.exports = new GoogleCalendarService();