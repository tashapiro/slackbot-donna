// handlers/projects.js - Handle project management and task intents
const asanaService = require('../services/asana');
const dataStore = require('../utils/dataStore');
const taskExtractor = require('../utils/taskExtractor');

class ProjectHandler {
  // Handle task listing requests
  async handleListTasks({ slots, client, channel, thread_ts }) {
    try {
      const { project, assignee, due_date, status } = slots;
      
      let tasks = [];
      let title = '';
      
      // Determine what tasks to fetch based on slots
      if (due_date) {
        switch (due_date.toLowerCase()) {
          case 'today':
            tasks = await asanaService.getTasksDueToday();
            title = '*Tasks due today:*';
            break;
          case 'this week':
          case 'week':
            tasks = await asanaService.getTasksDueThisWeek();
            title = '*Tasks due this week:*';
            break;
          case 'overdue':
            tasks = await asanaService.getOverdueTasks();
            title = '*Overdue tasks:*';
            break;
          default:
            // Try to parse as specific date
            tasks = await asanaService.getTasks({ due_on: due_date });
            title = `*Tasks due ${due_date}:*`;
        }
      } else if (project) {
        // Find project and get its tasks
        const foundProject = await asanaService.findProject(project);
        if (!foundProject) {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `Couldn't find project "${project}". Let me show you available projects...`,
            blocks: await this.getProjectsBlock()
          });
        }
        
        console.log(`Found project: ${foundProject.name} (ID: ${foundProject.gid})`);
        
        // Try different approach - get all tasks then filter by project
        try {
          // First try: get tasks for specific project (incomplete only)
          tasks = await asanaService.getTasks({ 
            project: foundProject.gid,
            includeCompleted: false  // Only get incomplete tasks
          });
          
          console.log(`Found ${tasks.length} incomplete tasks in project ${foundProject.name}`);
          
          // Additional client-side filtering to remove any problematic tasks
          tasks = tasks.filter(task => {
            // Ensure task has valid data and isn't deleted/orphaned
            const isValid = task.name && 
                           task.name.trim().length > 0 && 
                           task.projects && 
                           task.projects.length > 0;
            
            if (!isValid) {
              console.log(`Filtering out invalid task: ${task.name || 'unnamed'}`);
            }
            
            return isValid;
          });
          
          console.log(`After additional filtering: ${tasks.length} valid incomplete tasks`);
          
        } catch (projectError) {
          console.log('Project-specific query failed, trying alternative approach:', projectError.message);
          
          // Fallback: get all user tasks and filter client-side
          const allTasks = await asanaService.getTasks({ includeCompleted: false, limit: 100 });
          tasks = allTasks.filter(task => 
            task.projects && 
            task.projects.some(p => p.gid === foundProject.gid || p.name === foundProject.name) &&
            task.name && 
            task.name.trim().length > 0
          );
        }
        
        title = `*Tasks in ${foundProject.name}:*`;
      } else {
        // Default: show user's tasks for this week
        tasks = await asanaService.getTasksDueThisWeek();
        title = '*Your tasks this week:*';
      }
      
      if (tasks.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `${title}\nNo tasks found! 🎉`
        });
      }
      
      // Group and format tasks
      const grouped = asanaService.groupTasksByUrgency(tasks);
      let message = title + '\n\n';
      
      if (grouped.overdue.length > 0) {
        message += '*Overdue:*\n';
        message += grouped.overdue.map(t => asanaService.formatTask(t)).join('\n') + '\n\n';
      }
      
      if (grouped.today.length > 0) {
        message += '*Due Today:*\n';
        message += grouped.today.map(t => asanaService.formatTask(t)).join('\n') + '\n\n';
      }
      
      if (grouped.thisWeek.length > 0) {
        message += '*This Week:*\n';
        message += grouped.thisWeek.map(t => asanaService.formatTask(t)).join('\n') + '\n\n';
      }
      
      if (grouped.later.length > 0) {
        message += '*Later:*\n';
        message += grouped.later.slice(0, 5).map(t => asanaService.formatTask(t)).join('\n');
        if (grouped.later.length > 5) {
          message += `\n_...and ${grouped.later.length - 5} more_`;
        }
        message += '\n\n';
      }
      
      if (grouped.noDueDate.length > 0) {
        message += '*No Due Date:*\n';
        message += grouped.noDueDate.slice(0, 3).map(t => asanaService.formatTask(t)).join('\n');
        if (grouped.noDueDate.length > 3) {
          message += `\n_...and ${grouped.noDueDate.length - 3} more_`;
        }
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message.trim()
      });
      
    } catch (error) {
      console.error('List tasks error:', error);
      
      // More detailed error handling
      if (error.message.includes('400')) {
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `I had trouble with that request. This might be an issue with the project name or API parameters. Try:\n• Using the exact project name\n• Asking for "all my tasks" instead\n• Or try: @Donna what projects are available?`
        });
      } else {
        await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Sorry, I had trouble fetching your tasks: ${error.message}`
        });
      }
    }
  }

  // Handle task updates
  async handleUpdateTask({ slots, client, channel, thread_ts }) {
    try {
      const { task_id, field, value } = slots;
      
      if (!task_id || !field || value === undefined) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a task ID, field to update, and new value. Try: "mark task 123456 as complete" or "update task 123456 due date to tomorrow"'
        });
      }
      
      let updateData = {};
      
      // Parse different field types
      switch (field.toLowerCase()) {
        case 'status':
        case 'complete':
        case 'completed':
          updateData.completed = value.toLowerCase() === 'complete' || value.toLowerCase() === 'true';
          break;
          
        case 'due_date':
        case 'due':
          updateData.due_on = this.parseDateString(value);
          break;
          
        case 'name':
        case 'title':
          updateData.name = value;
          break;
          
        case 'notes':
        case 'description':
          updateData.notes = value;
          break;
          
        default:
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `I don't know how to update "${field}". I can update: status, due_date, name, or notes.`
          });
      }
      
      const updatedTask = await asanaService.updateTask(task_id, updateData);
      
      let message = `✅ Updated task: *${updatedTask.name}*`;
      if (field.toLowerCase().includes('complete')) {
        message = updateData.completed ? 
          `🎉 Marked complete: *${updatedTask.name}*` :
          `🔄 Reopened task: *${updatedTask.name}*`;
      } else if (field.toLowerCase().includes('due')) {
        message += `\nNew due date: ${updatedTask.due_on || 'None'}`;
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Update task error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't update that task: ${error.message}`
      });
    }
  }

  // Handle creating new tasks
  async handleCreateTask({ slots, client, channel, thread_ts }) {
    try {
      const { name, project, due_date, notes } = slots;
      
      if (!name) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'I need a task name to create a new task. Try: "create task Review proposal for Client Name"'
        });
      }
      
      let projectIds = [];
      if (project) {
        const foundProject = await asanaService.findProject(project);
        if (foundProject) {
          projectIds = [foundProject.gid];
        } else {
          return await client.chat.postMessage({
            channel,
            thread_ts,
            text: `Couldn't find project "${project}". Let me show you available projects...`,
            blocks: await this.getProjectsBlock()
          });
        }
      }
      
      const taskData = {
        name,
        notes: notes || '',
        projects: projectIds,
        due_on: due_date ? this.parseDateString(due_date) : null
      };
      
      const newTask = await asanaService.createTask(taskData);
      
      let message = `✅ Created task: *${newTask.name}*`;
      if (newTask.due_on) {
        message += `\nDue: ${new Date(newTask.due_on).toLocaleDateString()}`;
      }
      if (projectIds.length > 0) {
        const proj = await asanaService.findProject(project);
        message += `\nProject: ${proj.name}`;
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
      
    } catch (error) {
      console.error('Create task error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I couldn't create that task: ${error.message}`
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Thread-aware task extraction: read the conversation, propose Asana tasks,
  // confirm before writing. Flow:
  //   handleExtractTasks -> preview (+ optional "which project?")
  //     -> handleTaskProjectResponse (if project was needed)
  //     -> confirmPendingTasks (on button click) writes to Asana.
  // ───────────────────────────────────────────────────────────────────────────

  // Read the thread transcript and propose tasks from its action items
  async handleExtractTasks({ slots, client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const transcript = threadData.recent_messages || [];

    if (!transcript.length) {
      return await client.chat.postMessage({
        channel,
        thread_ts,
        text: "I can't see any conversation to pull tasks from. Tag me in a thread that has the details — like Fred's call recap — or just tell me what to capture."
      });
    }

    await client.chat.postMessage({ channel, thread_ts, text: 'Reading the thread…' });

    const formatted = transcript.map(m => `${m.author}: ${m.text}`).join('\n');
    const tasks = await taskExtractor.extract({ transcript: formatted });

    if (!tasks.length) {
      return await client.chat.postMessage({
        channel,
        thread_ts,
        text: "I read through it and didn't spot any clear action items. Point me at the specific part, or dictate the task yourself and I'll add it."
      });
    }

    // Resolve a project if the user named one
    let resolvedProject = null;
    let projectNotFound = false;
    if (slots.project) {
      resolvedProject = await asanaService.findProject(slots.project);
      if (!resolvedProject) projectNotFound = true;
    }

    // Stash candidates on the thread for the confirm/cancel step
    dataStore.setThreadData(channel, thread_ts, {
      pending_tasks: tasks,
      pending_tasks_project: resolvedProject ? { gid: resolvedProject.gid, name: resolvedProject.name } : null,
      pending_tasks_await_project: !resolvedProject,
      pending_tasks_time: Date.now()
    });

    const stableTs = thread_ts || 'root';

    // Happy path: project known, show preview with confirm buttons
    if (resolvedProject) {
      return await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Here's what I pulled from the thread — ${tasks.length} action item${tasks.length === 1 ? '' : 's'} for ${resolvedProject.name}.`,
        blocks: this.buildTaskPreviewBlocks(tasks, resolvedProject.name, stableTs)
      });
    }

    // Need a project — show the items and ask (per "you name it, else she asks")
    let ask = `Here's what I pulled from the thread — ${tasks.length} action item${tasks.length === 1 ? '' : 's'}:\n\n${this.formatTaskList(tasks)}\n\n`;
    ask += projectNotFound
      ? `I couldn't find a project called "${slots.project}". Which project should these go in? (Reply with the name, or "cancel".)`
      : `Which Asana project should these go in? Just reply with the name — or "cancel" to drop it.`;

    return await client.chat.postMessage({ channel, thread_ts, text: ask });
  }

  // Handle the user's reply when Donna asked which project to use
  async handleTaskProjectResponse({ slots, client, channel, thread_ts }) {
    const answer = (slots.answer || '').trim();
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const tasks = threadData.pending_tasks || [];

    if (!tasks.length) {
      // Nothing pending; clear the flag and let normal handling resume next time
      dataStore.setThreadData(channel, thread_ts, { pending_tasks_await_project: false });
      return;
    }

    if (/^(cancel|nvm|never ?mind|forget it|stop|no)$/i.test(answer)) {
      dataStore.setThreadData(channel, thread_ts, {
        pending_tasks: null,
        pending_tasks_project: null,
        pending_tasks_await_project: false
      });
      return await client.chat.postMessage({ channel, thread_ts, text: 'Dropped it — nothing added to Asana.' });
    }

    const resolvedProject = await asanaService.findProject(answer);
    if (!resolvedProject) {
      return await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Still can't find a project matching "${answer}". Try one of these (or say "cancel"):`,
        blocks: await this.getProjectsBlock()
      });
    }

    dataStore.setThreadData(channel, thread_ts, {
      pending_tasks_project: { gid: resolvedProject.gid, name: resolvedProject.name },
      pending_tasks_await_project: false
    });

    const stableTs = thread_ts || 'root';
    return await client.chat.postMessage({
      channel,
      thread_ts,
      text: `Got it — ${tasks.length} task${tasks.length === 1 ? '' : 's'} for ${resolvedProject.name}.`,
      blocks: this.buildTaskPreviewBlocks(tasks, resolvedProject.name, stableTs)
    });
  }

  // Create the pending tasks in Asana (triggered by the "Create all" button)
  async confirmPendingTasks({ client, channel, thread_ts }) {
    const threadData = dataStore.getThreadData(channel, thread_ts);
    const tasks = threadData.pending_tasks || [];
    const project = threadData.pending_tasks_project;

    if (!tasks.length) {
      return await client.chat.postMessage({
        channel,
        thread_ts,
        text: 'Those tasks already cleared out — nothing pending to create.'
      });
    }

    const projectIds = project ? [project.gid] : [];
    const created = [];
    const failed = [];

    for (const t of tasks) {
      try {
        let due_on = null;
        if (t.due) {
          try { due_on = this.parseDateString(t.due); } catch { due_on = null; }
        }
        const nt = await asanaService.createTask({
          name: t.name,
          notes: t.notes || '',
          projects: projectIds,
          due_on
        });
        created.push(nt);
      } catch (e) {
        console.error(`Failed to create extracted task "${t.name}":`, e.message);
        failed.push({ task: t, error: e.message });
      }
    }

    // Clear pending state so buttons can't double-fire
    dataStore.setThreadData(channel, thread_ts, {
      pending_tasks: null,
      pending_tasks_project: null,
      pending_tasks_await_project: false,
      last_action: 'created_tasks_from_thread',
      last_action_time: Date.now()
    });

    let message = '';
    if (created.length) {
      message += `✅ Added ${created.length} task${created.length === 1 ? '' : 's'} to Asana${project ? ` in ${project.name}` : ''}:\n`;
      message += created.map(t => `• *${t.name}*${t.due_on ? ` (due ${t.due_on})` : ''}`).join('\n');
    }
    if (failed.length) {
      message += `${created.length ? '\n\n' : ''}⚠️ Couldn't create ${failed.length}:\n`;
      message += failed.map(f => `• ${f.task.name} — ${f.error}`).join('\n');
    }
    if (!message) message = 'Nothing to create.';
    if (created.length && !failed.length) message += `\n\nHandled. You're welcome.`;

    return await client.chat.postMessage({ channel, thread_ts, text: message.trim() });
  }

  // Format extracted tasks as a numbered mrkdwn list
  formatTaskList(tasks) {
    return tasks.map((t, i) => {
      let line = `${i + 1}. *${t.name}*`;
      if (t.due) line += `  _(due ${t.due})_`;
      if (t.assignee_hint) line += `  _— ${t.assignee_hint}_`;
      if (t.notes) line += `\n     ${t.notes}`;
      return line;
    }).join('\n');
  }

  // Build the preview message (task list + Create/Cancel buttons)
  buildTaskPreviewBlocks(tasks, projectName, stableTs) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Action items from the thread*${projectName ? ` → *${projectName}*` : ''}:\n\n${this.formatTaskList(tasks)}`
        }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Want me to add these to Asana?' }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: tasks.length === 1 ? 'Create task' : 'Create all' },
            style: 'primary',
            action_id: 'donna_create_tasks',
            value: stableTs
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            style: 'danger',
            action_id: 'donna_cancel_tasks',
            value: stableTs
          }
        ]
      }
    ];
  }

  // Generate daily rundown
  async generateDailyRundown() {
    try {
      const [todayTasks, overdueTasks, thisWeekTasks] = await Promise.all([
        asanaService.getTasksDueToday(),
        asanaService.getOverdueTasks(),
        asanaService.getTasksDueThisWeek()
      ]);
      
      let rundown = '*Daily Task Rundown*\n\n';
      
      if (overdueTasks.length > 0) {
        rundown += '*Overdue Tasks:*\n';
        rundown += overdueTasks.slice(0, 5).map(t => asanaService.formatTask(t, false)).join('\n');
        if (overdueTasks.length > 5) {
          rundown += `\n_...and ${overdueTasks.length - 5} more overdue tasks_`;
        }
        rundown += '\n\n';
      }
      
      if (todayTasks.length > 0) {
        rundown += '*Due Today:*\n';
        rundown += todayTasks.map(t => asanaService.formatTask(t, false)).join('\n') + '\n\n';
      }
      
      const upcomingTasks = thisWeekTasks.filter(t => {
        const dueDate = new Date(t.due_on);
        const today = new Date();
        return dueDate > today;
      });
      
      if (upcomingTasks.length > 0) {
        rundown += '*Coming Up This Week:*\n';
        rundown += upcomingTasks.slice(0, 5).map(t => asanaService.formatTask(t, false)).join('\n');
        if (upcomingTasks.length > 5) {
          rundown += `\n_...and ${upcomingTasks.length - 5} more this week_`;
        }
        rundown += '\n\n';
      }
      
      if (overdueTasks.length === 0 && todayTasks.length === 0 && upcomingTasks.length === 0) {
        rundown += 'No urgent tasks! You\'re all caught up. 🎉\n\n';
      }
      
      rundown += '_Have a productive day!_ ✨';
      
      return rundown;
      
    } catch (error) {
      console.error('Daily rundown error:', error);
      return `Sorry, I couldn't generate your daily rundown: ${error.message}`;
    }
  }

  // Handle listing available projects
  async handleListProjects({ client, channel, thread_ts }) {
    try {
      const projects = await asanaService.getProjects();
      
      if (projects.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'No projects found in your Asana workspace.'
        });
      }
      
      const projectList = projects
        .map(p => `• *${p.name}*${p.owner ? ` (${p.owner.name})` : ''}`)
        .join('\n');
        
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `*Available Asana projects:*\n\n${projectList}`
      });
      
    } catch (error) {
      console.error('List projects error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble fetching your projects: ${error.message}`
      });
    }
  }
  async getProjectsBlock() {
    try {
      const projects = await asanaService.getProjects();
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

  // Helper: Parse natural language dates
  parseDateString(dateStr) {
    const str = dateStr.toLowerCase().trim();
    const today = new Date();
    
    switch (str) {
      case 'today':
        return today.toISOString().split('T')[0];
        
      case 'tomorrow':
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
        
      case 'next week':
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        return nextWeek.toISOString().split('T')[0];
        
      case 'monday':
      case 'tuesday':
      case 'wednesday':
      case 'thursday':
      case 'friday':
      case 'saturday':
      case 'sunday':
        return this.getNextWeekday(str);
        
      default:
        // Try to parse as date
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().split('T')[0];
        }
        throw new Error(`Cannot parse date: ${dateStr}`);
    }
  }

  // Helper: Get next occurrence of a weekday
  getNextWeekday(dayName) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetDay = days.indexOf(dayName.toLowerCase());
    
    if (targetDay === -1) throw new Error(`Invalid day: ${dayName}`);
    
    const today = new Date();
    const currentDay = today.getDay();
    
    let daysUntilTarget = targetDay - currentDay;
    if (daysUntilTarget <= 0) daysUntilTarget += 7; // Next week if today or past
    
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + daysUntilTarget);
    
    return targetDate.toISOString().split('T')[0];
  }
}

module.exports = new ProjectHandler();