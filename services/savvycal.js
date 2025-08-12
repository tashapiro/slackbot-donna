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

  // Create a single-use scheduling link (UPDATED to ensure proper URL)
  async createSingleUseLink(title, minutes) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    // Always use scoped endpoint
    const baseCreate = `${this.baseUrl}/scopes/${this.scopeSlug}/links`;

    console.log(`Creating SavvyCal link via scoped endpoint: ${baseCreate}`);

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