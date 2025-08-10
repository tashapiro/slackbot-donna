// services/toggl.js - Toggl Track API integration
const dataStore = require('../utils/dataStore');

class TogglService {
  constructor() {
    this.apiToken = process.env.TOGGL_API_TOKEN;
    this.workspaceId = process.env.TOGGL_WORKSPACE_ID;
    this.baseUrl = 'https://api.track.toggl.com/api/v9';
    
    if (!this.apiToken) {
      console.warn('TOGGL_API_TOKEN not configured');
    }
  }

  // Generate auth header for Toggl API
  getAuthHeaders() {
    if (!this.apiToken) throw new Error('Toggl API token not configured');
    
    const auth = Buffer.from(`${this.apiToken}:api_token`).toString('base64');
    return {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    };
  }

  // Get user's workspaces and cache the primary one
  async getWorkspaces() {
    const cacheKey = 'toggl_workspaces';
    const cached = dataStore.getCachedData(cacheKey, 3600000); // Cache for 1 hour
    if (cached) return cached;

    try {
      const response = await fetch(`${this.baseUrl}/workspaces`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Toggl API error: ${response.status} ${response.statusText}`);
      }

      const workspaces = await response.json();
      dataStore.setCachedData(cacheKey, workspaces);
      
      // If no workspace ID is configured, use the first one
      if (!this.workspaceId && workspaces.length > 0) {
        this.workspaceId = workspaces[0].id;
        console.log(`Using Toggl workspace: ${workspaces[0].name} (${this.workspaceId})`);
      }

      return workspaces;
    } catch (error) {
      console.error('Error fetching Toggl workspaces:', error);
      throw error;
    }
  }

  // Get projects for the workspace
  async getProjects() {
    if (!this.workspaceId) await this.getWorkspaces();
    
    const cacheKey = `toggl_projects_${this.workspaceId}`;
    const cached = dataStore.getCachedData(cacheKey, 1800000); // Cache for 30 min
    if (cached) return cached;

    try {
      const response = await fetch(`${this.baseUrl}/workspaces/${this.workspaceId}/projects`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Toggl API error: ${response.status} ${response.statusText}`);
      }

      const projects = await response.json();
      dataStore.setCachedData(cacheKey, projects);
      return projects;
    } catch (error) {
      console.error('Error fetching Toggl projects:', error);
      throw error;
    }
  }

  // Find project by name (fuzzy matching)
  async findProject(projectName) {
    const projects = await this.getProjects();
    const name = projectName.toLowerCase().trim();
    
    // Exact match first
    let project = projects.find(p => p.name.toLowerCase() === name);
    if (project) return project;
    
    // Partial match
    project = projects.find(p => p.name.toLowerCase().includes(name));
    if (project) return project;
    
    // Fuzzy match - check if any project name contains any word from the search
    const searchWords = name.split(' ').filter(w => w.length > 2);
    for (const word of searchWords) {
      project = projects.find(p => p.name.toLowerCase().includes(word));
      if (project) return project;
    }
    
    return null;
  }

  // Get time entries for a date range
  async getTimeEntries(startDate, endDate, projectId = null) {
    if (!this.workspaceId) await this.getWorkspaces();

    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate
    });

    try {
      const response = await fetch(
        `${this.baseUrl}/me/time_entries?${params}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Toggl API error: ${response.status} ${response.statusText}`);
      }

      let entries = await response.json();
      
      // Filter by project if specified
      if (projectId) {
        entries = entries.filter(entry => entry.project_id === projectId);
      }

      return entries;
    } catch (error) {
      console.error('Error fetching time entries:', error);
      throw error;
    }
  }

  // Create a new time entry
  async logTime({ projectId, description, start, duration, tags = [] }) {
    if (!this.workspaceId) await this.getWorkspaces();

    const timeEntry = {
      description: description || '',
      project_id: projectId,
      start: start, // ISO 8601 format
      duration: duration, // seconds
      tags: tags,
      workspace_id: this.workspaceId,
      created_with: 'Donna Slack Bot'
    };

    try {
      const response = await fetch(`${this.baseUrl}/workspaces/${this.workspaceId}/time_entries`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(timeEntry)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Toggl API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const createdEntry = await response.json();
      
      // Clear cache to force refresh on next query
      dataStore.apiCache.clear();
      
      return createdEntry;
    } catch (error) {
      console.error('Error creating time entry:', error);
      throw error;
    }
  }

  // Helper: Parse period into date range
  getPeriodDateRange(period) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    switch (period) {
      case 'today':
        return {
          start: today.toISOString(),
          end: new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString()
        };
        
      case 'yesterday':
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        return {
          start: yesterday.toISOString(),
          end: today.toISOString()
        };
        
      case 'this_week':
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay()); // Sunday
        return {
          start: startOfWeek.toISOString(),
          end: new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        };
        
      case 'last_week':
        const lastWeekEnd = new Date(today);
        lastWeekEnd.setDate(today.getDate() - today.getDay());
        const lastWeekStart = new Date(lastWeekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);
        return {
          start: lastWeekStart.toISOString(),
          end: lastWeekEnd.toISOString()
        };
        
      case 'this_month':
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const startOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        return {
          start: startOfMonth.toISOString(),
          end: startOfNextMonth.toISOString()
        };
        
      case 'year_to_date':
        const startOfYear = new Date(today.getFullYear(), 0, 1);
        return {
          start: startOfYear.toISOString(),
          end: now.toISOString()
        };
        
      default:
        throw new Error(`Unsupported period: ${period}`);
    }
  }

  // Helper: Format duration from seconds to human readable
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  // Helper: Parse natural language time to ISO string
  parseTime(timeStr, date = new Date()) {
    const baseDate = new Date(date);
    
    // Handle formats like "2pm", "14:00", "2:30pm"
    const timeRegex = /(\d{1,2})(:(\d{2}))?\s*(am|pm)?/i;
    const match = timeStr.match(timeRegex);
    
    if (!match) throw new Error(`Cannot parse time: ${timeStr}`);
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[3] || '0');
    const ampm = match[4]?.toLowerCase();
    
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    
    baseDate.setHours(hours, minutes, 0, 0);
    return baseDate.toISOString();
  }
}

module.exports = new TogglService();