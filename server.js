const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Set timezone to Europe/Berlin to match SpielerPlus
process.env.TZ = 'Europe/Berlin';

const ICalFilter = require('./ical-filter');

const app = express();
const PORT = process.env.PORT || 3000;

// Store filter instances per user to reuse authenticated sessions
const filterInstances = new Map();

app.use(cors());

function parseBasicAuth(authHeader) {
  if (!authHeader?.startsWith('Basic ')) {
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
                http://localhost:${PORT}/calendar/ICAL_TOKEN?u=USER_ID&name=TEAM_NAME&showNotNominated=true
            </div>
        </div>
        
        <h3>🔧 Setup Instructions:</h3>
        
        <div class="step">
            <strong>1. Get your iCal URL:</strong> From your SpielerPlus calendar subscription URL, 
            copy both the <strong>TOKEN</strong> (after <code>t=</code>) and <strong>USER_ID</strong> (after <code>u=</code>)
        </div>
        
        <div class="step">
            <strong>2. Create your filtered URL:</strong> Replace ICAL_TOKEN and USER_ID with your values
        </div>
        
        <div class="step">
            <strong>3. Add to calendar app:</strong> Use your <strong>SpielerPlus username and password</strong> when prompted for authentication
        </div>
        
        <h3>😊 Emoji Meanings:</h3>
        <ul>
            <li><span class="emoji">👍</span> You're attending</li>
            <li><span class="emoji">👎</span> You're not attending</li>
            <li><span class="emoji">❓</span> You marked "maybe"</li>
            <li><span class="emoji">🤷</span> You haven't responded yet</li>
            <li><span class="emoji">❌</span> You're not nominated</li>
        </ul>
        
        <h3>📝 Parameters:</h3>
        <ul>
            <li><strong>showNotNominated=true</strong> - Include events where you're not nominated (default: false)</li>
            <li><strong>name=TEAM_NAME</strong> - Custom calendar name (optional)</li>
        </ul>
    </body>
    </html>
  `);
});

app.get('/calendar/:icalToken', async (req, res) => {
  try {
    // Parse and validate authentication
    const credentials = parseBasicAuth(req.headers.authorization);
    if (!credentials) {
      res.set('WWW-Authenticate', 'Basic realm="SpielerPlus Calendar Filter"');
      return res.status(401).json({ 
        error: 'Authentication required',
        message: 'Please provide your SpielerPlus username and password'
      });
    }

    // Extract and validate parameters
    const { icalToken } = req.params;
    const userParam = req.query.u;
    const teamName = req.query.name || 'Team Calendar';
    const showNotNominated = req.query.showNotNominated === 'true';
    
    if (!userParam) {
      return res.status(400).json({
        error: 'Missing user parameter',
        message: 'Please include the user parameter: ?u=YOUR_USER_ID'
      });
    }
    
    // Build original iCal URL
    const originalIcalUrl = `https://www.spielerplus.de/events/ics?t=${icalToken}&u=${userParam}`;
    
    // Get or create filter instance for this user
    const userKey = `${credentials.username}:${icalToken}`;
    let filter = filterInstances.get(userKey);
    
    if (!filter) {
      filter = new ICalFilter();
      filterInstances.set(userKey, filter);
    }
    
    // Generate filtered calendar
    const filteredIcal = await filter.filterCalendarWithBasicAuth(
      originalIcalUrl, 
      teamName, 
      credentials.username, 
      credentials.password, 
      showNotNominated
    );
    
    // Set response headers for calendar download
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="filtered-calendar.ics"',
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
    console.error('Calendar generation error:', error.message);
    
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
});