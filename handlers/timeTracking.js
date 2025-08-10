// handlers/timeTracking.js - Handle time tracking intents
const togglService = require('../services/toggl');
const dataStore = require('../utils/dataStore');

class TimeTrackingHandler {
  // Handle time query requests
  async handleTimeQuery({ slots, client, channel, thread_ts }) {
    try {
      const { project, period = 'today' } = slots;
      
      // Get date range for the period
      const { start, end } = togglService.getPeriodDateRange(period);
      
      let projectId = null;
      let projectName = 'All Projects';
      
      // Find project if specified
      if (project) {
        const foundProject = await togglService.findProject(project);
        if (!foundProject) {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `Couldn't find project "${project}". Let me show you available projects...`,
            blocks: await this.getProjectsBlock()
          });
        }
        projectId = foundProject.id;
        projectName = foundProject.name;
      }
      
      // Get time entries
      const entries = await togglService.getTimeEntries(start, end, projectId);
      
      if (entries.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `No time logged for ${projectName} ${this.formatPeriod(period)}.`
        });
      }
      
      // Calculate total time and format response
      const totalSeconds = entries.reduce((sum, entry) => sum + entry.duration, 0);
      const totalFormatted = togglService.formatDuration(totalSeconds);
      
      // Build detailed breakdown if multiple entries
      let details = '';
      if (entries.length > 1) {
        const groupedByDay = this.groupEntriesByDay(entries);
        details = '\n\n*Breakdown:*\n' + Object.entries(groupedByDay)
          .map(([date, dayEntries]) => {
            const dayTotal = dayEntries.reduce((sum, e) => sum + e.duration, 0);
            return `• ${date}: ${togglService.formatDuration(dayTotal)}`;
          })
          .join('\n');
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `*${projectName}* - ${this.formatPeriod(period)}\n*Total: ${totalFormatted}*${details}`
      });
      
    } catch (error) {
      console.error('Time query error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble fetching your time data: ${error.message}`
      });
    }
  }

  // Handle logging new time entries
  async handleTimeLog({ slots, client, channel, thread_ts }) {
    try {
      const { project, duration, start_time, date, description } = slots;
      
      if (!project) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a project name to log time. Which project should I log this to?',
          blocks: await this.getProjectsBlock()
        });
      }
      
      // Find the project
      const foundProject = await togglService.findProject(project);
      if (!foundProject) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Couldn't find project "${project}". Let me show you available projects...`,
          blocks: await this.getProjectsBlock()
        });
      }
      
      // Parse time and duration
      const entryDate = date ? new Date(date) : new Date();
      let startTime;
      let durationSeconds;
      
      if (start_time && duration) {
        // Both start time and duration provided
        startTime = togglService.parseTime(start_time, entryDate);
        durationSeconds = this.parseDuration(duration);
      } else if (duration) {
        // Only duration provided, assume it ended now or at end of day
        durationSeconds = this.parseDuration(duration);
        const endTime = new Date();
        if (date && date !== 'today') {
          // If specific date, assume ended at 5pm
          endTime.setHours(17, 0, 0, 0);
        }
        startTime = new Date(endTime.getTime() - durationSeconds * 1000).toISOString();
      } else {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need either a duration (e.g., "2 hours") or both start time and duration to log time.'
        });
      }
      
      // Create the time entry
      const entry = await togglService.logTime({
        projectId: foundProject.id,
        description: description || '',
        start: startTime,
        duration: durationSeconds
      });
      
      const formattedDuration = togglService.formatDuration(durationSeconds);
      const formattedDate = new Date(startTime).toLocaleDateString();
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `✅ Logged ${formattedDuration} to *${foundProject.name}* on ${formattedDate}${description ? `\n_"${description}"_` : ''}`
      });
      
    } catch (error) {
      console.error('Time logging error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't log that time entry: ${error.message}`
      });
    }
  }

  // Helper: Get projects as Slack blocks for easy selection
  async getProjectsBlock() {
    try {
      const projects = await togglService.getProjects();
      const projectList = projects
        .slice(0, 10) // Limit to avoid message size issues
        .map(p => `• ${p.name}`)
        .join('\n');
        
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Available projects:*\n${projectList}`
          }
        }
      ];
    } catch (error) {
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Could not load projects list.'
          }
        }
      ];
    }
  }

  // Helper: Parse duration strings like "2 hours", "30 minutes", "1.5h"
  parseDuration(durationStr) {
    const str = durationStr.toLowerCase().trim();
    
    // Match patterns like "2 hours", "30 minutes", "1.5h", "90m"
    const patterns = [
      /(\d+(?:\.\d+)?)\s*h(?:ours?)?/,
      /(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?/,
      /(\d+(?:\.\d+)?)\s*hours?/,
      /(\d+(?:\.\d+)?)\s*minutes?/,
      /(\d+(?:\.\d+)?)/ // Just a number, assume hours
    ];
    
    for (const pattern of patterns) {
      const match = str.match(pattern);
      if (match) {
        const value = parseFloat(match[1]);
        
        if (str.includes('m') && !str.includes('h')) {
          return Math.round(value * 60); // minutes to seconds
        } else {
          return Math.round(value * 3600); // hours to seconds
        }
      }
    }
    
    throw new Error(`Cannot parse duration: ${durationStr}`);
  }

  // Helper: Group time entries by day
  groupEntriesByDay(entries) {
    return entries.reduce((groups, entry) => {
      const date = new Date(entry.start).toLocaleDateString();
      if (!groups[date]) groups[date] = [];
      groups[date].push(entry);
      return groups;
    }, {});
  }

  // Helper: Format period for display
  formatPeriod(period) {
    const periodMap = {
      'today': 'today',
      'yesterday': 'yesterday',
      'this_week': 'this week',
      'last_week': 'last week',
      'this_month': 'this month',
      'year_to_date': 'year-to-date'
    };
    return periodMap[period] || period;
  }
}

module.exports = new TimeTrackingHandler();