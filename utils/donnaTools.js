// utils/donnaTools.js — Donna's agentic tools. Each is a thin wrapper over an
// existing service, returned as a plain { name, description, inputSchema, run }
// object (the brain wraps them with the SDK's betaTool()). Read tools return text
// to the model; the one write tool (propose_tasks) stages a preview and reuses the
// existing pending-task + confirm-button flow — it never writes to Asana directly.

const asanaService = require('../services/asana');
const googleCalendarService = require('../services/googleCalendar');
const savvyCalService = require('../services/savvycal');
const firefliesService = require('../services/fireflies');
const gmailService = require('../services/gmail');
const memoryStore = require('../services/memoryStore');
const TimezoneHelper = require('./timezoneHelper');
const projectHandler = require('../handlers/projects');
const calendarHandler = require('../handlers/calendar');
const schedulingHandler = require('../handlers/scheduling');
const commsHandler = require('../handlers/comms');
const dataStore = require('./dataStore');

// The Fireflies notetaker's guest address — adding/removing it on a calendar event is how
// Fred gets onto (or off) an upcoming meeting. Configurable in case the workspace uses a
// custom notetaker address.
const NOTETAKER_EMAIL = process.env.FIREFLIES_NOTETAKER_EMAIL || 'fred@fireflies.ai';

// ── Small pure formatters shared by the Fireflies / notetaker / email tools ────
function fmtEpoch(ms, tz) {
  if (!ms) return '(no date)';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '(no date)';
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
  });
}
function fmtEventTime(event, tz) {
  const start = new Date(event.start.dateTime || event.start.date);
  if (isNaN(start.getTime())) return '';
  return start.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
  });
}
function formatParticipants(list) {
  if (!list || !list.length) return '(no participants listed)';
  return list.map(p => {
    if (p.name && p.email) return `${p.name} <${p.email}>`;
    return p.email || p.name || '(unknown)';
  }).join(', ');
}
// Accept an array or a comma/semicolon-separated string; return a clean list.
function asList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return arr.map(s => String(s).trim()).filter(Boolean);
}
// Find upcoming calendar events, optionally filtered by fuzzy title and/or a specific date.
async function findCalendarEvents({ meeting, date, tz }) {
  let events = date
    ? await googleCalendarService.getEventsForDate(date, tz)
    : await googleCalendarService.getEventsThisWeek(tz);
  if (meeting && meeting.trim()) {
    const needle = meeting.trim().toLowerCase();
    events = events.filter(e => (e.summary || '').toLowerCase().includes(needle));
  }
  return events || [];
}
function notetakerPresent(event) {
  return (event.attendees || []).some(a => (a.email || '').toLowerCase() === NOTETAKER_EMAIL.toLowerCase());
}

/**
 * Build the tool set bound to one Slack request context.
 * @param {Object} ctx
 * @param {object} ctx.client            Slack web client
 * @param {string} ctx.channel
 * @param {string} [ctx.thread_ts]
 * @param {string} ctx.userId
 * @param {Object|null} [ctx.activeClient]  Resolved client { key, name, ... } or null.
 * @param {string} [ctx.clientStatus]       'confident' | 'ambiguous' | 'none'.
 * @returns {Array<{name,description,inputSchema,run}>}
 */
function buildTools({ client, channel, thread_ts, userId, activeClient = null, clientStatus = 'none' }) {
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
    },

    // ── SavvyCal: scheduling links, booked events, and meeting polls ──────────
    {
      name: 'create_scheduling_link',
      description:
        'Create a SavvyCal scheduling link the user can share so someone books time on their ' +
        'calendar. Creates it immediately (no confirmation needed — it is cheap and reversible) ' +
        'and returns the URL for you to give the user. Default is a single-use link (expires ' +
        'after one booking); set reusable:true for a standing link that can be booked repeatedly.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Name of the link / meeting, e.g. "Intro call".' },
          minutes: { type: 'number', description: 'Meeting length in minutes (e.g. 15, 30, 45, 60).' },
          reusable: {
            type: 'boolean',
            description: 'true for a standing reusable link; false/omitted for single-use (default).'
          }
        },
        required: ['title', 'minutes'],
        additionalProperties: false
      },
      run: async ({ title, minutes, reusable }) => {
        if (!title || !minutes) return 'To create a link I need a title and a duration in minutes.';
        const dur = savvyCalService.validateDuration(minutes);
        const name = savvyCalService.generateLinkTitle(title, dur);
        const { url, id } = reusable
          ? await savvyCalService.createReusableLink(name, dur)
          : await savvyCalService.createSingleUseLink(name, dur);
        dataStore.setThreadData(channel, thread_ts, {
          last_link_id: id,
          last_link_url: url,
          last_link_title: name,
          last_link_duration: dur,
          last_action: 'created_scheduling_link',
          last_action_time: Date.now()
        });
        return `Created a ${reusable ? 'reusable' : 'single-use'} ${dur}-min link "${name}": ${url}\n` +
          'Give this URL to the user.';
      }
    },

    {
      name: 'list_scheduling_links',
      description: "List the user's SavvyCal scheduling links (name, URL, and whether each is active).",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const links = await savvyCalService.getLinks();
        if (!links.length) return 'No SavvyCal scheduling links found.';
        const lines = links.slice(0, 15).map(l => {
          const url = savvyCalService.buildUrlFrom(l);
          const state = l.enabled === false ? '🔴 disabled' : '🟢 active';
          return `- ${state} "${l.name}" — ${url} (id: ${l.id})`;
        });
        const more = links.length > 15 ? `\n(+${links.length - 15} more)` : '';
        return `Scheduling links (${links.length}):\n${lines.join('\n')}${more}`;
      }
    },

    {
      name: 'get_scheduling_link',
      description:
        'Get details for one SavvyCal link (status, URL, durations). If no link_id is given, ' +
        'uses the most recent link created in this conversation.',
      inputSchema: {
        type: 'object',
        properties: { link_id: { type: 'string', description: 'The link id. Optional — defaults to the last one in this thread.' } },
        additionalProperties: false
      },
      run: async ({ link_id }) => {
        let id = link_id;
        if (!id) id = dataStore.getThreadData(channel, thread_ts).last_link_id;
        if (!id) return "I don't have a link id, and there's no recent link in this conversation. Ask the user which link.";
        const link = await savvyCalService.getLink(id);
        const url = savvyCalService.buildUrlFrom(link);
        const state = link.enabled === false ? 'disabled' : 'active';
        const durs = link.durations && link.durations.length ? ` · durations: ${link.durations.join(', ')} min` : '';
        return `Link "${link.name}" (${state}) — ${url}${durs} (id: ${link.id})`;
      }
    },

    {
      name: 'disable_scheduling_link',
      description:
        'Disable (deactivate) a SavvyCal link so it stops taking new bookings. This shows the ' +
        'user a Disable/Cancel confirmation card first — it does NOT disable immediately. After ' +
        'calling it, tell the user to confirm; do not claim the link is disabled yet. If no ' +
        'link_id is given, the most recent link in this conversation is used.',
      inputSchema: {
        type: 'object',
        properties: { link_id: { type: 'string', description: 'The link id. Optional — defaults to the last one in this thread.' } },
        additionalProperties: false
      },
      run: async ({ link_id }) => {
        let id = link_id;
        if (!id) id = dataStore.getThreadData(channel, thread_ts).last_link_id;
        if (!id) return "I don't have a link id, and there's no recent link here. Ask the user which link to disable.";
        let name = null;
        try { name = (await savvyCalService.getLink(id)).name; } catch { /* name is best-effort */ }
        const pending = { kind: 'disable_link', id, name };
        dataStore.setThreadData(channel, thread_ts, { pending_sc_action: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `Disable ${name ? `"${name}"` : 'that link'}?`,
          blocks: schedulingHandler.buildScActionConfirmBlocks(pending, stableTs)
        });
        return 'A Disable/Cancel confirmation card is now shown to the user. Wait for them to confirm — do not claim it is disabled yet.';
      }
    },

    {
      name: 'delete_scheduling_link',
      description:
        'Permanently delete a SavvyCal link. This shows the user a Delete/Cancel confirmation ' +
        'card first — it does NOT delete immediately. After calling it, tell the user to confirm; ' +
        'do not claim the link is deleted yet. If no link_id is given, the most recent link in ' +
        'this conversation is used.',
      inputSchema: {
        type: 'object',
        properties: { link_id: { type: 'string', description: 'The link id. Optional — defaults to the last one in this thread.' } },
        additionalProperties: false
      },
      run: async ({ link_id }) => {
        let id = link_id;
        if (!id) id = dataStore.getThreadData(channel, thread_ts).last_link_id;
        if (!id) return "I don't have a link id, and there's no recent link here. Ask the user which link to delete.";
        let name = null;
        try { name = (await savvyCalService.getLink(id)).name; } catch { /* name is best-effort */ }
        const pending = { kind: 'delete_link', id, name };
        dataStore.setThreadData(channel, thread_ts, { pending_sc_action: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `Delete ${name ? `"${name}"` : 'that link'}?`,
          blocks: schedulingHandler.buildScActionConfirmBlocks(pending, stableTs)
        });
        return 'A Delete/Cancel confirmation card is now shown to the user. Wait for them to confirm — do not claim it is deleted yet.';
      }
    },

    {
      name: 'list_booked_events',
      description:
        'List meetings that have actually been booked through SavvyCal (upcoming appointments). ' +
        'Use this to answer "what\'s on the books" / "who booked time with me".',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Optional start of the window (ISO 8601 or YYYY-MM-DD).' },
          to: { type: 'string', description: 'Optional end of the window (ISO 8601 or YYYY-MM-DD).' }
        },
        additionalProperties: false
      },
      run: async ({ from, to }) => {
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const events = await savvyCalService.getEvents({ from, to });
        if (!events.length) return 'No booked SavvyCal events found for that window.';
        const lines = events.slice(0, 20).map(e => {
          const startRaw = e.start_at || e.start || (e.times && e.times[0] && e.times[0].start_at);
          let when = startRaw || '(time unknown)';
          if (startRaw) {
            const d = new Date(startRaw);
            if (!isNaN(d.getTime())) {
              when = d.toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz
              });
            }
          }
          const invitee = e.attendee_name || e.invitee_name ||
            (e.attendee && (e.attendee.display_name || e.attendee.name || e.attendee.email)) || '';
          const title = e.summary || e.name || e.title || 'Meeting';
          const cancelled = e.state === 'canceled' || e.state === 'cancelled' || e.cancelled_at ? ' (canceled)' : '';
          return `- ${when} — ${title}${invitee ? ` with ${invitee}` : ''}${cancelled}`;
        });
        const more = events.length > 20 ? `\n(+${events.length - 20} more)` : '';
        return `Booked events (${events.length}):\n${lines.join('\n')}${more}`;
      }
    },

    {
      name: 'create_scheduling_poll',
      description:
        'Create a SavvyCal meeting poll: propose a few specific time slots that a group votes on. ' +
        'Use this when the user wants to find a time that works across several people. You can ' +
        'recommend the slots yourself (check the calendar for open windows first) or use ones the ' +
        'user names. This shows the user a preview card with Send/Cancel — it does NOT send ' +
        'immediately. After calling it, tell the user to confirm; do not claim the poll is sent yet.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Poll title, e.g. "Acme kickoff".' },
          duration_minutes: { type: 'number', description: 'Meeting length in minutes for the chosen slot. Defaults to 30.' },
          slots: {
            type: 'array',
            description: 'The proposed start times as ISO 8601 datetimes (e.g. "2026-07-23T14:00:00"). Provide 3–4.',
            items: { type: 'string' }
          },
          attendees: {
            type: 'array',
            description: 'Optional participant email addresses to invite to the poll.',
            items: { type: 'string' }
          }
        },
        required: ['name', 'slots'],
        additionalProperties: false
      },
      run: async ({ name, duration_minutes, slots, attendees }) => {
        if (!name || !name.trim()) return 'A poll needs a name.';
        const rawSlots = Array.isArray(slots) ? slots : [];
        const normSlots = rawSlots
          .map(s => (typeof s === 'string' ? s : (s && (s.start_at || s.start))))
          .filter(Boolean)
          .filter(s => !isNaN(new Date(s).getTime()))
          .map(s => ({ start_at: s }));
        if (!normSlots.length) return 'I need at least one valid time slot (ISO 8601) to build a poll.';

        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const pending = {
          name: name.trim(),
          durationMinutes: parseInt(duration_minutes, 10) || 30,
          slots: normSlots,
          attendees: Array.isArray(attendees) ? attendees.filter(Boolean) : []
        };
        dataStore.setThreadData(channel, thread_ts, { pending_sc_poll: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `Here's the poll "${pending.name}" — confirm below.`,
          blocks: schedulingHandler.buildPollPreviewBlocks(pending, stableTs, tz)
        });
        return `A poll preview (${normSlots.length} slots${pending.attendees.length ? `, ${pending.attendees.length} invitees` : ''}) is now shown with Send/Cancel. Wait for the user to confirm — do not claim it is sent yet.`;
      }
    },

    {
      name: 'list_scheduling_polls',
      description: "List the user's SavvyCal meeting polls (name, status, and URL).",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const polls = await savvyCalService.getPolls();
        if (!polls.length) return 'No SavvyCal meeting polls found.';
        const lines = polls.slice(0, 15).map(p => {
          const url = p.url || (p.slug ? `https://savvycal.com/indievisual/${p.slug}` : '');
          return `- "${p.name}"${p.state ? ` [${p.state}]` : ''}${url ? ` — ${url}` : ''} (id: ${p.id})`;
        });
        const more = polls.length > 15 ? `\n(+${polls.length - 15} more)` : '';
        return `Meeting polls (${polls.length}):\n${lines.join('\n')}${more}`;
      }
    },

    {
      name: 'get_scheduling_poll',
      description:
        'Get one meeting poll with its slots and current vote counts — use to see which time is ' +
        'winning. If no poll_id is given, uses the most recent poll from this conversation.',
      inputSchema: {
        type: 'object',
        properties: { poll_id: { type: 'string', description: 'The poll id. Optional — defaults to the last poll in this thread.' } },
        additionalProperties: false
      },
      run: async ({ poll_id }) => {
        let id = poll_id;
        if (!id) id = dataStore.getThreadData(channel, thread_ts).last_poll_id;
        if (!id) return "I don't have a poll id, and there's no recent poll here. Ask the user which poll.";
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const poll = await savvyCalService.getPoll(id);
        const slots = poll.slots || [];
        const slotLines = slots.map(s => {
          const d = new Date(s.start_at || s.start);
          const when = isNaN(d.getTime())
            ? String(s.start_at || s.start)
            : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
          const votes = typeof s.votes === 'number' ? s.votes : (Array.isArray(s.votes) ? s.votes.length : 0);
          return `  • ${when} — ${votes} vote${votes === 1 ? '' : 's'}`;
        });
        const url = poll.url ? `\n${poll.url}` : '';
        return `Poll "${poll.name}"${poll.state ? ` [${poll.state}]` : ''}:${url}\n${slotLines.join('\n') || '  (no slots)'}`;
      }
    },

    {
      name: 'delete_scheduling_poll',
      description:
        'Delete a SavvyCal meeting poll. Shows the user a Delete/Cancel confirmation card first — ' +
        'it does NOT delete immediately. After calling it, tell the user to confirm; do not claim ' +
        'the poll is deleted yet. If no poll_id is given, the most recent poll here is used.',
      inputSchema: {
        type: 'object',
        properties: { poll_id: { type: 'string', description: 'The poll id. Optional — defaults to the last poll in this thread.' } },
        additionalProperties: false
      },
      run: async ({ poll_id }) => {
        let id = poll_id;
        if (!id) id = dataStore.getThreadData(channel, thread_ts).last_poll_id;
        if (!id) return "I don't have a poll id, and there's no recent poll here. Ask the user which poll to delete.";
        let name = null;
        try { name = (await savvyCalService.getPoll(id)).name; } catch { /* name is best-effort */ }
        const pending = { kind: 'delete_poll', id, name };
        dataStore.setThreadData(channel, thread_ts, { pending_sc_action: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `Delete the poll ${name ? `"${name}"` : ''}?`,
          blocks: schedulingHandler.buildScActionConfirmBlocks(pending, stableTs)
        });
        return 'A Delete/Cancel confirmation card is now shown to the user. Wait for them to confirm — do not claim it is deleted yet.';
      }
    },

    // ── Fireflies: meeting notes & transcripts ───────────────────────────────
    {
      name: 'list_meetings',
      description:
        'List recent meetings recorded by Fireflies (the notetaker, "Fred") — title, date, and ' +
        'how many people attended. Use this to find which call the user means before pulling ' +
        'notes or a transcript.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent meetings to list (default 10, max 25).' }
        },
        additionalProperties: false
      },
      run: async ({ limit }) => {
        if (!firefliesService.isEnabled()) {
          return "Fireflies isn't configured (no FIREFLIES_API_KEY), so I can't pull meeting notes. Tell the user.";
        }
        const meetings = await firefliesService.getRecentMeetings(Math.min(parseInt(limit, 10) || 10, 25));
        if (!meetings.length) return 'No recent Fireflies meetings found.';
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const lines = meetings.map(m =>
          `- ${fmtEpoch(m.date, tz)} — ${m.title}${m.participants.length ? ` (${m.participants.length} people)` : ''} [id: ${m.id}]`);
        return `Recent Fireflies meetings (${meetings.length}):\n${lines.join('\n')}`;
      }
    },

    {
      name: 'get_meeting_notes',
      description:
        "Get Fireflies notes for a meeting: overview, action items, and the participant list " +
        '(with emails). Identify the meeting by name, or omit to use the most recent call ' +
        '("my last call"). Use this to summarize a call, or to get participant emails before ' +
        'drafting a follow-up email.',
      inputSchema: {
        type: 'object',
        properties: {
          meeting: { type: 'string', description: 'Meeting name/title, or "last" for the most recent. Omit for the most recent.' },
          meeting_id: { type: 'string', description: 'Exact Fireflies transcript id, if you already have it.' }
        },
        additionalProperties: false
      },
      run: async ({ meeting, meeting_id }) => {
        if (!firefliesService.isEnabled()) {
          return "Fireflies isn't configured (no FIREFLIES_API_KEY), so I can't pull meeting notes. Tell the user.";
        }
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const r = await firefliesService.resolveMeeting({ id: meeting_id, title: meeting });
        if (r.error && !r.candidates) return r.error;
        if (r.candidates) {
          const lines = r.candidates.map(c => `- ${c.title} (${fmtEpoch(c.date, tz)}) [id: ${c.id}]`);
          return `More than one meeting could match. Ask the user which one:\n${lines.join('\n')}`;
        }
        const t = r.transcript;
        let out = `*${t.title}* — ${fmtEpoch(t.date, tz)}${t.durationMinutes ? ` · ${t.durationMinutes} min` : ''}\n`;
        out += `Participants: ${formatParticipants(t.participants)}\n`;
        if (t.overview) out += `\nOverview:\n${t.overview}\n`;
        if (t.actionItems) out += `\nAction items:\n${t.actionItems}\n`;
        if (!t.overview && !t.actionItems) {
          out += '\n(No AI summary is available for this meeting — that may need a paid Fireflies plan. ' +
            'You can pull the raw transcript with get_meeting_transcript.)\n';
        }
        out += `\n[transcript id: ${t.id}]`;
        return out;
      }
    },

    {
      name: 'get_meeting_transcript',
      description:
        'Get the full spoken transcript of a Fireflies meeting (speaker-labeled lines). Identify ' +
        'the meeting by name, or omit for the most recent. Use when the summary/action items ' +
        "aren't enough and you need what was actually said.",
      inputSchema: {
        type: 'object',
        properties: {
          meeting: { type: 'string', description: 'Meeting name/title, or "last" for the most recent. Omit for the most recent.' },
          meeting_id: { type: 'string', description: 'Exact Fireflies transcript id, if you already have it.' }
        },
        additionalProperties: false
      },
      run: async ({ meeting, meeting_id }) => {
        if (!firefliesService.isEnabled()) {
          return "Fireflies isn't configured (no FIREFLIES_API_KEY), so I can't pull transcripts. Tell the user.";
        }
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const r = await firefliesService.resolveMeeting({ id: meeting_id, title: meeting });
        if (r.error && !r.candidates) return r.error;
        if (r.candidates) {
          const lines = r.candidates.map(c => `- ${c.title} (${fmtEpoch(c.date, tz)}) [id: ${c.id}]`);
          return `More than one meeting could match. Ask the user which one:\n${lines.join('\n')}`;
        }
        const t = r.transcript;
        const text = firefliesService.constructor.transcriptText(t);
        if (!text.trim()) return `No transcript text is available for "${t.title}".`;
        return `Transcript — *${t.title}* (${fmtEpoch(t.date, tz)}):\n\n${text}`;
      }
    },

    // ── Fireflies "Fred" on an upcoming call (via the Google Calendar guest) ──
    {
      name: 'check_notetaker',
      description:
        'Check whether Fireflies (Fred) is set to join an upcoming meeting — i.e. whether the ' +
        `notetaker (${NOTETAKER_EMAIL}) is a guest on the calendar event. Identify the meeting ` +
        'by name and/or date. Use this for "is Fred on my 2pm?" type questions.',
      inputSchema: {
        type: 'object',
        properties: {
          meeting: { type: 'string', description: 'Meeting title to match (fuzzy).' },
          date: { type: 'string', description: 'A specific date (YYYY-MM-DD). Defaults to this week.' }
        },
        additionalProperties: false
      },
      run: async ({ meeting, date }) => {
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const events = await findCalendarEvents({ meeting, date, tz });
        if (!events.length) {
          return `I couldn't find a calendar event${meeting ? ` matching "${meeting}"` : ''}${date ? ` on ${date}` : ' this week'}.`;
        }
        if (events.length > 1) {
          const lines = events.slice(0, 8).map(e => `- ${e.summary || '(no title)'} — ${fmtEventTime(e, tz)}`);
          return `Several events match — ask the user which one:\n${lines.join('\n')}`;
        }
        const e = events[0];
        return notetakerPresent(e)
          ? `✅ Fred is already on *${e.summary}* (${fmtEventTime(e, tz)}) — Fireflies will record it.`
          : `Fred is *not* on *${e.summary}* (${fmtEventTime(e, tz)}) yet. Want me to add him?`;
      }
    },

    {
      name: 'toggle_notetaker',
      description:
        'Add or remove Fireflies (Fred) on an upcoming meeting by adding/removing the notetaker ' +
        'as a guest on the calendar event. This shows the user a confirmation card first — it ' +
        'does NOT change the event immediately. After calling it, tell the user to confirm; do ' +
        'not claim it is done yet. Identify the meeting by name and/or date.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove Fred.' },
          meeting: { type: 'string', description: 'Meeting title to match (fuzzy).' },
          date: { type: 'string', description: 'A specific date (YYYY-MM-DD). Defaults to this week.' }
        },
        required: ['action'],
        additionalProperties: false
      },
      run: async ({ action, meeting, date }) => {
        const tz = await TimezoneHelper.getUserTimezone(client, userId);
        const events = await findCalendarEvents({ meeting, date, tz });
        if (!events.length) {
          return `I couldn't find a calendar event${meeting ? ` matching "${meeting}"` : ''}${date ? ` on ${date}` : ' this week'} to update.`;
        }
        if (events.length > 1) {
          const lines = events.slice(0, 8).map(e => `- ${e.summary || '(no title)'} — ${fmtEventTime(e, tz)}`);
          return `Several events match — ask the user which one before I change anything:\n${lines.join('\n')}`;
        }
        const e = events[0];
        const present = notetakerPresent(e);
        if (action === 'add' && present) return `Fred is already on *${e.summary}* — nothing to add.`;
        if (action === 'remove' && !present) return `Fred isn't on *${e.summary}* — nothing to remove.`;

        const pending = {
          action,
          eventId: e.id,
          eventSummary: e.summary || '(no title)',
          eventWhen: fmtEventTime(e, tz),
          notetakerEmail: NOTETAKER_EMAIL,
          attendees: (e.attendees || []).map(a => ({ email: a.email }))
        };
        dataStore.setThreadData(channel, thread_ts, { pending_notetaker: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `${action === 'remove' ? 'Remove' : 'Add'} Fred ${action === 'remove' ? 'from' : 'to'} "${pending.eventSummary}"?`,
          blocks: commsHandler.buildNotetakerToggleBlocks(pending, stableTs)
        });
        return `A confirmation card to ${action} Fred is now shown to the user. Wait for them to confirm — do not claim it is done yet.`;
      }
    },

    // ── Gmail: draft a follow-up email (drafts only — never sends) ────────────
    {
      name: 'draft_email',
      description:
        'Draft an email and save it to the user\'s Gmail as a DRAFT (it is never sent — the user ' +
        'reviews and sends it themselves). Shows a preview card with Save/Cancel first. Compose ' +
        'the subject and body yourself in the user\'s voice: professional but warm, succinct, ' +
        'plain language over buzzwords, technical when the topic calls for it. For a call ' +
        'follow-up, pull the summary and participant emails with get_meeting_notes first, then ' +
        'write a short recap and list action items grouped by owner. After calling this, tell the ' +
        'user the draft is ready to save; do not claim it was sent.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Optional cc email addresses.' },
          subject: { type: 'string', description: 'Email subject line.' },
          body: { type: 'string', description: 'The full email body, in plain text, ready to send.' },
          meeting_title: { type: 'string', description: 'Optional: the call this follows up on, shown for context on the preview.' }
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false
      },
      run: async ({ to, cc, subject, body, meeting_title }) => {
        if (!gmailService.isEnabled()) {
          return "Gmail drafting isn't configured yet (needs the Google service account + an impersonation mailbox). Tell the user it's not set up.";
        }
        const toList = asList(to);
        if (!toList.length) return 'A draft needs at least one recipient. Ask the user (or pull participants from the meeting notes).';
        if (!body || !String(body).trim()) return 'The email body is empty — write the message before drafting.';

        const pending = {
          to: toList,
          cc: asList(cc),
          subject: subject ? String(subject).trim() : '(no subject)',
          body: String(body),
          meetingTitle: meeting_title ? String(meeting_title) : null
        };
        dataStore.setThreadData(channel, thread_ts, { pending_email_draft: pending });
        const stableTs = thread_ts || 'root';
        await client.chat.postMessage({
          channel, thread_ts,
          text: `Here's the draft email to ${toList.join(', ')} — confirm below to save it to Gmail.`,
          blocks: commsHandler.buildEmailDraftBlocks(pending, stableTs)
        });
        return 'An email-draft preview with Save/Cancel is now shown to the user. Wait for them to confirm — do not claim it was saved or sent yet.';
      }
    },

    {
      name: 'remember',
      description:
        "Save a durable fact to Donna's memory so it survives restarts. Use for things worth " +
        'keeping: user preferences (personal), how the business works (business — rate card, ' +
        'email voice, bio), or a specific client\'s details (client — deadlines, decisions, ' +
        'contacts, contract terms). Do NOT use it for one-off chatter. For client facts, the ' +
        'active client is set automatically from the conversation — you cannot store to another ' +
        'client. If the client is unclear, ask the user which client first.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['personal', 'business', 'client'],
            description:
              "personal = about the user; business = true across all clients (IndieVisual); " +
              'client = about the current client only.'
          },
          content: { type: 'string', description: 'The fact to remember, in a clear sentence.' },
          kind: {
            type: 'string',
            description: 'Optional short label, e.g. "preference", "deadline", "contact", "decision".'
          }
        },
        required: ['scope', 'content'],
        additionalProperties: false
      },
      run: async ({ scope, content, kind }) => {
        if (!memoryStore.isEnabled()) {
          return 'Memory isn\'t configured yet (no database), so I can\'t save that permanently. ' +
            'Tell the user their memory store isn\'t set up.';
        }
        if (scope === 'client') {
          if (clientStatus !== 'confident' || !activeClient) {
            return 'This is client-specific, but the active client isn\'t confirmed. Ask the user ' +
              'which client this is about before saving — I won\'t store client memory unconfirmed.';
          }
        }
        try {
          await memoryStore.remember({
            scope,
            client_key: scope === 'client' ? activeClient.key : null,
            kind: kind || null,
            content
          });
          const where = scope === 'client' ? `for ${activeClient.name}` : `(${scope})`;
          return `Saved to memory ${where}. Tell the user you'll remember it.`;
        } catch (err) {
          return `Couldn't save that to memory: ${err.message}`;
        }
      }
    },

    {
      name: 'recall',
      description:
        "Look up what Donna already remembers that's relevant right now. Returns personal + " +
        "business facts plus (only) the active client's facts — never another client's. Use it " +
        'before answering questions about the user, the business, or the current client.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: 'Optional label to filter by (e.g. "preference", "deadline", "contact").'
          }
        },
        additionalProperties: false
      },
      run: async ({ kind }) => {
        if (!memoryStore.isEnabled()) return 'Memory isn\'t configured (no database), so I have nothing stored.';
        try {
          const rows = await memoryStore.recallVisible({
            client_key: activeClient ? activeClient.key : null,
            kind: kind || null
          });
          if (!rows.length) return 'Nothing relevant in memory yet.';
          const label = s => (s === 'client' && activeClient ? `client:${activeClient.name}` : s);
          const lines = rows.map(r => `- [${label(r.scope)}${r.kind ? `/${r.kind}` : ''}] ${r.content}`);
          return `From memory (${rows.length}):\n${lines.join('\n')}`;
        } catch (err) {
          return `Couldn't read memory: ${err.message}`;
        }
      }
    }
  ];
}

module.exports = { buildTools };
