// services/asana.js - Asana API integration
const dataStore = require('../utils/dataStore');

class AsanaService {
  constructor() {
    this.apiToken = process.env.ASANA_API_TOKEN;
    this.workspaceId = process.env.ASANA_WORKSPACE_ID;
    this.baseUrl = 'https://app.asana.com/api/1.0';
    
    if (!this.apiToken) {
      console.warn('ASANA_API_TOKEN not configured');
    }
  }

  // Generate auth header for Asana API
  getAuthHeaders() {
    if (!this.apiToken) throw new Error('Asana API token not configured');
    
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  // Get user's workspaces and cache the primary one
  async getWorkspaces() {
    const cacheKey = 'asana_workspaces';
    const cached = dataStore.getCachedData(cacheKey, 3600000); // Cache for 1 hour
    if (cached) return cached;

    try {
      const response = await fetch(`${this.baseUrl}/workspaces`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      const workspaces = result.data;
      dataStore.setCachedData(cacheKey, workspaces);
      
      // If no workspace ID is configured, use the first one
      if (!this.workspaceId && workspaces.length > 0) {
        this.workspaceId = workspaces[0].gid;
        console.log(`Using Asana workspace: ${workspaces[0].name} (${this.workspaceId})`);
      }

      return workspaces;
    } catch (error) {
      console.error('Error fetching Asana workspaces:', error);
      throw error;
    }
  }

  // Get current user info
  async getMe() {
    const cacheKey = 'asana_me';
    const cached = dataStore.getCachedData(cacheKey, 3600000);
    if (cached) return cached;

    try {
      const response = await fetch(`${this.baseUrl}/users/me`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      const user = result.data;
      dataStore.setCachedData(cacheKey, user);
      return user;
    } catch (error) {
      console.error('Error fetching Asana user:', error);
      throw error;
    }
  }

  // Get projects for the workspace
  async getProjects() {
    if (!this.workspaceId) await this.getWorkspaces();
    
    const cacheKey = `asana_projects_${this.workspaceId}`;
    const cached = dataStore.getCachedData(cacheKey, 1800000); // Cache for 30 min
    if (cached) return cached;

    try {
      const response = await fetch(
        `${this.baseUrl}/projects?workspace=${this.workspaceId}&opt_fields=name,color,archived,owner.name`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      const projects = result.data.filter(p => !p.archived); // Only active projects
      dataStore.setCachedData(cacheKey, projects);
      return projects;
    } catch (error) {
      console.error('Error fetching Asana projects:', error);
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

  // Get tasks with various filters
  async getTasks({
    assignee = 'me',
    project = null,
    completed_since = null,
    due_on = null,
    due_before = null,
    due_after = null,
    limit = 50
  } = {}) {
    if (!this.workspaceId) await this.getWorkspaces();

    const params = new URLSearchParams({
      assignee: assignee === 'me' ? 'me' : assignee,
      workspace: this.workspaceId,
      limit: limit.toString(),
      opt_fields: 'name,notes,completed,due_on,due_at,projects.name,assignee.name,created_at,modified_at,permalink_url'
    });

    if (project) params.append('project', project);
    if (completed_since) params.append('completed_since', completed_since);
    if (due_on) params.append('due_on', due_on);
    if (due_before) params.append('due_before', due_before);
    if (due_after) params.append('due_after', due_after);

    try {
      const response = await fetch(
        `${this.baseUrl}/tasks?${params}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Asana API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      return result.data;
    } catch (error) {
      console.error('Error fetching Asana tasks:', error);
      throw error;
    }
  }

  // Get tasks due today
  async getTasksDueToday() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    return this.getTasks({ due_on: today, completed_since: 'now' });
  }

  // Get tasks due this week
  async getTasksDueThisWeek() {
    const today = new Date();
    const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    return this.getTasks({
      due_after: today.toISOString().split('T')[0],
      due_before: nextWeek.toISOString().split('T')[0],
      completed_since: 'now'
    });
  }

  // Get overdue tasks
  async getOverdueTasks() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    return this.getTasks({
      due_before: yesterday.toISOString().split('T')[0],
      completed_since: 'now'
    });
  }

  // Update a task
  async updateTask(taskId, updates) {
    try {
      const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
        method: 'PUT',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ data: updates })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Asana API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();
      
      // Clear cache to force refresh on next query
      dataStore.apiCache.clear();
      
      return result.data;
    } catch (error) {
      console.error('Error updating Asana task:', error);
      throw error;
    }
  }

  // Mark task as complete
  async completeTask(taskId) {
    return this.updateTask(taskId, { completed: true });
  }

  // Create a new task
  async createTask({
    name,
    notes = '',
    assignee = 'me',
    due_on = null,
    projects = [],
    parent = null
  }) {
    if (!this.workspaceId) await this.getWorkspaces();

    const taskData = {
      name,
      notes,
      projects,
      workspace: this.workspaceId
    };

    if (assignee === 'me') {
      const user = await this.getMe();
      taskData.assignee = user.gid;
    } else if (assignee) {
      taskData.assignee = assignee;
    }

    if (due_on) taskData.due_on = due_on;
    if (parent) taskData.parent = parent;

    try {
      const response = await fetch(`${this.baseUrl}/tasks`, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ data: taskData })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Asana API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();
      
      // Clear cache to force refresh
      dataStore.apiCache.clear();
      
      return result.data;
    } catch (error) {
      console.error('Error creating Asana task:', error);
      throw error;
    }
  }

  // Helper: Format task for display
  formatTask(task, includeProject = true) {
    let formatted = `• *${task.name}*`;
    
    if (task.due_on) {
      const dueDate = new Date(task.due_on);
      const today = new Date();
      const isToday = dueDate.toDateString() === today.toDateString();
      const isPast = dueDate < today;
      
      if (isToday) {
        formatted += ' 🟡 (due today)';
      } else if (isPast) {
        formatted += ' 🔴 (overdue)';
      } else {
        formatted += ` (due ${dueDate.toLocaleDateString()})`;
      }
    }
    
    if (includeProject && task.projects && task.projects.length > 0) {
      formatted += ` _[${task.projects[0].name}]_`;
    }
    
    return formatted;
  }

  // Helper: Group tasks by status/urgency
  groupTasksByUrgency(tasks) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const groups = {
      overdue: [],
      today: [],
      thisWeek: [],
      later: [],
      noDueDate: []
    };

    tasks.forEach(task => {
      if (!task.due_on) {
        groups.noDueDate.push(task);
        return;
      }

      const dueDate = new Date(task.due_on);
      dueDate.setHours(0, 0, 0, 0);
      
      const daysDiff = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
      
      if (daysDiff < 0) {
        groups.overdue.push(task);
      } else if (daysDiff === 0) {
        groups.today.push(task);
      } else if (daysDiff <= 7) {
        groups.thisWeek.push(task);
      } else {
        groups.later.push(task);
      }
    });

    return groups;
  }
}

module.exports = new AsanaService();