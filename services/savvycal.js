// services/savvycal.js - SavvyCal API integration (FIXED)
const dataStore = require('../utils/dataStore');

class SavvyCalService {
  constructor() {
    this.apiToken = process.env.SAVVYCAL_TOKEN;
    this.scopeSlug = process.env.SAVVYCAL_SCOPE_SLUG;
    this.baseUrl = 'https://api.savvycal.com/v1';
    
    if (!this.apiToken) {
      console.warn('SAVVYCAL_TOKEN not configured');
    }
    
    // Debug logging
    if (this.scopeSlug) {
      console.log(`SavvyCal: Using scope slug: ${this.scopeSlug}`);
    } else {
      console.log('SavvyCal: Using personal scope (no scope slug configured)');
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

  // Build URL from SavvyCal link object - Force scope when configured
  buildUrlFrom(link, scope = null) {
    const slug = link.slug || '';
    if (link.url) return link.url;
    if (slug.includes('/')) return `https://savvycal.com/${slug}`;
    
    // FORCE scope usage if configured, even for personal endpoint links
    const useScope = scope || this.scopeSlug;
    
    // Since we know from your link data that all links belong to "indievisual" scope,
    // always use it when configured, regardless of which endpoint was used
    if (this.scopeSlug) {
      console.log(`Building URL with forced scope: ${this.scopeSlug}/${slug}`);
      return `https://savvycal.com/${this.scopeSlug}/${slug}`;
    }
    
    return useScope ? `https://savvycal.com/${useScope}/${slug}` : `https://savvycal.com/${slug}`;
  }

  // Create a single-use scheduling link
  async createSingleUseLink(title, minutes) {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    // Always try scoped endpoint first if scope is configured
    let baseCreate = this.scopeSlug
      ? `${this.baseUrl}/scopes/${this.scopeSlug}/links`
      : `${this.baseUrl}/links`;

    console.log(`Creating SavvyCal link at: ${baseCreate}`);

    // Step 1: Create the link
    let createRes = await fetch(baseCreate, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ 
        name: title, 
        type: 'single', 
        description: `${minutes} min` 
      })
    });
    
    // If scoped creation fails, try personal endpoint as fallback
    if (!createRes.ok && createRes.status === 404 && this.scopeSlug) {
      console.log(`Scoped creation failed, trying personal endpoint...`);
      baseCreate = `${this.baseUrl}/links`;
      
      createRes = await fetch(baseCreate, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ 
          name: title, 
          type: 'single', 
          description: `${minutes} min` 
        })
      });
    }
    
    const createText = await createRes.text();
    if (!createRes.ok) {
      console.error(`SavvyCal create error: ${createRes.status} ${createText}`);
      throw new Error(`SavvyCal create failed ${createRes.status}: ${createText}`);
    }
    
    const created = JSON.parse(createText);
    const link = created.link || created;
    
    // Use scope if we successfully created via scoped endpoint
    const effectiveScope = baseCreate.includes('/scopes/') ? this.scopeSlug : null;
    const url = this.buildUrlFrom(link, effectiveScope);

    console.log(`Created link with effective scope: ${effectiveScope}, URL: ${url}`);

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
      console.error(`SavvyCal patch error: ${patchRes.status} ${patchText}`);
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
      console.error(`SavvyCal toggle error: ${response.status} ${errorText}`);
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
      console.error(`SavvyCal get link error: ${response.status} ${errorText}`);
      throw new Error(`SavvyCal get link failed ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.link || data;
  }

  // List all links - FIXED: Use correct response property + Auto-fallback
  async getLinks() {
    if (!this.apiToken) throw new Error('SavvyCal API token not configured');

    // Try with scope first, then fallback to personal if scope fails
    let url = this.scopeSlug
      ? `${this.baseUrl}/scopes/${this.scopeSlug}/links`
      : `${this.baseUrl}/links`;

    console.log(`Fetching SavvyCal links from: ${url}`);

    let response = await fetch(url, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${this.apiToken}`,
        'Accept': 'application/json'
      }
    });

    // If scope fails with 404, try personal scope as fallback
    if (!response.ok && response.status === 404 && this.scopeSlug) {
      console.log(`Scope "${this.scopeSlug}" failed, trying personal scope...`);
      url = `${this.baseUrl}/links`;
      
      response = await fetch(url, {
        method: 'GET',
        headers: { 
          'Authorization': `Bearer ${this.apiToken}`,
          'Accept': 'application/json'
        }
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`SavvyCal get links error: ${response.status} ${errorText}`);
      
      // Provide more helpful error messages
      if (response.status === 404) {
        if (this.scopeSlug) {
          throw new Error(`SavvyCal scope "${this.scopeSlug}" not found and personal scope also failed. Check your API token and scope configuration.`);
        } else {
          throw new Error(`SavvyCal links endpoint not found. Check your API token permissions.`);
        }
      } else if (response.status === 401) {
        throw new Error(`SavvyCal authentication failed. Check your API token.`);
      } else if (response.status === 403) {
        throw new Error(`SavvyCal access forbidden. Your API token may not have the required permissions.`);
      }
      
      throw new Error(`SavvyCal get links failed ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log(`SavvyCal response structure:`, Object.keys(data));
    
    // FIXED: Use 'entries' instead of 'links' based on API documentation
    const links = data.entries || data.links || data;
    console.log(`Found ${Array.isArray(links) ? links.length : 'unknown'} SavvyCal links`);
    
    return links;
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
      console.error(`SavvyCal delete error: ${response.status} ${errorText}`);
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