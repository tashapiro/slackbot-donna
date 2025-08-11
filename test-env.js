require('dotenv').config();
const { google } = require('googleapis');

async function simpleTest() {
  console.log('🧪 Simple Google Calendar test...\n');
  
  try {
    // Step 1: Parse credentials
    console.log('1. Testing credentials...');
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log('   ✅ Credentials parsed successfully');
    console.log('   🤖 Service account email:', credentials.client_email);
    console.log('   📋 Project ID:', credentials.project_id);
    console.log('');
    
    // Step 2: Create auth
    console.log('2. Creating authentication...');
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
      ]
    });
    console.log('   ✅ Auth created');
    
    // Step 3: Create calendar client
    console.log('3. Creating calendar client...');
    const calendar = google.calendar({ version: 'v3', auth });
    console.log('   ✅ Calendar client created');
    console.log('');
    
    // Step 4: List all accessible calendars
    console.log('4. Checking accessible calendars...');
    const response = await calendar.calendarList.list();
    console.log('   ✅ API call successful');
    console.log(`   📅 Found ${response.data.items.length} accessible calendars:`);
    
    if (response.data.items.length === 0) {
      console.log('   ❌ NO CALENDARS ACCESSIBLE');
      console.log('   This means the service account cannot see any calendars.');
      console.log('   You need to share your calendar with:', credentials.client_email);
    } else {
      response.data.items.forEach((cal, index) => {
        console.log(`   ${index + 1}. "${cal.summary}" (ID: ${cal.id})`);
        console.log(`      Access role: ${cal.accessRole}`);
        console.log(`      Primary: ${cal.primary || false}`);
      });
    }
    console.log('');
    
    // Step 5: Test primary calendar specifically
    console.log('5. Testing primary calendar access...');
    try {
      const primaryCal = await calendar.calendars.get({
        calendarId: 'primary'
      });
      console.log('   ✅ Can access primary calendar:', primaryCal.data.summary);
      console.log('   📧 Primary calendar ID:', primaryCal.data.id);
      console.log('   🕐 Time zone:', primaryCal.data.timeZone);
    } catch (error) {
      console.log('   ❌ Cannot access primary calendar:', error.message);
      console.log('   This is expected if no calendar is shared with the service account.');
    }
    console.log('');
    
    // Step 6: Test getting events (if we have access)
    if (response.data.items.length > 0) {
      console.log('6. Testing event retrieval...');
      const calendarId = response.data.items[0].id;
      console.log(`   Using calendar: ${response.data.items[0].summary}`);
      
      try {
        const now = new Date();
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(23, 59, 59, 999);
        
        const events = await calendar.events.list({
          calendarId: calendarId,
          timeMin: now.toISOString(),
          timeMax: tomorrow.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        
        console.log(`   ✅ Found ${events.data.items.length} events in next day`);
        
        if (events.data.items.length > 0) {
          console.log('   Sample events:');
          events.data.items.slice(0, 3).forEach((event, index) => {
            const start = event.start.dateTime || event.start.date;
            console.log(`   ${index + 1}. "${event.summary}" - ${start}`);
          });
        }
      } catch (error) {
        console.log(`   ❌ Cannot retrieve events: ${error.message}`);
      }
    }
    
    console.log('\n🎯 SUMMARY:');
    console.log('────────────────────────────────────────');
    console.log(`📧 Service account email: ${credentials.client_email}`);
    console.log(`📅 Accessible calendars: ${response.data.items.length}`);
    
    if (response.data.items.length === 0) {
      console.log('\n❗ NEXT STEPS:');
      console.log('1. Go to https://calendar.google.com');
      console.log('2. Find your main calendar in the left sidebar');
      console.log('3. Click the three dots (⋮) next to your calendar');
      console.log('4. Select "Settings and sharing"');
      console.log('5. Scroll to "Share with specific people"');
      console.log('6. Click "Add people"');
      console.log(`7. Add this email: ${credentials.client_email}`);
      console.log('8. Set permission to "Make changes to events"');
      console.log('9. Click "Send"');
      console.log('10. Run this test again in a few minutes');
    } else {
      console.log('✅ Calendar sharing is working!');
      console.log('🚀 Donna should be able to access your calendar now.');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    
    if (error.message.includes('JSON')) {
      console.log('\n🔧 JSON Error - Check your .env file:');
      console.log('Make sure GOOGLE_SERVICE_ACCOUNT_JSON is properly formatted');
    } else if (error.code === 'ENOTFOUND') {
      console.log('\n🔧 Network Error - Check your internet connection');
    } else {
      console.log('\n🔧 Error details:', error);
    }
  }
}

simpleTest();