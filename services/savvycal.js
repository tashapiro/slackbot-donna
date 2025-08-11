// services/savvycal.js - SavvyCal API integration
const dataStore = require('../utils/dataStore');

class SavvyCalService {
  constructor() {
    this.apiToken = process.env.SAVVYCAL_TOKEN;
    this.scopeSlug = process.env.SAVVYCAL_SCOPE_SLUG;
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

  // Build URL from SavvyCal link object
  buildUrlFrom(link, scope = null) {
    const slug = link.slug || '';
    if (link.url) return link.url;
    if (slug.includes('/')) return `https://savvycal.com/${slug}`;
    
    const useScope = scope || this.scopeSlug;
    return useScope ? `https://savvycal.com/${useScope}/${slug}` : `https://savvycal.com/${slug}`;
  }

  // Create a single-use scheduling link
  async createSingleUseLink(title, minutes) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const baseCreate = this.scopeSlug
      ? `${this.baseUrl}/scopes/${this.scopeSlug}/links`
      : `${this.baseUrl}/links`;

    // Step 1: Create the link
    const createRes = await fetch(baseCreate, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ 
        name: title, 
        type: 'single', 
        description: `${minutes} min` 
      })
    });
    
    const createText = await createRes.text();
    if (!createRes.ok) {
      throw new Error(`SavvyCal create failed ${createRes.status}: ${createText}`);
    }
    
    const created = JSON.parse(createText);
    const link = created.link || created;
    const url = this.buildUrlFrom(link, this.scopeSlug);

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
    
    return { id: link.id, url };
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

  // List all links
  async getLinks() {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    const url = this.scopeSlug
      ? `${this.baseUrl}/scopes/${this.scopeSlug}/links`
      : `${this.baseUrl}/links`;

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