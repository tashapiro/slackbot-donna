// services/savvycal.js - SavvyCal API integration with hard-coded indievisual scope
const dataStore = require('../utils/dataStore');

class SavvyCalService {
  constructor() {
    this.apiToken = process.env.SAVVYCAL_TOKEN;
    // Hard-code the scope to always use "indievisual"
    this.scopeSlug = 'indievisual';
    this.baseUrl = 'https://api.savvycal.com/v1';
    
    if (!this.apiToken) {
      console.warn('SAVVYCAL_TOKEN not configured');
    }
  }

  // Generate auth headers for SavvyCal API
  getAuthHeaders() {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');
    
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };
  }

  // Build URL from SavvyCal link object (FIXED to always use indievisual)
  buildUrlFrom(link, scope = null) {
    const slug = link.slug || link.id || '';
    
    // If link already has a full URL, return it
    if (link.url) return link.url;
    
    // If slug already contains a slash (like "indievisual/abc123"), use it as-is
    if (slug.includes('/')) {
      return `https://savvycal.com/${slug}`;
    }
    
    // Always use "indievisual" as the scope - never fall back to just the slug
    const useScope = scope || this.scopeSlug;
    if (useScope) {
      const finalUrl = `https://savvycal.com/${useScope}/${slug}`;
      console.log(`Built SavvyCal URL: ${finalUrl}`);
      return finalUrl;
    } else {
      // This shouldn't happen since we hard-code scopeSlug, but just in case
      console.warn('No scope slug available, falling back to basic URL');
      return `https://savvycal.com/${slug}`;
    }
  }

  // Create a single-use scheduling link (expires after one booking).
  async createSingleUseLink(title, minutes) {
    return this._createLink(title, minutes, { type: 'single' });
  }

  // Create a reusable (standing) scheduling link — bookable more than once.
  // NOTE (verify on Render): a reusable link is created by omitting the
  // single-use `type`. This mirrors the single-use path (proven) minus that
  // flag; confirm the resulting link is reusable when SavvyCal egress is
  // available in production.
  async createReusableLink(title, minutes) {
    return this._createLink(title, minutes, {});
  }

  // Shared create path for scheduling links. `extra` merges into the create
  // body (e.g. { type: 'single' } for single-use). Always creates under the
  // hard-coded indievisual scope, then PATCHes the durations.
  async _createLink(title, minutes, extra = {}) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    // Always use scoped endpoint
    const baseCreate = `${this.baseUrl}/scopes/${this.scopeSlug}/links`;

    console.log(`Creating SavvyCal link via scoped endpoint: ${baseCreate}`, extra);

    // Step 1: Create the link
    const createRes = await fetch(baseCreate, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        name: title,
        description: `${minutes} min`,
        ...extra
      })
    });

    const createText = await createRes.text();
    if (!createRes.ok) {
      throw new Error(`SavvyCal create failed ${createRes.status}: ${createText}`);
    }

    const created = JSON.parse(createText);
    const link = created.link || created;

    console.log(`Created link response:`, link);

    // Build the URL ensuring it includes indievisual
    const url = this.buildUrlFrom(link, this.scopeSlug);

    console.log(`Final URL: ${url}`);

    // Step 2: Update the link with duration settings
    const patchRes = await fetch(`${this.baseUrl}/links/${link.id}`, {
      method: 'PATCH',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        durations: [minutes],
        default_duration: minutes
      })
    });

    if (!patchRes.ok) {
      const patchText = await patchRes.text();
      throw new Error(`SavvyCal PATCH durations failed ${patchRes.status}: ${patchText}`);
    }

    // Verify the final URL format
    if (!url.includes('indievisual')) {
      console.warn(`WARNING: Created URL does not contain 'indievisual': ${url}`);
    }

    return { id: link.id, url, reusable: extra.type !== 'single' };
  }

  // List booked events (scheduled appointments) via GET /v1/events.
  // NOTE (verify on Render): the /v1/events endpoint and its response shape
  // are documented but were not reachable from the build sandbox (egress
  // blocked). Response is parsed defensively — { entries|events|data } arrays
  // are all handled — and the raw payload is logged for the live check.
  async getEvents({ from = null, to = null } = {}) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const url = `${this.baseUrl}/events${query}`;

    console.log(`Fetching SavvyCal events: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal get events failed ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    // SavvyCal list endpoints have used both bare arrays and { entries: [...] };
    // handle the common shapes without assuming one.
    const events = Array.isArray(data)
      ? data
      : (data.entries || data.events || data.data || []);
    return events;
  }

  // ── Meeting polls ───────────────────────────────────────────────────────────
  // SavvyCal "meeting polls": propose specific time slots to a group who vote on
  // them. NOTE (verify on Render): the poll endpoints/payloads below follow the
  // same scoped pattern proven for links (POST/GET /v1/scopes/<scope>/polls,
  // /v1/polls/<id>) and the documented poll schema (name, duration, slots with
  // start_at/end_at, votes, rank), but could not be exercised from the build
  // sandbox. Every call parses defensively and logs its raw response.

  // Create + send a meeting poll.
  // @param {Object} p
  // @param {string} p.name              Poll title.
  // @param {number} p.durationMinutes   Meeting length for the chosen slot.
  // @param {Array<{start_at:string,end_at?:string}>} p.slots  Proposed times (ISO 8601).
  // @param {string[]} [p.attendees]     Optional participant emails to invite.
  async createPoll({ name, durationMinutes, slots, attendees = [] }) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');
    if (!name || !name.trim()) throw new Error('A poll needs a name.');
    if (!Array.isArray(slots) || !slots.length) throw new Error('A poll needs at least one time slot.');

    const duration = parseInt(durationMinutes, 10) || 30;

    // Normalize slots to { start_at, end_at } ISO strings; derive end from
    // duration when only a start is given.
    const normSlots = slots
      .map(s => {
        const start = s.start_at || s.start;
        if (!start) return null;
        const startDate = new Date(start);
        if (isNaN(startDate.getTime())) return null;
        const end = s.end_at || s.end ||
          new Date(startDate.getTime() + duration * 60000).toISOString();
        return { start_at: startDate.toISOString(), end_at: new Date(end).toISOString() };
      })
      .filter(Boolean);

    if (!normSlots.length) throw new Error('None of the proposed time slots were valid.');

    const body = {
      name: name.trim(),
      duration,
      slots: normSlots
    };
    const recipients = (attendees || []).filter(Boolean);
    if (recipients.length) body.attendees = recipients.map(email => ({ email }));

    const createUrl = `${this.baseUrl}/scopes/${this.scopeSlug}/polls`;
    console.log(`Creating SavvyCal poll: ${createUrl}`, JSON.stringify(body));

    const res = await fetch(createUrl, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`SavvyCal poll create failed ${res.status}: ${text}`);

    const created = JSON.parse(text);
    const poll = created.poll || created.entry || created;
    console.log('Created poll response:', poll);

    const url = poll.url || (poll.slug ? `https://savvycal.com/${this.scopeSlug}/${poll.slug}` : null);
    return { id: poll.id, url, slotCount: normSlots.length, invited: recipients.length };
  }

  // List meeting polls.
  async getPolls() {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');
    const url = `${this.baseUrl}/scopes/${this.scopeSlug}/polls`;
    console.log(`Fetching SavvyCal polls: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Accept': 'application/json' }
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal get polls failed ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.entries || data.polls || data.data || []);
  }

  // Get one poll (includes slots with vote counts + rank).
  async getPoll(pollId) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');
    const response = await fetch(`${this.baseUrl}/polls/${pollId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Accept': 'application/json' }
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal get poll failed ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    return data.poll || data.entry || data;
  }

  // Delete a poll.
  async deletePoll(pollId) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');
    const response = await fetch(`${this.baseUrl}/polls/${pollId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal delete poll failed ${response.status}: ${errorText}`);
    }
    return true;
  }

  // Toggle a link's enabled/disabled state
  async toggleLink(linkId) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const response = await fetch(`${this.baseUrl}/links/${linkId}/toggle`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal toggle failed ${response.status}: ${errorText}`);
    }

    return true;
  }

  // Get link details
  async getLink(linkId) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const response = await fetch(`${this.baseUrl}/links/${linkId}`, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${this.apiToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal get link failed ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.link || data;
  }

  // List all links (UPDATED to use scoped endpoint)
  async getLinks() {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    // Always use scoped endpoint
    const url = `${this.baseUrl}/scopes/${this.scopeSlug}/links`;

    console.log(`Fetching links from scoped endpoint: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${this.apiToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal get links failed ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.links || data;
  }

  // Delete a link
  async deleteLink(linkId) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const response = await fetch(`${this.baseUrl}/links/${linkId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.apiToken}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SavvyCal delete failed ${response.status}: ${errorText}`);
    }

    return true;
  }

  // Helper: Validate duration
  validateDuration(minutes) {
    const validDurations = [15, 30, 45, 60, 90, 120];
    const duration = parseInt(minutes, 10);
    
    if (isNaN(duration) || duration < 1) {
      throw new Error('Duration must be a valid number of minutes');
    }
    
    // Round to nearest valid duration
    return validDurations.reduce((closest, valid) => 
      Math.abs(valid - duration) < Math.abs(closest - duration) ? valid : closest
    );
  }

  // Helper: Generate link title from description
  generateLinkTitle(description, duration) {
    if (description && description.trim()) {
      return description.trim();
    }
    return `${duration} Minute Meeting`;
  }
}

module.exports = new SavvyCalService();