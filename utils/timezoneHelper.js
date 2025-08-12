// utils/timezoneHelper.js - Helper to fetch and cache user timezones from Slack
const dataStore = require('./dataStore');

class TimezoneHelper {
  // Get user timezone from Slack, with caching
  static async getUserTimezone(client, userId) {
    // Check cache first (cache for 24 hours)
    const cacheKey = `user_timezone_${userId}`;
    const cached = dataStore.getCachedData(cacheKey, 24 * 60 * 60 * 1000); // 24 hours
    if (cached) {
      console.log(`Using cached timezone for user ${userId}: ${cached}`);
      return cached;
    }

    try {
      console.log(`Fetching timezone for user ${userId} from Slack API`);
      
      const result = await client.users.info({
        user: userId
      });

      if (result.ok && result.user && result.user.tz) {
        const timezone = result.user.tz;
        const timezoneLabel = result.user.tz_label;
        const timezoneOffset = result.user.tz_offset;
        
        console.log(`User ${userId} timezone: ${timezone} (${timezoneLabel}) offset: ${timezoneOffset}`);
        
        // Validate the timezone
        if (!this.isValidTimezone(timezone)) {
          console.warn(`Invalid timezone ${timezone} for user ${userId}, using default`);
          return 'America/New_York';
        }
        
        // Cache the timezone
        dataStore.setCachedData(cacheKey, timezone);
        dataStore.setUserTimezone(userId, timezone);
        
        return timezone;
      } else {
        console.warn(`Could not get timezone for user ${userId}, using default. Response:`, result);
        return 'America/New_York'; // Default fallback
      }
    } catch (error) {
      console.error(`Error fetching user timezone for ${userId}:`, error);
      return 'America/New_York'; // Default fallback
    }
  }

  // Validate timezone string using Intl API
  static isValidTimezone(timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch (ex) {
      return false;
    }
  }

  // Get timezone-aware current time for user
  static getCurrentTimeInTimezone(timezone) {
    const now = new Date();
    return new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  }

  // Convert time from one timezone to another
  static convertTime(date, fromTimezone, toTimezone) {
    try {
      // Create date in source timezone
      const sourceTime = new Date(date.toLocaleString('en-US', { timeZone: fromTimezone }));
      
      // Convert to target timezone
      const targetTime = new Date(date.toLocaleString('en-US', { timeZone: toTimezone }));
      
      return targetTime;
    } catch (error) {
      console.error(`Error converting time between timezones:`, error);
      return date; // Return original date on error
    }
  }

  // Get human-readable timezone info
  static getTimezoneInfo(timezone) {
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'long'
      });
      
      const parts = formatter.formatToParts(now);
      const timeZoneName = parts.find(part => part.type === 'timeZoneName')?.value;
      
      // Get offset
      const offset = this.getTimezoneOffset(now, timezone);
      const offsetHours = Math.floor(Math.abs(offset) / 60);
      const offsetMinutes = Math.abs(offset) % 60;
      const offsetSign = offset >= 0 ? '+' : '-';
      const offsetString = `UTC${offsetSign}${offsetHours.toString().padStart(2, '0')}:${offsetMinutes.toString().padStart(2, '0')}`;
      
      return {
        timezone,
        name: timeZoneName,
        offset: offsetString,
        offsetMinutes: offset
      };
    } catch (error) {
      console.error(`Error getting timezone info for ${timezone}:`, error);
      return {
        timezone,
        name: timezone,
        offset: 'Unknown',
        offsetMinutes: 0
      };
    }
  }

  // Get timezone offset in minutes
  static getTimezoneOffset(date, timeZone) {
    const utcDate = new Date(date.toISOString());
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone }));
    
    const offsetMs = tzDate.getTime() - utcDate.getTime();
    return offsetMs / (1000 * 60);
  }
}

module.exports = TimezoneHelper;