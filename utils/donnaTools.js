// utils/donnaTools.js — Donna's agentic tools. Each is a thin wrapper over an
// existing service, returned as a plain { name, description, inputSchema, run }
// object (the brain wraps them with the SDK's betaTool()). Read tools return text
// to the model; the one write tool (propose_tasks) stages a preview and reuses the
// existing pending-task + confirm-button flow — it never writes to Asana directly.

const asanaService = require('../services/asana');
const googleCalendarService = require('../services/googleCalendar');
const TimezoneHelper = require('./timezoneHelper');
const projectHandler = require('../handlers/projects');
const calendarHandler = require('../handlers/calendar');
const dataStore = require('./dataStore');

/**
 * Build the tool set bound to one Slack request context.
 * @param {Object} ctx
 * @param {object} ctx.client    Slack web client
 * @param {string} ctx.channel
 * @param {string} [ctx.thread_ts]
 * @param {string} ctx.userId
 * @returns {Array<{name,description,inputSchema,run}>}
 */
function buildTools({ client, channel, thread_ts, userId }) {
  return [
    {
      name: 'list_tasks',
      description:
        "List the user's Asana tasks. Filter by due window (today / this_week / overdue) " +
        'or by project name. Use this to answer questions about what the user has to do.',
      inputSchema: {
        type: 'object',
        properties: {
          due_date: {
            type: 'string',
            enum: ['today', 'this_week', 'overdue'],
            description: 'Which due window to fetch. Defaults to this_week.'
          },
          project: {
            type: 'string',
            description: 'Optional project name to filter by (fuzzy-matched).'
          }
        },
        additionalProperties: false
      },
      run: async ({ due_date, project }) => {
        let tasks = [];
        let label = '';
        if (project) {
          const p = await asanaService.findProject(project);
          if (!p) return `No Asana project matches "${project}".`;
          tasks = await asanaService.getTasks({ project: p.gid, includeCompleted: false });
          label = `in ${p.name}`;
        } else if (due_date === 'today') {
          tasks = await asanaService.getTasksDueToday();
          label = 'due today';
        } else if (due_date === 'overdue') {
          tasks = await asanaService.getOverdueTasks();
          label = 'overdue';
        } else {
          tasks = await asanaService.getTasksDueThisWeek();
          label = 'due this week';
        }
        if (!tasks.length) return `No tasks ${label}.`;
        const lines = tasks.slice(0, 25).map(t => {
          const due = t.due_on ? ` (due ${t.due_on})` : '';
          const proj = t.projects && t.projects[0] ? ` [${t.projects[0].name}]` : '';
          return `- ${t.name}${due}${proj}`;
        });
        const more = tasks.length > 25 ? `\n(+${tasks.length - 25} more)` : '';
        return `Tasks ${label} (${tasks.length}):\n${lines.join('\n')}${more}`;
      }
    },

    {
      name: 'list_projects',
      description: "List the names of the user's Asana projects. Useful before filing a task.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const projects = await asanaService.getProjects();
        if (!projects.length) return 'No Asana projects found.';
        return `Projects (${projects.length}):\n${projects.map(p => `- ${p.name}`).join('\n')}`;
      }
    },

    {
      name: 'check_calendar',
      description:
        "Look up the user's Google Calendar events for a period (today / tomorrow / " +
        'this_week) or a specific date (YYYY-MM-DD).',
      inputSchema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'tomorrow', 'this_week'],
            description: 'Which window to fetch. Defaults to today.'
          },
          date: {
            type: 'string',
            description: 'A specific date (YYYY-MM-DD). Overrides period if given.'
          }
        },
        additionalProperties: false
      },
      run: async ({ period, date }) => {
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        let events = [];
        let label = '';
        if (date) {
          events = await googleCalendarService.getEventsForDate(date, tz);
          label = `on ${date}`;
        } else if (period === 'tomorrow') {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          events = await googleCalendarService.getEventsForDate(d, tz);
          label = 'tomorrow';
        } else if (period === 'this_week') {
          events = await googleCalendarService.getEventsThisWeek(tz);
          label = 'this week';
        } else {
          events = await googleCalendarService.getEventsToday(tz);
          label = 'today';
        }
        if (!events.length) return `No calendar events ${label}.`;
        const lines = events.slice(0, 25).map(e => {
          const start = new Date(e.start.dateTime || e.start.date);
          const time = start.toLocaleTimeString('en-US', {
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
          });
          return `- ${time} ${e.summary || '(no title)'}`;
        });
        return `Events ${label} (${events.length}):\n${lines.join('\n')}`;
      }
    },

    {
      name: 'propose_tasks',
      description:
        'Propose one or more tasks to add to Asana. This does NOT create them — it shows ' +
        'the user a preview card with Create / Cancel buttons, and they confirm. Use this ' +
        'whenever the user wants to add tasks or turn a call\'s action items into tasks. ' +
        'After calling it, tell the user the preview is ready for them to confirm; do not ' +
        'claim the tasks are created.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'The tasks to propose.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short imperative task name.' },
                notes: { type: 'string', description: 'Optional detail/context.' },
                due: {
                  type: 'string',
                  description: 'Optional due date as a natural phrase ("Friday") or YYYY-MM-DD.'
                }
              },
              required: ['name'],
              additionalProperties: false
            }
          },
          project: {
            type: 'string',
            description: 'Optional Asana project name to file the tasks under (fuzzy-matched).'
          }
        },
        required: ['tasks'],
        additionalProperties: false
      },
      run: async ({ tasks, project }) => {
        const norm = (tasks || [])
          .filter(t => t && typeof t.name === 'string' && t.name.trim())
          .map(t => ({
            name: t.name.trim(),
            notes: t.notes ? String(t.notes).trim() : '',
            due: t.due || null,
            assignee_hint: null
          }));
        if (!norm.length) return 'No valid tasks were provided to propose.';

        let resolved = null;
        if (project) resolved = await asanaService.findProject(project);

        // Reuse the existing pending-task + confirm-button flow (handlers/projects.js).
        dataStore.setThreadData(channel, thread_ts, {
          pending_tasks: norm,
          pending_tasks_project: resolved ? { gid: resolved.gid, name: resolved.name } : null,
          pending_tasks_await_project: false,
          pending_tasks_time: Date.now()
        });

        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Here ${norm.length === 1 ? 'is a task' : `are ${norm.length} tasks`} to add${resolved ? ` to ${resolved.name}` : ''}.`,
          blocks: projectHandler.buildTaskPreviewBlocks(norm, resolved ? resolved.name : null, stableTs)
        });

        const projectNote = project && !resolved
          ? ` Note: no project named "${project}" was found, so ask the user which project to use.`
          : '';
        return `A preview of ${norm.length} task(s) is now shown to the user with Create / Cancel buttons.${projectNote} Do not take further action on these tasks — the user will confirm.`;
      }
    },

    {
      name: 'propose_meeting',
      description:
        'Propose a Google Calendar event. This does NOT create it — it shows the user a ' +
        'preview card with Create / Cancel buttons, and they confirm. Use this whenever the ' +
        'user wants to add a meeting, block time, or schedule an event. After calling it, ' +
        'tell the user the preview is ready to confirm; do not claim the event is created.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title.' },
          date: {
            type: 'string',
            description: 'Date — natural ("tomorrow", "next Friday") or YYYY-MM-DD.'
          },
          start_time: { type: 'string', description: 'Start time, e.g. "2pm" or "14:00".' },
          duration_minutes: {
            type: 'number',
            description: 'Length in minutes. Defaults to 30.'
          },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional attendee email addresses.'
          },
          location: { type: 'string', description: 'Optional location or meeting link.' },
          description: { type: 'string', description: 'Optional event description.' }
        },
        required: ['title', 'date', 'start_time'],
        additionalProperties: false
      },
      run: async ({ title, date, start_time, duration_minutes, attendees, location, description }) => {
        if (!title || !date || !start_time) {
          return 'To propose a meeting I need at least a title, a date, and a start time.';
        }
        const tz = await TimezoneHelper.getUserTimezone(client, userId);

        let times;
        try {
          times = googleCalendarService.parseDateTime(date, start_time, duration_minutes || 30, tz);
        } catch (e) {
          return `I couldn't parse the date/time from "${date}" / "${start_time}". Ask the user to clarify (e.g. "tomorrow 2pm").`;
        }

        const attendeeList = Array.isArray(attendees)
          ? attendees.filter(Boolean)
          : (attendees ? String(attendees).split(',').map(s => s.trim()).filter(Boolean) : []);

        const event = {
          summary: title.trim(),
          description: description ? String(description) : '',
          startTime: times.startTime,
          endTime: times.endTime,
          attendees: attendeeList,
          location: location ? String(location) : '',
          meetingType: null,
          timeZone: tz
        };

        dataStore.setThreadData(channel, thread_ts, {
          pending_event: event,
          pending_event_time: Date.now()
        });

        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Here's the event to add — confirm below.`,
          blocks: calendarHandler.buildEventPreviewBlocks(event, stableTs, tz)
        });

        return 'A calendar-event preview is now shown to the user with Create / Cancel buttons. Awaiting their confirmation — do not take further action.';
      }
    }
  ];
}

module.exports = { buildTools };
