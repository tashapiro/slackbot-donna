// utils/dataStore.js - Enhanced with user timezone support

class DataStore {
    constructor() {
      // In-memory storage for now, easily swappable later
      this.threadState = new Map();
      this.userPreferences = new Map();
      this.apiCache = new Map(); // For caching API responses
      this.userTimezones = new Map(); // NEW: Cache user timezones
    }
  
    // Thread-based storage (existing functionality)
    getThreadData(channel, ts) {
      const key = `${channel}::${ts || 'root'}`;
      return this.threadState.get(key) || {};
    }
  
    setThreadData(channel, ts, data) {
      const key = `${channel}::${ts || 'root'}`;
      const current = this.threadState.get(key) || {};
      this.threadState.set(key, { ...current, ...data });
    }
  
    // NEW: User timezone caching
    getUserTimezone(userId) {
      return this.userTimezones.get(userId) || 'America/New_York'; // Default fallback
    }
  
    setUserTimezone(userId, timezone) {
      this.userTimezones.set(userId, timezone);
    }
  
    // User preferences storage
    getUserPreferences(userId) {
      return this.userPreferences.get(userId) || {
        timezone: this.getUserTimezone(userId), // Use cached timezone
        workingHours: { start: '09:00', end: '17:00' },
        defaultProjects: {},
        notifications: { dailyPulse: true }
      };
    }
  
    setUserPreferences(userId, prefs) {
      const current = this.userPreferences.get(userId) || {};
      this.userPreferences.set(userId, { ...current, ...prefs });
    }
  
    // API response caching (to reduce redundant calls)
    getCachedData(key, maxAgeMs = 300000) { // 5 min default
      const cached = this.apiCache.get(key);
      if (!cached) return null;
      
      if (Date.now() - cached.timestamp > maxAgeMs) {
        this.apiCache.delete(key);
        return null;
      }
      
      return cached.data;
    }
  
    setCachedData(key, data) {
      this.apiCache.set(key, {
        data,
        timestamp: Date.now()
      });
    }
  
    // Clear expired cache entries
    cleanupCache() {
      const now = Date.now();
      for (const [key, value] of this.apiCache.entries()) {
        if (now - value.timestamp > 3600000) { // 1 hour max
          this.apiCache.delete(key);
        }
      }
      
      // Also cleanup old timezone cache (keep for 24 hours)
      // No built-in way to check age, so we'll rely on periodic cleanup
    }
  }
  
  module.exports = new DataStore();