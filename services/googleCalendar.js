// services/googleCalendar.js - Google Calendar API integration
const { google } = require('googleapis');
const dataStore = require('../utils/dataStore');

class GoogleCalendarService {
  constructor() {
    this.credentials = this.parseCredentials();
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.auth = null;
    this.calendar = null;
    
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
    const today = new Date();
    const startOfDay = new Date(today.setHours(0, 0, 0, 0));
    const endOfDay = new Date(today.setHours(23, 59, 59, 999));
    
    return this.getEvents({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString()
    });
  }

  // Get events for this week
  async getEventsThisWeek() {
    const today = new Date();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay()); // Sunday
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Saturday
    endOfWeek.setHours(23, 59, 59, 999);
    
    return this.getEvents({
      timeMin: startOfWeek.toISOString(),
      timeMax: endOfWeek.toISOString()
    });
  }

  // Get events for a specific date
  async getEventsForDate(date) {
    const targetDate = new Date(date);
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));
    
    return this.getEvents({
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString()
    });
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
        timeZone: 'America/New_York'
      });
      const endTime = end.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York'
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
        timeZone: 'America/New_York'
      });
      
      if (!grouped[dateStr]) grouped[dateStr] = [];
      grouped[dateStr].push(event);
    });
    
    return grouped;
  }

  // Helper: Parse natural language time to ISO string
  parseDateTime(dateStr, timeStr, defaultDuration = 60) {
    const date = this.parseDate(dateStr);
    
    if (timeStr) {
      const time = this.parseTime(timeStr);
      date.setHours(time.hours, time.minutes, 0, 0);
    }
    
    const startTime = date.toISOString();
    const endTime = new Date(date.getTime() + defaultDuration * 60 * 1000).toISOString();
    
    return { startTime, endTime };
  }

  // Helper: Parse natural language dates
  parseDate(dateStr) {
    const str = dateStr.toLowerCase().trim();
    const today = new Date();
    
    switch (str) {
      case 'today':
        return new Date(today);
        
      case 'tomorrow':
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow;
        
      case 'next week':
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        return nextWeek;
        
      default:
        // Try to parse as a standard date
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
        throw new Error(`Cannot parse date: ${dateStr}`);
    }
  }

  // Helper: Parse time strings
  parseTime(timeStr) {
    const timeRegex = /(\d{1,2})(:(\d{2}))?\s*(am|pm)?/i;
    const match = timeStr.match(timeRegex);
    
    if (!match) throw new Error(`Cannot parse time: ${timeStr}`);
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[3] || '0');
    const ampm = match[4]?.toLowerCase();
    
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    
    return { hours, minutes };
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