// services/googleCalendar.js - Google Calendar API integration with FIXED timezone handling
const { google } = require('googleapis');
const dataStore = require('../utils/dataStore');

class GoogleCalendarService {
  constructor() {
    this.credentials = this.parseCredentials();
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.auth = null;
    this.calendar = null;
    this.userTimezone = 'America/New_York'; // User's timezone
    
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

  // FIXED: Helper to create date in user's timezone
  createDateInUserTimezone(dateComponents) {
    const { year, month, day, hours = 0, minutes = 0, seconds = 0 } = dateComponents;
    
    // Create a properly formatted date string for the user's timezone
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    const dateString = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    
    // Create the date in the user's timezone using a more reliable method
    // This ensures the date is interpreted correctly in the target timezone
    const isoString = `${dateString}T${timeString}`;
    
    // Get the timezone offset for the user's timezone at this specific date
    const tempDate = new Date(isoString);
    const utcTime = tempDate.getTime() + (tempDate.getTimezoneOffset() * 60000);
    
    // Get the offset for the user's timezone
    const userTimezoneOffset = this.getTimezoneOffset(tempDate, this.userTimezone);
    
    // Create the final date adjusted for the user's timezone
    const userTime = new Date(utcTime + (userTimezoneOffset * 60000));
    
    return userTime;
  }

  // FIXED: Get timezone offset for a specific timezone and date
  getTimezoneOffset(date, timeZone) {
    // Use Intl.DateTimeFormat to get the timezone offset
    const utcDate = new Date(date.toISOString());
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
    
    // The difference between UTC and timezone gives us the offset in milliseconds
    const offsetMs = tzDate.getTime() - utcDate.getTime();
    
    // Convert to minutes
    return offsetMs / (1000 * 60);
  }

  // FIXED: Get current date in user's timezone
  getCurrentDateInUserTimezone() {
    const now = new Date();
    
    // Get components in user's timezone
    const userDate = new Date(now.toLocaleString('en-US', { timeZone: this.userTimezone }));
    
    return {
      year: userDate.getFullYear(),
      month: userDate.getMonth(),
      day: userDate.getDate()
    };
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

  // Get events for today
  async getEventsToday() {
    const { startOfDay, endOfDay } = this.getTodayDateRange();
    
    return this.getEvents({
      timeMin: startOfDay,
      timeMax: endOfDay
    });
  }

  // Get events for this week
  async getEventsThisWeek() {
    const { startOfWeek, endOfWeek } = this.getWeekDateRange();
    
    return this.getEvents({
      timeMin: startOfWeek,
      timeMax: endOfWeek
    });
  }

  // Get events for a specific date
  async getEventsForDate(date) {
    const { startOfDay, endOfDay } = this.getDateRange(date);
    
    return this.getEvents({
      timeMin: startOfDay,
      timeMax: endOfDay
    });
  }

  // FIXED: Get today's date range in user's timezone
  getTodayDateRange() {
    const today = this.getCurrentDateInUserTimezone();
    
    const startOfDay = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day,
      hours: 0,
      minutes: 0,
      seconds: 0
    });
    
    const endOfDay = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day,
      hours: 23,
      minutes: 59,
      seconds: 59
    });
    
    return {
      startOfDay: startOfDay.toISOString(),
      endOfDay: endOfDay.toISOString()
    };
  }

  // FIXED: Get week date range in user's timezone
  getWeekDateRange() {
    const today = this.getCurrentDateInUserTimezone();
    
    // Get the current day of the week (0 = Sunday)
    const currentDate = this.createDateInUserTimezone(today);
    const dayOfWeek = currentDate.getDay();
    
    // Calculate start of week (Sunday)
    const startOfWeek = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day - dayOfWeek,
      hours: 0,
      minutes: 0,
      seconds: 0
    });
    
    // Calculate end of week (Saturday)
    const endOfWeek = this.createDateInUserTimezone({
      year: today.year,
      month: today.month,
      day: today.day - dayOfWeek + 6,
      hours: 23,
      minutes: 59,
      seconds: 59
    });
    
    return {
      startOfWeek: startOfWeek.toISOString(),
      endOfWeek: endOfWeek.toISOString()
    };
  }

  // FIXED: Get specific date range in user's timezone
  getDateRange(dateInput) {
    if (typeof dateInput === 'string' && dateInput.toLowerCase() === 'today') {
      return this.getTodayDateRange();
    }
    
    let targetDate;
    
    if (typeof dateInput === 'string' && dateInput.toLowerCase() === 'tomorrow') {
      // Get tomorrow in user's timezone
      const today = this.getCurrentDateInUserTimezone();
      targetDate = {
        year: today.year,
        month: today.month,
        day: today.day + 1
      };
    } else if (typeof dateInput === 'string') {
      // Parse date string in user's timezone
      const parsed = this.parseDate(dateInput);
      targetDate = {
        year: parsed.year,
        month: parsed.month,
        day: parsed.day
      };
    } else {
      // Handle Date object
      const userDate = new Date(dateInput.toLocaleString('en-US', { timeZone: this.userTimezone }));
      targetDate = {
        year: userDate.getFullYear(),
        month: userDate.getMonth(),
        day: userDate.getDate()
      };
    }
    
    const startOfDay = this.createDateInUserTimezone({
      ...targetDate,
      hours: 0,
      minutes: 0,
      seconds: 0
    });
    
    const endOfDay = this.createDateInUserTimezone({
      ...targetDate,
      hours: 23,
      minutes: 59,
      seconds: 59
    });
    
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

  // Helper: Format event for display in Slack
  formatEvent(event, includeDetails = true) {
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
        timeZone: this.userTimezone
      });
      const endTime = end.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: this.userTimezone
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

  // Helper: Group events by date
  groupEventsByDate(events) {
    const grouped = {};
    
    events.forEach(event => {
      const date = new Date(event.start.dateTime || event.start.date);
      const dateStr = date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: this.userTimezone
      });
      
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(event);
    });
    
    return grouped;
  }

  // FIXED: Parse natural language time to ISO string in user's timezone
  parseDateTime(dateStr, timeStr, defaultDuration = 60) {
    const dateComponents = this.parseDate(dateStr);
    
    if (timeStr) {
      const time = this.parseTime(timeStr);
      
      const startDate = this.createDateInUserTimezone({
        year: dateComponents.year,
        month: dateComponents.month,
        day: dateComponents.day,
        hours: time.hours,
        minutes: time.minutes,
        seconds: 0
      });
      
      const endDate = new Date(startDate.getTime() + defaultDuration * 60 * 1000);
      
      return { 
        startTime: startDate.toISOString(), 
        endTime: endDate.toISOString() 
      };
    }
    
    // Default to current time if no time specified
    const now = new Date();
    const currentTime = new Date(now.toLocaleString('en-US', { timeZone: this.userTimezone }));
    
    const startDate = this.createDateInUserTimezone({
      year: dateComponents.year,
      month: dateComponents.month,
      day: dateComponents.day,
      hours: currentTime.getHours(),
      minutes: currentTime.getMinutes(),
      seconds: 0
    });
    
    const endDate = new Date(startDate.getTime() + defaultDuration * 60 * 1000);
    
    return { 
      startTime: startDate.toISOString(), 
      endTime: endDate.toISOString() 
    };
  }

  // FIXED: Parse natural language dates in user's timezone
  parseDate(dateStr) {
    const str = dateStr.toLowerCase().trim();
    
    // Get current date in user's timezone
    const today = this.getCurrentDateInUserTimezone();
    
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
          const currentDate = this.createDateInUserTimezone(today);
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
          const userParsed = new Date(parsed.toLocaleString('en-US', { timeZone: this.userTimezone }));
          return {
            year: userParsed.getFullYear(),
            month: userParsed.getMonth(),
            day: userParsed.getDate()
          };
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

  // FIXED: Parse time range (e.g., "8am to 5pm") in user's timezone
  parseTimeRange(dateStr, startTimeStr, endTimeStr) {
    const dateComponents = this.parseDate(dateStr);
    
    const startTime = this.parseTime(startTimeStr);
    const endTime = this.parseTime(endTimeStr);
    
    console.log(`Parsing time range: ${dateStr} from ${startTimeStr} to ${endTimeStr}`);
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
    });
    
    const endDate = this.createDateInUserTimezone({
      year: dateComponents.year,
      month: dateComponents.month,
      day: dateComponents.day,
      hours: endTime.hours,
      minutes: endTime.minutes,
      seconds: 0
    });
    
    console.log(`Created start date in user timezone:`, startDate);
    console.log(`Created end date in user timezone:`, endDate);
    console.log(`Start ISO:`, startDate.toISOString());
    console.log(`End ISO:`, endDate.toISOString());
    
    return {
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    };
  }

  // Helper: Generate unique request ID for conference creation
  generateRequestId() {
    return `donna-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Helper: Get user's primary calendar info
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