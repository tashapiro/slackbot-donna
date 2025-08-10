// utils/errorHandler.js - Standardized error handling and user-friendly messages

class ErrorHandler {
    // Handle API errors with user-friendly messages and troubleshooting info
    static async handleApiError(error, client, channel, thread_ts, service = 'API') {
      console.error(`${service} Error:`, error);
      
      let userMessage = 'Sorry, something went wrong. ';
      let troubleshootingInfo = '';
      
      // Categorize common error types
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        userMessage += `I couldn't authenticate with ${service}. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* Check that your ${service} API token is correct and hasn't expired.`;
      } 
      else if (error.message.includes('403') || error.message.includes('Forbidden')) {
        userMessage += `I don't have permission to access ${service}. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* Your ${service} API token might not have the required permissions.`;
      }
      else if (error.message.includes('404') || error.message.includes('Not Found')) {
        userMessage += `Couldn't find the requested resource in ${service}. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* The workspace, project, or item might have been deleted or moved.`;
      }
      else if (error.message.includes('429') || error.message.includes('rate limit')) {
        userMessage += `${service} is rate limiting our requests. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* Try again in a few minutes - we're making too many requests.`;
      }
      else if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        userMessage += `${service} isn't responding. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* This is usually temporary. Try again in a moment.`;
      }
      else if (error.message.includes('network') || error.message.includes('fetch')) {
        userMessage += `Can't connect to ${service}. `;
        troubleshootingInfo = `🔧 *Troubleshooting:* Check your internet connection or ${service} service status.`;
      }
      else {
        userMessage += `Unexpected error with ${service}. `;
        troubleshootingInfo = `🔧 *Error details:* ${error.message}`;
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `${userMessage}\n\n${troubleshootingInfo}`
      });
    }
  
    // Handle configuration errors (missing API keys, etc.)
    static async handleConfigError(client, channel, thread_ts, service, missingConfig) {
      const message = `I can't access ${service} because it's not configured properly.\n\n` +
                     `🔧 *Missing:* ${missingConfig}\n` +
                     `Ask your admin to add the required environment variables and restart me.`;
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });
    }
  
    // Handle validation errors (bad user input)
    static async handleValidationError(client, channel, thread_ts, message, suggestions = []) {
      let response = `❌ ${message}`;
      
      if (suggestions.length > 0) {
        response += '\n\n*Try this instead:*\n' + suggestions.map(s => `• ${s}`).join('\n');
      }
      
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: response
      });
    }
  
    // Wrap async functions with error handling
    static wrapHandler(handlerFn, service = 'Service') {
      return async (params) => {
        try {
          await handlerFn(params);
        } catch (error) {
          const { client, channel, thread_ts } = params;
          
          if (error.name === 'ValidationError') {
            await this.handleValidationError(client, channel, thread_ts, error.message, error.suggestions);
          } else if (error.name === 'ConfigError') {
            await this.handleConfigError(client, channel, thread_ts, service, error.message);
          } else {
            await this.handleApiError(error, client, channel, thread_ts, service);
          }
        }
      };
    }
  
    // Custom error types
    static ValidationError(message, suggestions = []) {
      const error = new Error(message);
      error.name = 'ValidationError';
      error.suggestions = suggestions;
      return error;
    }
  
    static ConfigError(message) {
      const error = new Error(message);
      error.name = 'ConfigError';
      return error;
    }
  }
  
  module.exports = ErrorHandler;