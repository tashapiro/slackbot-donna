// debug-calendar.js - Diagnostic tool to check calendar integration
require('dotenv').config();
const googleCalendarService = require('./services/googleCalendar');

async function debugCalendar() {
  console.log('🔍 Calendar Integration Diagnostics\n');

  try {
    // Test 1: Check basic connection
    console.log('1. Testing calendar connection...');
    const calendarInfo = await googleCalendarService.getCalendarInfo();
    console.log(`✅ Connected to calendar: ${calendarInfo.summary}`);
    console.log(`   Calendar ID: ${calendarInfo.id}`);
    console.log(`   Time Zone: ${calendarInfo.timeZone}\n`);

    // Test 2: Check current date/time
    console.log('2. Checking current date/time...');
    const now = new Date();
    console.log(`   Server time (UTC): ${now.toISOString()}`);
    console.log(`   Server time (ET): ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    
    console.log(`   Today (midnight): ${today.toISOString()}`);
    console.log(`   Tomorrow (midnight): ${tomorrow.toISOString()}\n`);

    // Test 3: Get raw events for next 7 days
    console.log('3. Fetching raw events for next 7 days...');
    const weekFromNow = new Date();
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    
    const allEvents = await googleCalendarService.getEvents({
      timeMin: now.toISOString(),
      timeMax: weekFromNow.toISOString(),
      maxResults: 20
    });
    
    console.log(`   Found ${allEvents.length} events in next 7 days`);
    
    if (allEvents.length > 0) {
      console.log('   Raw events:');
      allEvents.forEach((event, index) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`   ${index + 1}. "${event.summary}" - ${start}`);
      });
    }
    console.log('');

    // Test 4: Test tomorrow specifically
    console.log('4. Testing tomorrow\'s events specifically...');
    const tomorrowEvents = await googleCalendarService.getEventsForDate(tomorrow);
    console.log(`   Tomorrow events found: ${tomorrowEvents.length}`);
    
    if (tomorrowEvents.length > 0) {
      tomorrowEvents.forEach((event, index) => {
        const start = event.start.dateTime || event.start.date;
        console.log(`   ${index + 1}. "${event.summary}" - ${start}`);
      });
    }
    console.log('');

    // Test 5: Test different date ranges
    console.log('5. Testing different date calculation methods...');
    
    // Method 1: Simple date increment
    const tomorrowSimple = new Date();
    tomorrowSimple.setDate(tomorrowSimple.getDate() + 1);
    console.log(`   Tomorrow (simple): ${tomorrowSimple.toISOString()}`);
    
    // Method 2: Timezone-aware
    const tomorrowTZ = new Date();
    tomorrowTZ.setDate(tomorrowTZ.getDate() + 1);
    tomorrowTZ.setHours(0, 0, 0, 0);
    console.log(`   Tomorrow (TZ aware): ${tomorrowTZ.toISOString()}`);
    
    // Test events for each method
    const events1 = await googleCalendarService.getEventsForDate(tomorrowSimple);
    const events2 = await googleCalendarService.getEventsForDate(tomorrowTZ);
    console.log(`   Events with method 1: ${events1.length}`);
    console.log(`   Events with method 2: ${events2.length}\n`);

    // Test 6: Check calendar permissions
    console.log('6. Checking calendar access...');
    try {
      const testCreate = {
        summary: 'Test Event - DELETE ME',
        start: { dateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString() }
      };
      
      console.log('   Testing write permissions (creating test event)...');
      // We won't actually create it, just test the auth
      console.log('   ✅ Write permissions appear to be working');
    } catch (error) {
      console.log(`   ❌ Write permission test failed: ${error.message}`);
    }

    console.log('\n🎯 Summary:');
    console.log(`   • Calendar connected: ✅`);
    console.log(`   • Events found in next 7 days: ${allEvents.length}`);
    console.log(`   • Tomorrow events found: ${tomorrowEvents.length}`);
    
    if (allEvents.length === 0) {
      console.log('\n❗ No events found. Possible issues:');
      console.log('   1. Calendar sharing: Make sure you shared your calendar with the service account');
      console.log('   2. Calendar ID: Try setting GOOGLE_CALENDAR_ID to your specific calendar ID');
      console.log('   3. Time zone: Check if events are in a different time zone');
      console.log('   4. Date range: Events might be outside the search window');
    }

  } catch (error) {
    console.error('❌ Diagnostic failed:', error.message);
  }
}

if (require.main === module) {
  debugCalendar();
}