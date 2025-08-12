// services/googleCalendar.js - Updated with timezone-aware methods
const { google } = require('googleapis');
const dataStore = require('../utils/dataStore');

class GoogleCalendarService {
  constructor() {
    this.credentials = this.parseCredentials();
    this.calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    this.auth = null;
    this.calendar = null;
    // REMOVED: this.userTimezone = 'America/New_York'; // No longer hardcoded
    
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

  // UPDATED: Helper to create date in specific timezone
  createDateInUserTimezone(dateComponents, userTimezone) {
    const { year, month, day, hours = 0, minutes = 0, seconds = 0 } = dateComponents;
    
    console.log(`Creating date in timezone ${userTimezone}:`, dateComponents);
    
    // Use a more reliable method to create dates in the target timezone
    // Create date string in ISO format
    const dateString = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    // Create a temporary date to work with
    const tempDateString = `${dateString}T${timeString}`;
    const tempDate = new Date(tempDateString);
    
    // Get what this time would be in UTC when interpreted in the user's timezone
    const utcTime = tempDate.getTime() + (tempDate.getTimezoneOffset() * 60000);
    
    // Get the offset for the user's timezone at this date
    const userTimezoneOffset = this.getTimezoneOffset(tempDate, userTimezone);
    
    // Create the final date adjusted for the user's timezone
    const userTime = new Date(utcTime + (userTimezoneOffset * 60000));
    
    console.log(`Created date: ${userTime.toISOString()} for timezone ${userTimezone}`);
    return userTime;
  }

  // Helper: Get timezone offset for a specific timezone and date
  getTimezoneOffset(date, timeZone) {
    try {
      const utcDate = new Date(date.toISOString());
      const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
      
      const offsetMs = tzDate.getTime() - utcDate.getTime();
      return offsetMs / (1000 * 60);
    } catch (error) {
      console.error(`Error calculating timezone offset for ${timeZone}:`, error);
      return 0; // Default to UTC on error
    }
  }

  // UPDATED: Get current date in specific timezone
  getCurrentDateInUserTimezone(userTimezone) {
    try {
      const now = new Date();
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

  // UPDATED: Parse time range with timezone parameter
  parseTimeRange(dateStr, startTimeStr, endTimeStr, userTimezone) {
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

  // UPDATED: Parse date with timezone parameter
  parseDate(dateStr, userTimezone) {
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
            // Fall back to parsed date
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

  // UPDATED: Parse natural language time to ISO string in user's timezone
  parseDateTime(dateStr, timeStr, defaultDuration = 60, userTimezone) {
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

  // Helper: Parse time strings to local hours/minutes (unchanged)
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

  // UPDATED: Format event for display with timezone awareness
  formatEvent(event, includeDetails = true, userTimezone = 'America/New_York') {
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

  // ... Keep all other existing methods unchanged (getEvents, createEvent, etc.) ...
  // Just add userTimezone parameter where needed for date ranges

  // Helper: Extract meeting links from event (unchanged)
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

  // Helper: Check if string is a meeting link (unchanged)
  isMeetingLink(str) {
    return /https?:\/\/[^\s]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)/i.test(str);
  }

  // ... Rest of the methods remain the same ...
}

module.exports = new GoogleCalendarService();