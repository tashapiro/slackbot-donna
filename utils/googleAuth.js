// utils/googleAuth.js — shared Google service-account credential parsing.
//
// Both the Calendar service and the (new) Sheets service authenticate as the same
// Google service account. This centralizes the credential parsing so the two agree
// on the env-var contract (full JSON in one var, OR client email + private key).
//
// (services/googleCalendar.js still has its own copy for backward compatibility;
// new callers should use this helper.)

/**
 * Parse Google service-account credentials from the environment.
 * Supports two forms, in priority order:
 *   A) GOOGLE_SERVICE_ACCOUNT_JSON — the entire service-account JSON as one string.
 *   B) GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (+ optional GOOGLE_PROJECT_ID).
 * @returns {object|null} credentials, or null when nothing is configured/parseable.
 */
function getGoogleCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      console.error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON:', error.message);
      return null;
    }
  }

  if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      project_id: process.env.GOOGLE_PROJECT_ID
    };
  }

  return null;
}

module.exports = { getGoogleCredentials };
