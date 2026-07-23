// services/fireflies.js — Fireflies.ai integration (meeting notes / transcripts).
//
// Wraps the Fireflies GraphQL API (https://api.fireflies.ai/graphql) the same way the
// other services wrap their APIs: one thin, reusable class exposing plain methods, no
// Slack/agent concerns. Auth is a single API key (Bearer). Without FIREFLIES_API_KEY the
// service reports isEnabled() === false and the tools degrade gracefully — the bot still
// boots and everything else works (matches the defensive gating used for memory/registry).
//
// Field availability varies by Fireflies plan (summary/action_items need a paid plan), so
// every read is defensive: missing fields normalize to empty, never throw.

const FIREFLIES_ENDPOINT = 'https://api.fireflies.ai/graphql';

class FirefliesService {
  constructor() {
    this.apiKey = process.env.FIREFLIES_API_KEY || null;
    if (!this.apiKey) {
      console.warn('FIREFLIES_API_KEY not configured — Fireflies tools disabled');
    }
  }

  /** True when a key is configured and the service can make calls. */
  isEnabled() {
    return !!this.apiKey;
  }

  /** POST a GraphQL query and return `data`, or throw a readable error. */
  async query(query, variables = {}) {
    if (!this.apiKey) throw new Error('Fireflies API key not configured');

    let res;
    try {
      res = await fetch(FIREFLIES_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (err) {
      throw new Error(`Fireflies request failed: ${err.message}`);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Fireflies returned a non-JSON response (HTTP ${res.status})`);
    }

    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map(e => e.message).join('; '));
    }
    if (!res.ok) {
      throw new Error(`Fireflies API error: HTTP ${res.status}`);
    }
    return json.data || {};
  }

  // ── Reads ────────────────────────────────────────────────────────────────────

  /**
   * List recent meetings (most recent first). Lightweight fields only — enough to
   * pick which meeting the user means before fetching a full transcript.
   * @param {number} [limit=10]
   * @returns {Promise<Array>} normalized meeting summaries
   */
  async getRecentMeetings(limit = 10) {
    const q = `
      query RecentTranscripts($limit: Int) {
        transcripts(limit: $limit) {
          id
          title
          date
          duration
          organizer_email
          participants
          meeting_attendees { displayName email name }
        }
      }`;
    const data = await this.query(q, { limit });
    const list = Array.isArray(data.transcripts) ? data.transcripts : [];
    return list.map(t => this.normalizeMeeting(t));
  }

  /**
   * Fetch one transcript in full (summary + action items + sentences + attendees).
   * @param {string} id
   * @returns {Promise<Object>} normalized transcript
   */
  async getTranscript(id) {
    const q = `
      query Transcript($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          duration
          organizer_email
          participants
          meeting_attendees { displayName email name }
          summary {
            overview
            action_items
            keywords
            bullet_gist
            shorthand_bullet
          }
          sentences { speaker_name text }
        }
      }`;
    const data = await this.query(q, { id });
    if (!data.transcript) throw new Error(`No Fireflies transcript found for id ${id}`);
    return this.normalizeTranscript(data.transcript);
  }

  /**
   * Resolve which meeting the user means and return it in full.
   *  - id given          → fetch it directly.
   *  - title given       → fuzzy-match against recent meetings.
   *  - neither (or "last")→ the most recent meeting.
   * @param {Object} p
   * @param {string} [p.id]
   * @param {string} [p.title]
   * @param {number} [p.searchLimit=15]
   * @returns {Promise<{transcript:Object}|{error:string}|{candidates:Array}>}
   */
  async resolveMeeting({ id, title, searchLimit = 15 } = {}) {
    if (id) {
      return { transcript: await this.getTranscript(id) };
    }
    const recent = await this.getRecentMeetings(searchLimit);
    if (!recent.length) return { error: 'No recent Fireflies meetings found.' };

    if (!title || !title.trim() || /\b(last|latest|most recent|my last)\b/i.test(title)) {
      return { transcript: await this.getTranscript(recent[0].id) };
    }

    const matches = FirefliesService.matchByTitle(recent, title);
    if (!matches.length) {
      return { error: `No recent meeting matches "${title}".`, candidates: recent.slice(0, 8) };
    }
    if (matches.length > 1) {
      return { candidates: matches.slice(0, 8) };
    }
    return { transcript: await this.getTranscript(matches[0].id) };
  }

  // ── Normalizers ──────────────────────────────────────────────────────────────

  /** Merge participants (emails) + meeting_attendees (name+email) into one list. */
  static buildParticipants(t) {
    const byEmail = new Map();
    (t.meeting_attendees || []).forEach(a => {
      if (!a) return;
      const email = (a.email || '').trim().toLowerCase();
      const name = a.displayName || a.name || '';
      const key = email || name;
      if (key) byEmail.set(key, { name, email: email || null });
    });
    (t.participants || []).forEach(p => {
      const email = String(p || '').trim().toLowerCase();
      if (!email) return;
      if (!byEmail.has(email)) byEmail.set(email, { name: '', email });
    });
    return Array.from(byEmail.values());
  }

  normalizeMeeting(t) {
    return {
      id: t.id,
      title: t.title || '(untitled meeting)',
      date: t.date || null, // epoch ms
      durationMinutes: t.duration ? Math.round(t.duration) : null,
      organizerEmail: t.organizer_email || null,
      participants: FirefliesService.buildParticipants(t)
    };
  }

  normalizeTranscript(t) {
    const base = this.normalizeMeeting(t);
    const summary = t.summary || {};
    return {
      ...base,
      overview: summary.overview || '',
      actionItems: summary.action_items || '',
      keywords: Array.isArray(summary.keywords) ? summary.keywords : [],
      bulletGist: summary.bullet_gist || summary.shorthand_bullet || '',
      sentences: Array.isArray(t.sentences) ? t.sentences : []
    };
  }

  /** Full plain-text transcript from sentences (speaker: text lines). */
  static transcriptText(normalized, maxChars = 12000) {
    const lines = (normalized.sentences || [])
      .map(s => `${s.speaker_name ? `${s.speaker_name}: ` : ''}${s.text || ''}`.trim())
      .filter(Boolean);
    let text = lines.join('\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n… (transcript truncated)';
    return text;
  }

  /** Fuzzy title match: case-insensitive substring either direction, ranked by closeness. */
  static matchByTitle(meetings, title) {
    const needle = title.trim().toLowerCase();
    const scored = [];
    for (const m of meetings) {
      const hay = (m.title || '').toLowerCase();
      if (!hay) continue;
      if (hay === needle) scored.push({ m, score: 3 });
      else if (hay.includes(needle)) scored.push({ m, score: 2 });
      else if (needle.includes(hay)) scored.push({ m, score: 1 });
    }
    return scored.sort((a, b) => b.score - a.score).map(s => s.m);
  }
}

module.exports = new FirefliesService();
