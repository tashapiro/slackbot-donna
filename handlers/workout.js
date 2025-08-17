// handlers/workout.js - Handle workout recommendation requests
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
        duration, 
        workout_type, 
        time_of_day = 'anytime',
        energy_level = 'medium',
        when = 'now'
      } = slots;

      console.log(`Generating workout recommendation for ${userId}: ${duration}min ${workout_type} workout, ${energy_level} energy, ${time_of_day}`);

      // Determine available time if not specified
      let availableTime = duration ? parseInt(duration) : null;
      
      if (!availableTime && when !== 'now') {
        // Check calendar for available time slots
        availableTime = await this.findAvailableTimeSlot(when, userTimezone);
      }
      
      if (!availableTime) {
        availableTime = 30; // Default to 30 minutes
      }

      // Get personalized workout recommendations
      const recommendations = await pelotonService.getWorkoutRecommendations({
        availableTime,
        workoutType: workout_type,
        energyLevel: energy_level,
        timeOfDay: time_of_day
      });

      if (recommendations.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: `No Peloton classes found matching your criteria. Try adjusting your preferences or check your Peloton connection.`
        });
      }

      // Build recommendation message
      let message = this.buildRecommendationMessage(recommendations, availableTime, when, energy_level);
      
      // Add calendar integration if requested
      if (when !== 'now' && when !== 'anytime') {
        message += await this.addCalendarSchedulingOptions(when, availableTime, userTimezone, recommendations[0]);
      }

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: message
      });

    } catch (error) {
      console.error('Workout recommendation error:', error);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `Sorry, I had trouble finding workout recommendations: ${error.message}`
      });
    }
  }

  // Handle scheduling a specific workout
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
          text: 'I need a time to schedule your workout. Try: "schedule workout at 7am" or "block 30 minutes for Peloton at 6pm"'
        });
      }

      // Create calendar event for the workout
      const { startTime, endTime } = googleCalendarService.parseDateTime(date, time, workout_duration, userTimezone);
      
      const workoutTitle = workout_title || 'Peloton Workout';
      const event = await googleCalendarService.createEvent({
        summary: `🏋️ ${workoutTitle}`,
        description: 'Time blocked for Peloton workout via Donna',
        startTime,
        endTime,
        attendees: [],
        location: 'Peloton App',
        meetingType: null,
        timeZone: userTimezone
      });

      // Format confirmation message
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

      let message = `✅ Workout scheduled: *${workoutTitle}*\n`;
      message += `📅 ${dateStr} at ${timeStr}\n`;
      message += `⏱️ ${workout_duration} minutes\n\n`;
      message += `_Your workout time is protected. Time to get strong! 💪_`;

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
        text: `Sorry, I couldn't schedule that workout: ${error.message}`
      });
    }
  }

  // Handle workout history requests
  async handleWorkoutHistory({ slots, client, channel, thread_ts, userId }) {
    try {
      const { period = 'recent' } = slots;
      
      const workouts = await pelotonService.getWorkoutHistory(10);
      
      if (workouts.length === 0) {
        return await client.chat.postMessage({
          channel,
          thread_ts,
          text: 'No recent Peloton workouts found. Time to get back on the bike! 🚴‍♀️'
        });
      }

      let message = `*Your Recent Peloton Workouts:*\n\n`;
      
      workouts.slice(0, 5).forEach((workout, index) => {
        const date = new Date(workout.created_at * 1000).toLocaleDateString();
        const duration = Math.round(workout.total_duration / 60);
        const type = workout.fitness_discipline || 'Workout';
        const instructor = workout.instructor?.name || 'Unknown';
        
        message += `${index + 1}. *${type}* with ${instructor}\n`;
        message += `   📅 ${date} • ⏱️ ${duration} min\n`;
        if (workout.total_output) {
          message += `   📊 Output: ${workout.total_output}\n`;
        }
        message += '\n';
      });

      // Add motivational message
      const totalWorkouts = workouts.length;
      const thisWeekWorkouts = workouts.filter(w => {
        const workoutDate = new Date(w.created_at * 1000);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return workoutDate > weekAgo;
      }).length;

      message += `💪 *Stats:* ${thisWeekWorkouts} workouts this week`;
      if (thisWeekWorkouts >= 3) {
        message += ` - You're crushing it!`;
      } else if (thisWeekWorkouts >= 1) {
        message += ` - Keep the momentum going!`;
      } else {
        message += ` - Time to get back to it!`;
      }

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
        text: `Sorry, I had trouble fetching your workout history: ${error.message}`
      });
    }
  }

  // Build recommendation message
  buildRecommendationMessage(recommendations, availableTime, when, energyLevel) {
    const context = when === 'now' ? 'right now' : when;
    const energy = energyLevel === 'high' ? 'high-energy' : 
                  energyLevel === 'low' ? 'chill' : '';
    
    let message = `*Perfect! Here are ${energy} workout recommendations for ${context}:*\n\n`;

    recommendations.forEach((workout, index) => {
      message += `${index + 1}. *${workout.title}*\n`;
      message += `   👨‍🏫 ${workout.instructor} • ⏱️ ${workout.duration} min • 🏋️ ${workout.discipline}\n`;
      message += `   ⭐ ${workout.rating} rating • 📊 Difficulty: ${workout.difficulty}/10\n`;
      if (workout.description) {
        const shortDesc = workout.description.length > 80 ? 
          workout.description.substring(0, 80) + '...' : 
          workout.description;
        message += `   _${shortDesc}_\n`;
      }
      message += `   🔗 <${workout.url}|Start Workout>\n\n`;
    });

    // Add motivational close
    const motivationalMessages = [
      "Time to get after it! 💪",
      "Your body will thank you later! 🔥",
      "Let's make it happen! 💯",
      "Ready to crush this workout? 🚀",
      "Time to earn that endorphin rush! ⚡"
    ];
    
    const motivation = motivationalMessages[Math.floor(Math.random() * motivationalMessages.length)];
    message += `_${motivation}_`;

    return message;
  }

  // Find available time slot in calendar
  async findAvailableTimeSlot(when, userTimezone) {
    try {
      let targetDate;
      
      switch (when.toLowerCase()) {
        case 'this morning':
        case 'morning':
          targetDate = new Date();
          // Look for time between 6-10 AM
          break;
        case 'this afternoon':
        case 'afternoon':
          targetDate = new Date();
          // Look for time between 12-5 PM
          break;
        case 'this evening':
        case 'evening':
          targetDate = new Date();
          // Look for time between 5-8 PM
          break;
        case 'today':
          targetDate = new Date();
          break;
        case 'tomorrow':
          targetDate = new Date();
          targetDate.setDate(targetDate.getDate() + 1);
          break;
        default:
          // Try to parse as time like "at 7am"
          return 30; // Default duration
      }

      // Get today's events to find gaps
      const events = await googleCalendarService.getEventsForDate(targetDate, userTimezone);
      
      // Simple logic: if lots of meetings, suggest shorter workout
      if (events.length >= 4) {
        return 20; // Busy day, shorter workout
      } else if (events.length >= 2) {
        return 30; // Moderate day
      } else {
        return 45; // Light day, longer workout
      }

    } catch (error) {
      console.error('Error finding available time slot:', error);
      return 30; // Default
    }
  }

  // Add calendar scheduling options
  async addCalendarSchedulingOptions(when, duration, userTimezone, topWorkout) {
    try {
      let message = `\n📅 *Schedule it:*\n`;
      message += `Want me to block ${duration} minutes on your calendar for "${topWorkout.title}"? `;
      message += `Just say: "schedule workout ${when}" or "block time for Peloton ${when}"\n\n`;
      
      return message;
    } catch (error) {
      return '';
    }
  }

  // Generate workout insights based on schedule and preferences
  async generateWorkoutInsights(userId, userTimezone) {
    try {
      const [workouts, todaysEvents] = await Promise.all([
        pelotonService.getWorkoutHistory(14), // Last 2 weeks
        googleCalendarService.getEventsToday(userTimezone)
      ]);

      const insights = [];

      // Analyze workout frequency
      const thisWeekWorkouts = workouts.filter(w => {
        const workoutDate = new Date(w.created_at * 1000);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return workoutDate > weekAgo;
      }).length;

      if (thisWeekWorkouts === 0) {
        insights.push("No workouts this week - perfect time to get back into it!");
      } else if (thisWeekWorkouts >= 4) {
        insights.push("Great workout consistency this week!");
      }

      // Calendar-based suggestions
      if (todaysEvents.length === 0) {
        insights.push("Clear calendar today - ideal for a longer workout session.");
      } else if (todaysEvents.length >= 4) {
        insights.push("Busy day ahead - a quick 15-20 min workout could boost your energy.");
      }

      return insights.join(' ');

    } catch (error) {
      console.error('Error generating workout insights:', error);
      return null;
    }
  }
}

module.exports = new WorkoutHandler();