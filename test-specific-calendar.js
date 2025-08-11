require('dotenv').config();
const { google } = require('googleapis');

async function testSpecificCalendar() {
  console.log('🎯 Testing specific calendar access\n');
  
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const serviceAccountEmail = credentials.client_email;
    const yourEmail = process.env.GOOGLE_CALENDAR_EMAIL;
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    
    console.log('🤖 Service account:', serviceAccountEmail);
    console.log('📧 Your email:', yourEmail || 'Not set in .env');
    console.log('📅 Calendar ID to test:', calendarId);
    console.log('');
    
    // Create auth and calendar
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    
    const calendar = google.calendar({ version: 'v3', auth });
    
    // Test 1: Calendar list (should show shared calendars)
    console.log('1. Checking calendar list...');
    const calList = await calendar.calendarList.list();
    console.log(`   Found ${calList.data.items.length} accessible calendars`);
    
    if (calList.data.items.length > 0) {
      calList.data.items.forEach((cal, i) => {
        console.log(`   ${i+1}. "${cal.summary}" (${cal.id})`);
        console.log(`      Access: ${cal.accessRole}, Primary: ${cal.primary || false}`);
      });
      console.log('   ✅ SUCCESS! Service account can see calendars');
    } else {
      console.log('   ❌ No calendars visible to service account');
    }
    console.log('');
    
    // Test 2: Try specific calendar ID
    if (calendarId && calendarId !== 'primary') {
      console.log(`2. Testing specific calendar: ${calendarId}`);
      try {
        const cal = await calendar.calendars.get({ calendarId });
        console.log(`   ✅ SUCCESS! Can access calendar: ${cal.data.summary}`);
        console.log(`   Time zone: ${cal.data.timeZone}`);
        
        // Test 3: Get events from this calendar
        console.log('3. Testing event retrieval...');
        const now = new Date();
        const nextWeek = new Date();
        nextWeek.setDate(now.getDate() + 7);
        
        const events = await calendar.events.list({
          calendarId,
          timeMin: now.toISOString(),
          timeMax: nextWeek.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });
        
        console.log(`   Found ${events.data.items.length} events in next 7 days`);
        
        if (events.data.items.length > 0) {
          console.log('   Events:');
          events.data.items.forEach((event, i) => {
            const start = event.start.dateTime || event.start.date;
            console.log(`   ${i+1}. "${event.summary}" - ${start}`);
          });
          console.log('   🎉 CALENDAR INTEGRATION IS WORKING!');
        } else {
          console.log('   No events found (this might be normal if you have no upcoming events)');
        }
        
      } catch (error) {
        console.log(`   ❌ Cannot access calendar ${calendarId}: ${error.message}`);
        
        if (error.message.includes('notFound')) {
          console.log('   → Calendar not found. Check the calendar ID.');
        } else if (error.message.includes('Forbidden')) {
          console.log('   → Calendar exists but access denied. Check sharing permissions.');
        }
      }
    }
    
    // Test 4: Try 'primary' if we haven't already
    if (calendarId !== 'primary') {
      console.log('\n4. Testing "primary" calendar...');
      try {
        const cal = await calendar.calendars.get({ calendarId: 'primary' });
        console.log(`   ✅ Can access primary: ${cal.data.summary}`);
      } catch (error) {
        console.log(`   ❌ Cannot access primary: ${error.message}`);
      }
    }
    
    console.log('\n📋 SUMMARY:');
    console.log('──────────────────────────────────────');
    if (calList.data.items.length > 0) {
      console.log('✅ Service account can see shared calendars');
      console.log('🚀 Your calendar integration should work now!');
      console.log('');
      console.log('Next step: Restart Donna and test:');
      console.log('   npm run dev');
      console.log('   @Donna what meetings do I have today?');
    } else {
      console.log('❌ Service account cannot see any calendars');
      console.log('');
      console.log('Double-check calendar sharing:');
      console.log('1. Go to Google Calendar web interface');
      console.log('2. Find your main calendar (left sidebar)');
      console.log('3. Click 3 dots → Settings and sharing');
      console.log('4. Under "Share with specific people"');
      console.log(`5. Make sure ${serviceAccountEmail} is listed`);
      console.log('6. Permission should be "Make changes to events"');
      console.log('7. If not listed, add it again');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testSpecificCalendar();