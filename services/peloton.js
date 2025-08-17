// services/peloton.js - Peloton API integration for workout recommendations
const dataStore = require('../utils/dataStore');

class PelotonService {
  constructor() {
    this.username = process.env.PELOTON_USERNAME;
    this.password = process.env.PELOTON_PASSWORD;
    this.baseUrl = 'https://api.onepeloton.com';
    this.sessionId = null;
    this.userId = null;
    
    if (!this.username || !this.password) {
      console.warn('PELOTON_USERNAME or PELOTON_PASSWORD not configured');
    }
  }

  // Authenticate with Peloton API
  async authenticate() {
    if (this.sessionId) {
      // Check if session is still valid
      const isValid = await this.validateSession();
      if (isValid) return this.sessionId;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Donna/1.0'
        },
        body: JSON.stringify({
          username_or_email: this.username,
          password: this.password
        })
      });

      if (!response.ok) {
        throw new Error(`Peloton auth failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      this.sessionId = data.session_id;
      this.userId = data.user_id;
      
      console.log('✅ Peloton authentication successful');
      return this.sessionId;
      
    } catch (error) {
      console.error('Peloton authentication error:', error);
      throw error;
    }
  }

  // Validate current session
  async validateSession() {
    if (!this.sessionId) return false;
    
    try {
      const response = await fetch(`${this.baseUrl}/api/me`, {
        headers: this.getAuthHeaders()
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  // Get auth headers
  getAuthHeaders() {
    if (!this.sessionId) throw new Error('Not authenticated with Peloton');
    
    return {
      'Cookie': `peloton_session_id=${this.sessionId}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Donna/1.0'
    };
  }

  // Get user's workout history
  async getWorkoutHistory(limit = 20) {
    await this.authenticate();
    
    const cacheKey = `peloton_history_${this.userId}`;
    const cached = dataStore.getCachedData(cacheKey, 1800000); // 30 min cache
    if (cached) return cached;

    try {
      const response = await fetch(`${this.baseUrl}/api/user/${this.userId}/workouts?limit=${limit}`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Peloton API error: ${response.status}`);
      }

      const data = await response.json();
      const workouts = data.data || [];
      
      dataStore.setCachedData(cacheKey, workouts);
      return workouts;
      
    } catch (error) {
      console.error('Error fetching workout history:', error);
      throw error;
    }
  }

  // Search for classes/workouts
  async searchClasses({
    duration = null,        // [10, 15, 20, 30, 45, 60, 75, 90]
    discipline = null,      // 'cycling', 'strength', 'yoga', 'meditation', 'stretching', 'running', 'walking'
    instructor = null,      // instructor name
    difficulty = null,      // 1-10 scale
    limit = 20
  } = {}) {
    await this.authenticate();

    const params = new URLSearchParams({
      limit: limit.toString(),
      browse_category: 'all'
    });

    if (duration) params.append('duration', duration.toString());
    if (discipline) params.append('super_genre_id', this.getDisciplineId(discipline));
    if (instructor) params.append('instructor_id', instructor);
    if (difficulty) {
      // Convert difficulty to Peloton's rating system
      const minRating = Math.max(1, difficulty - 1);
      const maxRating = Math.min(10, difficulty + 1);
      params.append('rating_range_lower_bound', minRating.toString());
      params.append('rating_range_upper_bound', maxRating.toString());
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/ride?${params}`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Peloton search error: ${response.status}`);
      }

      const data = await response.json();
      return data.data || [];
      
    } catch (error) {
      console.error('Error searching classes:', error);
      throw error;
    }
  }

  // Get workout recommendations based on preferences and schedule
  async getWorkoutRecommendations({
    availableTime = 30,     // minutes available
    workoutType = null,     // preferred type
    energyLevel = 'medium', // 'low', 'medium', 'high'
    timeOfDay = 'anytime'   // 'morning', 'afternoon', 'evening', 'anytime'
  } = {}) {
    console.log(`Getting workout recommendations for ${availableTime} minutes, ${energyLevel} energy, ${timeOfDay}`);

    try {
      // Get user's recent workout patterns
      const recentWorkouts = await this.getWorkoutHistory(10);
      const preferences = this.analyzeWorkoutPreferences(recentWorkouts);
      
      // Determine workout types based on time of day and energy
      const suitableTypes = this.getWorkoutTypesForContext(timeOfDay, energyLevel, workoutType);
      
      // Search for classes that fit the criteria
      const recommendations = [];
      
      for (const type of suitableTypes) {
        const classes = await this.searchClasses({
          duration: this.findBestDuration(availableTime),
          discipline: type,
          difficulty: this.getDifficultyForEnergyLevel(energyLevel),
          limit: 3
        });
        
        // Score and rank classes
        const scoredClasses = classes.map(cls => ({
          ...cls,
          score: this.scoreClass(cls, preferences, timeOfDay, energyLevel),
          discipline_name: type
        }));
        
        recommendations.push(...scoredClasses);
      }
      
      // Sort by score and return top recommendations
      return recommendations
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(cls => this.formatClassRecommendation(cls));
        
    } catch (error) {
      console.error('Error getting workout recommendations:', error);
      throw error;
    }
  }

  // Analyze user's workout preferences from history
  analyzeWorkoutPreferences(workouts) {
    const preferences = {
      favoriteTypes: {},
      averageDuration: 30,
      favoriteInstructors: {},
      preferredDifficulty: 5
    };

    if (workouts.length === 0) return preferences;

    // Analyze workout types
    workouts.forEach(workout => {
      const type = workout.fitness_discipline || 'unknown';
      preferences.favoriteTypes[type] = (preferences.favoriteTypes[type] || 0) + 1;
      
      const instructor = workout.instructor?.name;
      if (instructor) {
        preferences.favoriteInstructors[instructor] = (preferences.favoriteInstructors[instructor] || 0) + 1;
      }
    });

    // Calculate average duration
    const totalDuration = workouts.reduce((sum, w) => sum + (w.total_duration || 0), 0);
    preferences.averageDuration = Math.round(totalDuration / workouts.length / 60); // Convert to minutes

    return preferences;
  }

  // Get suitable workout types for context
  getWorkoutTypesForContext(timeOfDay, energyLevel, preferredType) {
    if (preferredType) return [preferredType];

    const morning = ['yoga', 'stretching', 'cycling', 'strength'];
    const afternoon = ['cycling', 'strength', 'running'];
    const evening = ['yoga', 'stretching', 'meditation'];
    
    const high = ['cycling', 'strength', 'running'];
    const medium = ['cycling', 'yoga', 'strength'];
    const low = ['yoga', 'stretching', 'meditation'];

    let types = [];
    
    switch (timeOfDay) {
      case 'morning': types = morning; break;
      case 'afternoon': types = afternoon; break;
      case 'evening': types = evening; break;
      default: types = ['cycling', 'strength', 'yoga', 'stretching'];
    }

    // Filter by energy level
    const energyTypes = energyLevel === 'high' ? high : 
                       energyLevel === 'low' ? low : medium;
    
    return types.filter(type => energyTypes.includes(type));
  }

  // Find best duration for available time
  findBestDuration(availableMinutes) {
    const durations = [10, 15, 20, 30, 45, 60, 75, 90];
    
    // Find duration that fits with 5-minute buffer
    const maxDuration = availableMinutes - 5;
    const suitable = durations.filter(d => d <= maxDuration);
    
    return suitable.length > 0 ? suitable[suitable.length - 1] : 15; // Default to 15 min
  }

  // Get difficulty for energy level
  getDifficultyForEnergyLevel(energyLevel) {
    switch (energyLevel) {
      case 'low': return 3;
      case 'medium': return 5;
      case 'high': return 7;
      default: return 5;
    }
  }

  // Score class based on preferences and context
  scoreClass(cls, preferences, timeOfDay, energyLevel) {
    let score = 5; // Base score

    // Prefer classes matching user's favorite types
    const type = cls.fitness_discipline;
    if (preferences.favoriteTypes[type]) {
      score += preferences.favoriteTypes[type] * 2;
    }

    // Prefer favorite instructors
    const instructor = cls.instructor?.name;
    if (instructor && preferences.favoriteInstructors[instructor]) {
      score += preferences.favoriteInstructors[instructor];
    }

    // Prefer classes close to user's average duration
    const durationDiff = Math.abs(cls.duration - preferences.averageDuration * 60);
    score -= durationDiff / 300; // Reduce score for duration differences

    // Boost highly rated classes
    if (cls.overall_rating_avg) {
      score += cls.overall_rating_avg;
    }

    return score;
  }

  // Format class recommendation for display
  formatClassRecommendation(cls) {
    return {
      id: cls.id,
      title: cls.title,
      instructor: cls.instructor?.name || 'Unknown',
      duration: Math.round(cls.duration / 60), // Convert to minutes
      difficulty: cls.difficulty_rating_avg || 'N/A',
      discipline: cls.discipline_name || cls.fitness_discipline,
      description: cls.description,
      rating: cls.overall_rating_avg ? cls.overall_rating_avg.toFixed(1) : 'New',
      url: `https://members.onepeloton.com/classes/${cls.fitness_discipline}?modal=classDetailsModal&classId=${cls.id}`
    };
  }

  // Helper: Get discipline ID for API calls
  getDisciplineId(discipline) {
    const disciplineMap = {
      'cycling': '5506b289-3a57-4394-8eb6-2b8b3f9b1f96',
      'strength': '5506b289-3a57-4394-8eb6-2b8b3f9b1f95',
      'yoga': '5506b289-3a57-4394-8eb6-2b8b3f9b1f97',
      'meditation': '5506b289-3a57-4394-8eb6-2b8b3f9b1f98',
      'stretching': '5506b289-3a57-4394-8eb6-2b8b3f9b1f99',
      'running': '5506b289-3a57-4394-8eb6-2b8b3f9b1f9a',
      'walking': '5506b289-3a57-4394-8eb6-2b8b3f9b1f9b'
    };
    return disciplineMap[discipline] || disciplineMap['cycling'];
  }

  // Helper: Format duration display
  formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
}

module.exports = new PelotonService();