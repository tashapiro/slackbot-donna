// services/peloton.js - FIXED: Correct Peloton API endpoints and structure
const dataStore = require('../utils/dataStore');

class PelotonService {
  constructor() {
    this.username = process.env.PELOTON_USERNAME;
    this.password = process.env.PELOTON_PASSWORD;
    this.baseUrl = 'https://api.onepeloton.com';
    this.sessionId = null;
    this.userId = null;
    this.isConfigured = !!(this.username && this.password);
    
    if (!this.isConfigured) {
      console.warn('PELOTON_USERNAME and PELOTON_PASSWORD not configured');
    }
  }

  // Generate auth headers for authenticated requests
  getAuthHeaders() {
    if (!this.sessionId) {
      throw new Error('Not authenticated - call authenticate() first');
    }
    
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cookie': `peloton_session_id=${this.sessionId}`,
      'peloton-platform': 'web'  // Required for many endpoints
    };
  }

  // Authenticate and get session ID
  async authenticate() {
    if (!this.isConfigured) {
      throw new Error('Peloton credentials not configured');
    }

    // Check if we have a cached session that's still valid
    const cacheKey = 'peloton_session';
    const cached = dataStore.getCachedData(cacheKey, 3600000); // 1 hour cache
    if (cached && cached.sessionId && cached.userId) {
      this.sessionId = cached.sessionId;
      this.userId = cached.userId;
      console.log('Using cached Peloton session');
      return true;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          username_or_email: this.username,
          password: this.password
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Peloton login failed: ${response.status} ${errorText}`);
      }

      const authData = await response.json();
      
      if (!authData.session_id || !authData.user_id) {
        throw new Error('Peloton login response missing session_id or user_id');
      }

      this.sessionId = authData.session_id;
      this.userId = authData.user_id;

      // Cache the session
      dataStore.setCachedData(cacheKey, {
        sessionId: this.sessionId,
        userId: this.userId
      });

      console.log(`✅ Peloton authentication successful for user ${this.userId}`);
      return true;
    } catch (error) {
      console.error('Peloton authentication error:', error);
      throw error;
    }
  }

  // Search/browse classes (rides) - FIXED to use correct endpoint
  async searchClasses({
    discipline = 'cycling',
    duration = null,
    difficulty = null,
    instructor = null,
    class_type = null,
    limit = 20,
    page = 0,
    sort_by = 'original_air_time'
  } = {}) {
    await this.authenticate();

    try {
      // Build query parameters for the correct browse endpoint
      const params = new URLSearchParams({
        limit: limit.toString(),
        page: page.toString(),
        sort_by: sort_by,
        // Try to include instructor details in the response
        joins: 'instructor'
      });

      // Add filters based on parameters
      if (discipline) {
        // Map discipline to browse_category - try multiple parameter names
        const disciplineMap = {
          'cycling': 'cycling',
          'strength': 'strength',
          'yoga': 'yoga', 
          'meditation': 'meditation',
          'stretching': 'stretching',
          'running': 'running',
          'walking': 'walking',
          'cardio': 'cardio'
        };
        
        const mappedDiscipline = disciplineMap[discipline.toLowerCase()] || discipline;
        
        // Try different parameter names that Peloton might use
        params.append('browse_category', mappedDiscipline);
        params.append('fitness_discipline', mappedDiscipline);
        params.append('class_type', mappedDiscipline);
        
        console.log(`Filtering by discipline: ${discipline} -> ${mappedDiscipline}`);
      }

      if (duration) {
        // Duration filter - Peloton uses duration_range_id or class_type filtering
        // Let's try multiple approaches since the API documentation isn't clear
        if (typeof duration === 'number') {
          // Try different parameter names that Peloton might use
          const durationMinutes = duration;
          
          // Method 1: Try duration in seconds
          const durationSeconds = durationMinutes * 60;
          params.append('duration', durationSeconds.toString());
          
          // Method 2: Try duration range (common values: 1200=20min, 1800=30min, 2700=45min, 3600=60min)
          const commonDurations = {
            5: 300, 10: 600, 15: 900, 20: 1200, 25: 1500, 30: 1800, 
            35: 2100, 40: 2400, 45: 2700, 50: 3000, 60: 3600, 75: 4500, 90: 5400
          };
          
          // Find closest standard duration
          const standardDuration = Object.keys(commonDurations)
            .map(Number)
            .reduce((closest, curr) => 
              Math.abs(curr - durationMinutes) < Math.abs(closest - durationMinutes) ? curr : closest
            );
          
          const durationId = commonDurations[standardDuration];
          if (durationId) {
            params.append('duration_range_id', durationId.toString());
          }
        }
      }

      if (difficulty) {
        // Difficulty level (typically 1-10 scale or beginner/intermediate/advanced)
        if (typeof difficulty === 'string') {
          const difficultyMap = {
            'beginner': '1-3',
            'intermediate': '4-7',
            'advanced': '8-10',
            'easy': '1-4',
            'medium': '5-7',
            'hard': '8-10'
          };
          params.append('difficulty', difficultyMap[difficulty.toLowerCase()] || difficulty);
        } else {
          params.append('difficulty', difficulty.toString());
        }
      }

      if (instructor) {
        params.append('instructor_id', instructor);
      }

      if (class_type) {
        params.append('class_type_id', class_type);
      }

      // Use the correct endpoint for browsing archived classes
      const url = `${this.baseUrl}/api/v2/ride/archived?${params}`;
      console.log(`Searching Peloton classes: ${url}`);
      console.log(`Search parameters:`, Object.fromEntries(params));

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Peloton search error: ${response.status} ${errorText}`);
        throw new Error(`Peloton search error: ${response.status}`);
      }

      const data = await response.json();
      
      // The response structure includes 'data' array with class information
      let classes = data.data || [];
      console.log(`Found ${classes.length} Peloton classes from API`);
      
      // Client-side discipline filtering as backup (in case API params don't work)
      if (discipline) {
        const originalCount = classes.length;
        classes = classes.filter(cls => {
          const classDiscipline = (cls.fitness_discipline || cls.ride_type_id || '').toLowerCase();
          const targetDiscipline = discipline.toLowerCase();
          return classDiscipline.includes(targetDiscipline) || targetDiscipline.includes(classDiscipline);
        });
        console.log(`After discipline filtering (${discipline}): ${classes.length} classes (was ${originalCount})`);
      }
      
      // Client-side duration filtering as backup (since API params might not work)
      if (duration && typeof duration === 'number') {
        const targetDurationSeconds = duration * 60;
        const tolerance = 300; // 5 minutes tolerance
        
        const originalCount = classes.length;
        classes = classes.filter(cls => {
          const classDuration = cls.duration || cls.length || 0;
          const diff = Math.abs(classDuration - targetDurationSeconds);
          return diff <= tolerance;
        });
        
        console.log(`After duration filtering (${duration} min ±5): ${classes.length} classes (was ${originalCount})`);
      }
      
      // Randomize the results to avoid showing the same classes repeatedly
      if (classes.length > 0) {
        classes = this.shuffleArray([...classes]);
      }
      
      // Format classes (now async due to instructor lookups)
      const formattedClasses = [];
      for (const cls of classes) {
        const formatted = await this.formatClass(cls);
        if (formatted) {
          formattedClasses.push(formatted);
        }
      }
      
      return formattedClasses;
    } catch (error) {
      console.error('Error searching classes:', error);
      throw error;
    }
  }

  // Get user's workout history
  async getUserWorkouts({ limit = 10, page = 0 } = {}) {
    await this.authenticate();

    try {
      const params = new URLSearchParams({
        joins: 'ride,ride.instructor',
        limit: limit.toString(),
        page: page.toString(),
        sort_by: '-created'
      });

      const url = `${this.baseUrl}/api/user/${this.userId}/workouts?${params}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Peloton workout history error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      return data.data || [];
    } catch (error) {
      console.error('Error fetching workout history:', error);
      throw error;
    }
  }

  // Get user overview/stats
  async getUserOverview() {
    await this.authenticate();

    try {
      const url = `${this.baseUrl}/api/user/${this.userId}/overview`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Peloton user overview error: ${response.status} ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching user overview:', error);
      throw error;
    }
  }

  // Get workout recommendations based on user preferences and history
  async getWorkoutRecommendations({
    duration = 30,
    discipline = 'cycling',
    timeOfDay = 'anytime',
    energyLevel = 'medium',
    limit = 5
  } = {}) {
    console.log(`Getting workout recommendations for ${duration} minutes, ${energyLevel} energy, ${timeOfDay}`);

    try {
      // Map energy level to difficulty
      const difficultyMap = {
        'low': 'beginner',
        'medium': 'intermediate', 
        'high': 'advanced',
        'easy': 'beginner',
        'moderate': 'intermediate',
        'intense': 'advanced'
      };

      const difficulty = difficultyMap[energyLevel.toLowerCase()] || 'intermediate';

      // Search for classes matching criteria
      const classes = await this.searchClasses({
        discipline,
        duration,
        difficulty,
        limit,
        sort_by: 'popularity' // Get popular classes for better recommendations
      });

      if (classes.length === 0) {
        // Fallback: try broader search without difficulty filter
        console.log('No classes found, trying broader search...');
        return await this.searchClasses({
          discipline,
          duration,
          limit,
          sort_by: 'original_air_time'
        });
      }

      return classes;
    } catch (error) {
      console.error('Error getting workout recommendations:', error);
      throw error;
    }
  }

  // Get available instructors
  async getInstructors() {
    const cacheKey = 'peloton_instructors';
    const cached = dataStore.getCachedData(cacheKey, 3600000); // 1 hour cache
    if (cached) return cached;

    try {
      // This endpoint doesn't require authentication
      const response = await fetch(`${this.baseUrl}/api/instructor`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Peloton instructors error: ${response.status}`);
      }

      const data = await response.json();
      const instructors = data.data || [];
      
      dataStore.setCachedData(cacheKey, instructors);
      return instructors;
    } catch (error) {
      console.error('Error fetching instructors:', error);
      throw error;
    }
  }

  // Find instructor by name
  async findInstructor(name) {
    const instructors = await this.getInstructors();
    const searchName = name.toLowerCase().trim();
    
    return instructors.find(instructor => 
      instructor.name.toLowerCase().includes(searchName) ||
      instructor.name.toLowerCase().split(' ').some(part => part.includes(searchName))
    );
  }

  // Format class data for display
  async formatClass(cls) {
    if (!cls) return null;

    // Better instructor name extraction
    let instructorName = 'Unknown Instructor';
    if (cls.instructor?.name) {
      instructorName = cls.instructor.name;
    } else if (cls.instructor_names && cls.instructor_names.length > 0) {
      instructorName = cls.instructor_names[0];
    } else if (cls.instructor_id) {
      // Try to get instructor name from cached instructor list
      try {
        const instructors = await this.getInstructors();
        const instructor = instructors.find(inst => inst.id === cls.instructor_id);
        if (instructor?.name) {
          instructorName = instructor.name;
        }
      } catch (error) {
        console.log('Could not lookup instructor name:', error.message);
        instructorName = 'Instructor';
      }
    }

    return {
      id: cls.id,
      title: cls.title || cls.name || 'Untitled Class',
      instructor: instructorName,
      duration: this.formatDuration(cls.duration || cls.length || 0),
      discipline: cls.fitness_discipline || cls.ride_type_id || 'cycling',
      difficulty: cls.difficulty_rating_avg ? cls.difficulty_rating_avg.toFixed(1) : 'Not Rated',
      description: cls.description || '',
      rating: cls.overall_rating_avg ? cls.overall_rating_avg.toFixed(1) : 'New',
      // URL format based on the class type and ID
      url: `https://members.onepeloton.com/classes/${cls.fitness_discipline || 'cycling'}?modal=classDetailsModal&classId=${cls.id}`,
      originalAirTime: cls.original_air_time,
      classType: cls.class_type_name,
      totalRatings: cls.total_rating_count || 0,
      isLiveNow: cls.is_live_in_studio_only || false
    };
  }

  // Helper: Shuffle array for randomized results
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Helper: Format duration display
  formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  // Helper: Get discipline-specific recommendations
  getWorkoutTypeRecommendations(timeOfDay, energyLevel) {
    const recommendations = {
      morning: {
        low: ['yoga', 'stretching', 'meditation'],
        medium: ['cycling', 'strength'],
        high: ['running', 'cycling']
      },
      afternoon: {
        low: ['yoga', 'stretching'],
        medium: ['strength', 'cycling'],
        high: ['running', 'cycling', 'strength']
      },
      evening: {
        low: ['yoga', 'stretching', 'meditation'],
        medium: ['yoga', 'strength'],
        high: ['cycling', 'strength']
      },
      anytime: {
        low: ['yoga', 'stretching', 'meditation'],
        medium: ['cycling', 'strength', 'yoga'],
        high: ['cycling', 'running', 'strength']
      }
    };

    const timeKey = timeOfDay.toLowerCase();
    const energyKey = energyLevel.toLowerCase();
    
    return recommendations[timeKey]?.[energyKey] || recommendations.anytime[energyKey] || ['cycling'];
  }
}

module.exports = new PelotonService();