// handlers/workout.js - Updated with better Peloton integration and error handling
const pelotonService = require('../services/peloton');
const googleCalendarService = require('../services/googleCalendar');
const TimezoneHelper = require('../utils/timezoneHelper');
const dataStore = require('../utils/dataStore');

class WorkoutHandler {
  // Handle workout recommendation requests
  async handleWorkoutRecommendation({ slots, client, channel, thread_ts, userId }) {
    try {
      const { 
        duration,
        workout_type,
        instructor
      } = slots;

      console.log(`Generating workout recommendation for ${userId}: ${duration ? duration + 'min' : 'any duration'} ${workout_type || 'any type'} workout${instructor ? ' with ' + instructor : ''}`);

      // Check if Peloton is configured
      if (!pelotonService.isConfigured) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'Peloton integration isn\'t configured yet. Ask your admin to set up PELOTON_USERNAME and PELOTON_PASSWORD environment variables.'
        });
      }

      // Donna's critical thinking: Handle different scenarios
      if (!duration && !workout_type && !instructor) {
        // No specifics at all - ask for preference
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'What kind of workout are you in the mood for? I can find cycling, strength, yoga, running, or any other discipline. Just tell me what sounds good.'
        });
      }

      if (workout_type && !duration && !instructor) {
        // Discipline only - suggest popular durations
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Great choice on ${workout_type}! How long do you want to go? Popular options are 20, 30, or 45 minutes. Or just say "surprise me" and I'll find something good.`
        });
      }

      if (duration && !workout_type && !instructor) {
        // Duration only - suggest popular disciplines
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `Perfect, ${duration} minutes is a solid block of time. What type of workout? I can find cycling, strength training, yoga, running, or anything else you're feeling.`
        });
      }

      // Show "thinking" message for specific requests
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: 'Let me find the perfect workout for you... 🏃‍♀️'
      });

      // Look up instructor if specified
      let instructorId = null;
      if (instructor) {
        try {
          const foundInstructor = await pelotonService.findInstructor(instructor);
          if (foundInstructor) {
            instructorId = foundInstructor.id;
            console.log(`Found instructor: ${foundInstructor.name} (ID: ${foundInstructor.id})`);
          } else {
            return await client.chat.postMessage({
              channel,
              thread_ts,
              text: `Couldn't find instructor "${instructor}". Try checking the spelling or ask me to "find popular cycling instructors" to see who's available.`
            });
          }
        } catch (error) {
          console.log('Instructor lookup failed:', error.message);
        }
      }

      // Get recommendations with simplified parameters
      let recommendations = [];
      try {
        recommendations = await pelotonService.getWorkoutRecommendations({
          duration: duration ? parseInt(duration) : null,
          discipline: workout_type,
          instructor: instructorId,
          limit: 3
        });
      } catch (error) {
        console.error('Error getting workout recommendations:', error);
      }

      if (recommendations.length === 0) {
        let message = `Couldn't find any classes matching those exact criteria.`;
        
        if (instructor) {
          message += ` "${instructor}" might not have ${workout_type || 'classes'} in that length.`;
        } else if (duration && workout_type) {
          message += ` Try a different duration for ${workout_type} or check what's popular right now.`;
        }
        
        message += ` Want me to suggest something similar?`;
        
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: message
        });
      }

      // Format the recommendations
      let message = `Perfect workouts for you:\n\n`;

      recommendations.forEach((workout) => {
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

      // Add context-specific suggestion
      if (instructor && recommendations[0]?.instructor) {
        message += `💡 _${recommendations[0].instructor} always brings the energy!_\n\n`;
      } else if (workout_type) {
        message += `💡 _${workout_type.charAt(0).toUpperCase() + workout_type.slice(1)} is a great choice!_\n\n`;
      }

      // Offer to schedule if it's a specific request
      if (duration && workout_type) {
        message += `Want me to block ${duration} minutes on your calendar for this?`;
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

module.exports = new WorkoutHandler();