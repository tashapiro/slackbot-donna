// handlers/workout.js - Updated with better Peloton integration and error handling
const pelotonService = require('../services/peloton');
const googleCalendarService = require('../services/googleCalendar');
const TimezoneHelper = require('../utils/timezoneHelper');
const dataStore = require('../utils/dataStore');

class WorkoutHandler {
  // Handle workout recommendation requests
  async handleWorkoutRecommendation({ slots, client, channel, thread_ts, userId }) {
    try {
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      
      const { 
        duration = 30,
        workout_type,
        time_of_day = 'anytime',
        energy_level = 'medium',
        when = 'now'
      } = slots;

      console.log(`Generating workout recommendation for ${userId}: ${duration}min ${workout_type || 'any'} workout, ${energy_level} energy, ${time_of_day}`);

      // Check if Peloton is configured
      if (!pelotonService.isConfigured) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'Peloton integration isn\'t configured yet. Ask your admin to set up PELOTON_USERNAME and PELOTON_PASSWORD environment variables.'
        });
      }

      // Show "thinking" message
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: 'Let me find the perfect workout for you... 🏃‍♀️'
      });

      // Determine workout types to search for
      let workoutTypes = [];
      if (workout_type) {
        workoutTypes = [workout_type.toLowerCase()];
      } else {
        // Get recommendations based on time and energy
        workoutTypes = pelotonService.getWorkoutTypeRecommendations(time_of_day, energy_level);
      }

      let allRecommendations = [];
      
      // Try to get recommendations for each workout type
      for (const type of workoutTypes.slice(0, 2)) { // Limit to 2 types to avoid API overload
        try {
          const recommendations = await pelotonService.getWorkoutRecommendations({
            duration: parseInt(duration),
            discipline: type,
            timeOfDay: time_of_day,
            energyLevel: energy_level,
            limit: 3
          });
          
          if (recommendations.length > 0) {
            allRecommendations.push(...recommendations);
          } else {
            console.log(`No exact matches for ${type} at ${duration} minutes, trying broader search...`);
            // Fallback: try without duration filter
            const fallbackRecommendations = await pelotonService.getWorkoutRecommendations({
              discipline: type,
              timeOfDay: time_of_day,
              energyLevel: energy_level,
              limit: 2
            });
            allRecommendations.push(...fallbackRecommendations);
          }
        } catch (error) {
          console.log(`No ${type} classes found, trying next type...`);
        }
      }

      if (allRecommendations.length === 0) {
        // Fallback: try a very broad search
        try {
          allRecommendations = await pelotonService.getWorkoutRecommendations({
            duration: parseInt(duration),
            discipline: 'cycling', // Default fallback
            limit: 3
          });
        } catch (error) {
          console.error('Error getting fallback recommendations:', error);
        }
      }

      if (allRecommendations.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Couldn't find any ${duration ? duration + '-minute ' : ''}classes matching your criteria right now. Try asking for a different duration or check the Peloton app directly for more options.`
        });
      }

      // Format the recommendations
      const topRecommendations = allRecommendations.slice(0, 3);
      let message = `Perfect workouts for you:\n\n`;

      topRecommendations.forEach((workout) => {
        message += `*<${workout.url}|${workout.title}>*\n`;
        message += `_${workout.instructor} • ${workout.duration} • ${workout.discipline}_\n`;
        if (workout.difficulty !== 'Not Rated') {
          message += `Difficulty: ${workout.difficulty}/10`;
        }
        if (workout.rating !== 'New') {
          message += ` • Rating: ${workout.rating}/10`;
        }
        message += `\n\n`;
      });

      // Add personalized suggestion based on time/energy
      const suggestions = this.getWorkoutSuggestion(time_of_day, energy_level, duration);
      if (suggestions) {
        message += `💡 _${suggestions}_\n\n`;
      }

      // Add note about duration filtering if we filtered by duration
      if (duration && parseInt(duration) !== 30) {
        message += `_Filtered for ${duration}-minute classes. Want different durations? Just ask!_\n\n`;
      }

      // Offer to schedule
      if (when !== 'now') {
        message += `Want me to block time on your calendar for one of these workouts?`;
      }

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });

    } catch (error) {
      console.error('Workout recommendation error:', error);
      
      let errorMessage = 'Having trouble finding workouts right now. ';
      
      if (error.message.includes('authentication') || error.message.includes('login')) {
        errorMessage += 'There might be an issue with the Peloton login credentials.';
      } else if (error.message.includes('404') || error.message.includes('not found')) {
        errorMessage += 'The Peloton API might have changed - let your admin know.';
      } else {
        errorMessage += 'Try asking for a specific type of workout or check back in a few minutes.';
      }

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: errorMessage
      });
    }
  }

  // Handle scheduling a workout on calendar
  async handleScheduleWorkout({ slots, client, channel, thread_ts, userId }) {
    try {
      const userTimezone = await TimezoneHelper.getUserTimezone(client, userId);
      
      const {
        workout_title,
        workout_duration = 30,
        date = 'today',
        time
      } = slots;

      if (!time) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'When do you want to schedule your workout? Try: "schedule workout at 7am tomorrow" or "block 30 minutes for Peloton at 6pm"'
        });
      }

      // Parse the time and create calendar event
      const { startTime, endTime } = googleCalendarService.parseDateTime(
        date, 
        time, 
        parseInt(workout_duration), 
        userTimezone
      );

      const title = workout_title || `Peloton Workout (${workout_duration} min)`;
      const description = 'Workout time blocked via Donna\n\nCheck Peloton app for class recommendations.';

      const event = await googleCalendarService.createEvent({
        summary: title,
        description,
        startTime,
        endTime,
        attendees: [],
        location: '',
        timeZone: userTimezone
      });

      // Format confirmation
      const eventDate = new Date(event.start.dateTime);
      const timeStr = eventDate.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: userTimezone
      });
      const dateStr = eventDate.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: userTimezone
      });

      let message = `✅ Workout scheduled: ${event.summary}\n`;
      message += `📅 ${dateStr} at ${timeStr}\n`;
      message += `🏃‍♀️ Time to get moving! I already took care of your calendar.`;

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });

    } catch (error) {
      console.error('Schedule workout error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Couldn't schedule that workout: ${error.message}`
      });
    }
  }

  // Handle workout history requests
  async handleWorkoutHistory({ slots, client, channel, thread_ts, userId }) {
    try {
      const { period = 'recent' } = slots;

      // Check if Peloton is configured
      if (!pelotonService.isConfigured) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'Peloton integration isn\'t configured yet to show your workout history.'
        });
      }

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: 'Let me check your recent workouts... 📊'
      });

      // Get workout history
      const limit = period === 'recent' ? 5 : 10;
      const workouts = await pelotonService.getUserWorkouts({ limit });

      if (workouts.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'No recent workouts found. Time to get back on the bike! 🚴‍♀️'
        });
      }

      // Get user overview for stats
      let overview = null;
      try {
        overview = await pelotonService.getUserOverview();
      } catch (error) {
        console.log('Could not fetch user overview:', error.message);
      }

      let message = `*Your Recent Workouts:*\n\n`;

      workouts.forEach((workout, index) => {
        const workoutDate = new Date(workout.created_at);
        const dateStr = workoutDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        });
        
        const rideInfo = workout.ride || {};
        const instructor = rideInfo.instructor?.name || 'Unknown';
        const title = rideInfo.title || 'Workout';
        const discipline = rideInfo.fitness_discipline || 'cycling';
        const duration = rideInfo.duration ? Math.round(rideInfo.duration / 60) : '?';

        message += `${index + 1}. *${title}*\n`;
        message += `   _${instructor} • ${duration} min • ${discipline} • ${dateStr}_\n`;
        
        // Add performance stats if available
        if (workout.total_output) {
          message += `   Output: ${workout.total_output} kJ`;
        }
        if (workout.avg_watts) {
          message += ` • Avg Watts: ${Math.round(workout.avg_watts)}`;
        }
        if (workout.avg_cadence) {
          message += ` • Avg Cadence: ${Math.round(workout.avg_cadence)}`;
        }
        message += '\n\n';
      });

      // Add overview stats if available
      if (overview && overview.total_workouts) {
        message += `📈 Total Stats: ${overview.total_workouts} workouts completed`;
        if (overview.total_workout_days) {
          message += ` across ${overview.total_workout_days} days`;
        }
        message += '\n\n';
      }

      message += '_Keep up the great work!_ 💪';

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });

    } catch (error) {
      console.error('Workout history error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Having trouble accessing your workout history: ${error.message}`
      });
    }
  }

  // Helper: Get personalized workout suggestions
  getWorkoutSuggestion(timeOfDay, energyLevel, duration) {
    const suggestions = {
      morning: {
        low: `Perfect for starting your day mindfully. A gentle ${duration}-minute session sets a positive tone.`,
        medium: `Great choice for morning energy! This ${duration}-minute workout will energize your whole day.`,
        high: `Bold morning choice! A ${duration}-minute intensive session - you'll feel unstoppable after this.`
      },
      afternoon: {
        low: `Smart midday reset. A ${duration}-minute recovery session helps maintain focus for the rest of your day.`,
        medium: `Perfect afternoon energy boost! ${duration} minutes to recharge and refocus.`,
        high: `Afternoon intensity! This ${duration}-minute session will power you through the rest of your day.`
      },
      evening: {
        low: `Excellent way to unwind. ${duration} minutes to decompress from your day.`,
        medium: `Good evening balance - ${duration} minutes of movement without overdoing it before rest.`,
        high: `High-energy evening session! Make sure you have time to cool down before bed.`
      }
    };

    return suggestions[timeOfDay]?.[energyLevel] || 
           `${duration} minutes of movement - exactly what you need right now.`;
  }
}

module.exports = new WorkoutHandler();