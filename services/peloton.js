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
        // Only include difficulty if specifically requested - simplified approach
        if (typeof difficulty === 'string') {
          const difficultyMap = {
            'beginner': '1-3',
            'easy': '1-4', 
            'intermediate': '4-7',
            'medium': '4-7',
            'advanced': '8-10',
            'hard': '8-10'
          };
          const mappedDifficulty = difficultyMap[difficulty.toLowerCase()];
          if (mappedDifficulty) {
            params.append('difficulty', mappedDifficulty);
          }
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
    duration = null,
    discipline = null,
    instructor = null,
    limit = 5
  } = {}) {
    console.log(`Getting workout recommendations: ${duration ? duration + ' min' : 'any duration'}, ${discipline || 'any discipline'}, ${instructor || 'any instructor'}`);

    try {
      // Use randomized sort order for variety
      const sortOptions = ['original_air_time', 'popularity', 'difficulty_rating_avg', 'overall_rating_avg'];
      const randomSort = sortOptions[Math.floor(Math.random() * sortOptions.length)];
      
      console.log(`Using random sort order: ${randomSort}`);

      // Search for classes matching criteria
      const classes = await this.searchClasses({
        discipline,
        duration,
        instructor,
        limit: limit * 2, // Get more results to have better randomization
        sort_by: randomSort
      });

      if (classes.length === 0 && (duration || discipline || instructor)) {
        // Fallback: try broader search by removing most restrictive filter
        console.log('No exact matches found, trying broader search...');
        
        if (instructor) {
          // Try without instructor filter first
          return await this.searchClasses({
            discipline,
            duration,
            limit,
            sort_by: 'popularity' // Use popularity for fallback
          });
        } else if (duration && discipline) {
          // Try without duration filter
          return await this.searchClasses({
            discipline,
            limit,
            sort_by: 'popularity'
          });
        } else if (discipline) {
          // Try popular classes from any discipline
          return await this.searchClasses({
            limit,
            sort_by: 'popularity'
          });
        }
      }

      // Return only the requested number after randomization
      return classes.slice(0, limit);
    } catch (error) {
      console.error('Error getting workout recommendations:', error);
      throw error;
    }
  }

  // Get available instructors
  async getInstructors() {
    const cacheKey = 'peloton_instructors';
    const cached = dataStore.getCachedData(cacheKey, 3600000); // 1 hour cache
    if (cached) {
      console.log(`Using cached instructors (${cached.length} total)`);
      return cached;
    }

    try {
      // Fetch ALL instructors with increased limit
      const response = await fetch(`${this.baseUrl}/api/instructor?limit=100`, {
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
      
      console.log(`Fetched ${instructors.length} instructors from API (with limit=100)`);
      
      // Debug: log first few instructor names
      if (instructors.length > 0) {
        console.log(`Sample instructors: ${instructors.slice(0, 10).map(i => i.name).join(', ')}`);
        
        // Check if we got the popular ones
        const codysFound = instructors.filter(i => i.name.toLowerCase().includes('cody'));
        const mattsFound = instructors.filter(i => i.name.toLowerCase().includes('matt'));
        
        if (codysFound.length > 0) {
          console.log(`Found Cody instructors: ${codysFound.map(i => i.name).join(', ')}`);
        }
        if (mattsFound.length > 0) {
          console.log(`Found Matt instructors: ${mattsFound.map(i => i.name).join(', ')}`);
        }
      }
      
      dataStore.setCachedData(cacheKey, instructors);
      return instructors;
    } catch (error) {
      console.error('Error fetching instructors:', error);
      throw error;
    }
  }

  // Find instructor by name (improved with better matching)
  async findInstructor(name) {
    const instructors = await this.getInstructors();
    const searchName = name.toLowerCase().trim();
    
    console.log(`Searching for instructor: "${name}"`);
    console.log(`Available instructors: ${instructors.slice(0, 5).map(i => i.name).join(', ')}...`);
    
    // Try exact match first
    let instructor = instructors.find(instructor => 
      instructor.name.toLowerCase() === searchName
    );
    
    if (instructor) {
      console.log(`Found exact match: ${instructor.name}`);
      return instructor;
    }
    
    // Try partial match (contains)
    instructor = instructors.find(instructor => 
      instructor.name.toLowerCase().includes(searchName) ||
      searchName.includes(instructor.name.toLowerCase())
    );
    
    if (instructor) {
      console.log(`Found partial match: ${instructor.name}`);
      return instructor;
    }
    
    // Try matching individual words (for "Matt Wilpers" vs "Matthew Wilpers")
    const searchWords = searchName.split(' ');
    instructor = instructors.find(instructor => {
      const instructorWords = instructor.name.toLowerCase().split(' ');
      return searchWords.every(word => 
        instructorWords.some(iWord => iWord.includes(word) || word.includes(iWord))
      );
    });
    
    if (instructor) {
      console.log(`Found word match: ${instructor.name}`);
      return instructor;
    }
    
    console.log(`No instructor found for: "${name}"`);
    return null;
  }

  // Format class data for display
  async formatClass(cls) {
    if (!cls) return null;

    // Better instructor name extraction with multiple fallback strategies
    let instructorName = 'Unknown Instructor';
    
    // Strategy 1: Direct instructor object
    if (cls.instructor?.name) {
      instructorName = cls.instructor.name;
      console.log(`Found instructor via cls.instructor.name: ${instructorName}`);
    }
    // Strategy 2: Instructor names array
    else if (cls.instructor_names && cls.instructor_names.length > 0) {
      instructorName = cls.instructor_names[0];
      console.log(`Found instructor via cls.instructor_names: ${instructorName}`);
    }
    // Strategy 3: Single instructor name field
    else if (cls.instructor_name) {
      instructorName = cls.instructor_name;
      console.log(`Found instructor via cls.instructor_name: ${instructorName}`);
    }
    // Strategy 4: Lookup by instructor_id
    else if (cls.instructor_id) {
      try {
        const instructors = await this.getInstructors();
        const instructor = instructors.find(inst => inst.id === cls.instructor_id);
        if (instructor?.name) {
          instructorName = instructor.name;
          console.log(`Found instructor via ID lookup: ${instructorName}`);
        } else {
          console.log(`Instructor ID ${cls.instructor_id} not found in instructor list`);
        }
      } catch (error) {
        console.log('Could not lookup instructor by ID:', error.message);
      }
    }
    // Strategy 5: Check for any field that might contain instructor info
    else {
      // Debug: log the structure to see what fields are available
      console.log(`Class structure for debugging:`, {
        id: cls.id,
        title: cls.title || cls.name,
        instructorFields: {
          instructor: cls.instructor,
          instructor_id: cls.instructor_id,
          instructor_name: cls.instructor_name,
          instructor_names: cls.instructor_names
        }
      });
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
}

module.exports = new PelotonService();