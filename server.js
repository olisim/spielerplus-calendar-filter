const express = require('express');
const cors = require('cors');
require('dotenv').config();

const ICalFilter = require('./ical-filter');

const app = express();
const PORT = process.env.PORT || 3000;

// Store filter instances per user to reuse authenticated sessions
const filterInstances = new Map();

app.use(cors());

// Helper function to parse HTTP Basic Auth
function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }
  
  const base64Credentials = authHeader.slice('Basic '.length);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');
  
  return { username, password };
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>SpielerPlus Calendar Filter</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .info-box { background: #f0f8ff; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
            .calendar-url { background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; }
            .step { margin-bottom: 15px; }
            .emoji { font-size: 1.2em; }
        </style>
    </head>
    <body>
        <h1>SpielerPlus Calendar Filter</h1>
        <p>Get your personalized team calendar with attendance status emojis!</p>
        
        <div class="info-box">
            <h3>📅 Calendar URL format:</h3>
            <div class="calendar-url">
                http://localhost:${PORT}/calendar/ICAL_TOKEN?u=USER_ID&name=TEAM_NAME
            </div>
        </div>
        
        <h3>🔧 Setup Instructions:</h3>
        
        <div class="step">
            <strong>1. Get your iCal URL:</strong> From your existing SpielerPlus calendar URL 
            <code>https://www.spielerplus.de/events/ics?t=TOKEN&u=USER_ID</code>, 
            copy both the <strong>TOKEN</strong> (after <code>t=</code>) and <strong>USER_ID</strong> (after <code>u=</code>)
        </div>
        
        <div class="step">
            <strong>2. Replace ICAL_TOKEN:</strong> Use the token from step 1
        </div>
        
        <div class="step">
            <strong>3. Replace USER_ID:</strong> Use the user ID from step 1
        </div>
        
        <div class="step">
            <strong>4. Replace TEAM_NAME:</strong> Choose a name for your calendar (optional)
        </div>
        
        <div class="step">
            <strong>5. Add to your calendar app:</strong>
            <ul>
                <li>Copy the URL with your token, user ID, and team name</li>
                <li>Add as "Calendar Subscription" or "Internet Calendar"</li>
                <li>When prompted for credentials, use your <strong>SpielerPlus username and password</strong></li>
            </ul>
        </div>
        
        <h3>📱 Calendar App Instructions:</h3>
        <ul>
            <li><strong>iOS Calendar:</strong> Settings → Accounts → Add Account → Other → Add Subscribed Calendar</li>
            <li><strong>Google Calendar:</strong> Settings → Add calendar → From URL → Enable authentication</li>
            <li><strong>Outlook:</strong> Add calendar → Subscribe from web → Enter URL and credentials</li>
            <li><strong>Apple Calendar (Mac):</strong> File → New Calendar Subscription</li>
        </ul>
        
        <h3>😊 Emoji Meanings:</h3>
        <ul>
            <li><span class="emoji">👍</span> You're attending</li>
            <li><span class="emoji">👎</span> You're not attending</li>
            <li><span class="emoji">❓</span> You marked "maybe"</li>
            <li><span class="emoji">🤷</span> You haven't responded yet</li>
            <li><span class="emoji">❌</span> You're not nominated</li>
        </ul>
        
        <h3>📝 Example:</h3>
        <p>If your SpielerPlus iCal URL is:<br>
        <code>https://www.spielerplus.de/events/ics?t=YOUR_ICAL_TOKEN&u=YOUR_USER_ID</code></p>
        <p>Your filtered calendar URL would be:</p>
        <div class="calendar-url">
            http://localhost:${PORT}/calendar/YOUR_ICAL_TOKEN?u=YOUR_USER_ID&name=YOUR_TEAM_NAME
        </div>
    </body>
    </html>
  `);
});

app.get('/calendar/:icalToken', async (req, res) => {
  try {
    // Check for HTTP Basic Authentication
    const authHeader = req.headers.authorization;
    const credentials = parseBasicAuth(authHeader);
    
    if (!credentials) {
      res.set('WWW-Authenticate', 'Basic realm="SpielerPlus Calendar Filter"');
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please provide your SpielerPlus username and password'
      });
    }

    const { icalToken } = req.params;
    const teamName = req.query.name || 'Team Calendar';
    const userParam = req.query.u; // Get user parameter from URL query
    const showNotNominated = req.query.showNotNominated === 'true'; // Get showNotNominated parameter
    
    if (!userParam) {
      return res.status(400).json({
        error: 'Missing user parameter',
        message: 'Please include the user parameter: ?u=YOUR_USER_ID&name=TEAM_NAME&showNotNominated=true (optional)'
      });
    }
    
    const originalIcalUrl = `https://www.spielerplus.de/events/ics?t=${icalToken}&u=${userParam}`;
    
    // Create or reuse filter instance for this user
    const userKey = `${credentials.username}:${icalToken}`;
    let filter = filterInstances.get(userKey);
    
    if (!filter) {
      filter = new ICalFilter();
      filterInstances.set(userKey, filter);
    }
    
    // Use HTTP Basic Auth approach instead of session login
    const filteredIcal = await filter.filterCalendarWithBasicAuth(originalIcalUrl, teamName, credentials.username, credentials.password, showNotNominated);
    
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="filtered-calendar.ics"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Last-Modified': new Date().toUTCString(),
      'ETag': `"${Date.now()}-${Math.random()}"`,
      'Vary': 'Authorization',
      'X-Accel-Expires': '0'
    });
    
    res.send(filteredIcal);
  } catch (error) {
    console.error('Calendar error:', error.message);
    
    if (error.message.includes('authentication') || error.message.includes('login')) {
      res.set('WWW-Authenticate', 'Basic realm="SpielerPlus Calendar Filter"');
      return res.status(401).json({ 
        error: 'Authentication failed',
        message: 'Invalid SpielerPlus username or password'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to generate calendar',
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`SpielerPlus Calendar Filter running on port ${PORT}`);
  console.log(`Setup page: http://localhost:${PORT}`);
  console.log(`Calendar URL format: http://localhost:${PORT}/calendar/ICAL_TOKEN?u=USER_ID&name=TEAM_NAME&showNotNominated=true`);
  console.log(`Users authenticate with their SpielerPlus credentials via HTTP Basic Auth`);
  console.log(`Example: http://localhost:${PORT}/calendar/YOUR_ICAL_TOKEN?u=YOUR_USER_ID&name=YOUR_TEAM_NAME&showNotNominated=true`);
});