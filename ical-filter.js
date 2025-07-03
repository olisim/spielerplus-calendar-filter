const axios = require('axios');
const ical = require('node-ical');
const cheerio = require('cheerio');
const { default: icalGenerator } = require('ical-generator');

class ICalFilter {
  constructor() {
    this.axiosInstance = null;
    this.isAuthenticated = false;
    this.authCredentials = null;
  }

  async loginWithCredentials(username, password) {
    // Skip login if already authenticated with same credentials
    if (this.isAuthenticated && 
        this.authCredentials?.username === username && 
        this.authCredentials?.password === password) {
      return true;
    }

    try {
      // Get login page and extract CSRF token
      const loginResponse = await axios.get('https://www.spielerplus.de/site/login');
      const $ = cheerio.load(loginResponse.data);
      const csrfToken = $('input[name="_csrf"]').val();
      
      if (!csrfToken) {
        throw new Error('Could not find CSRF token');
      }

      // Extract cookies from login page
      const cookies = this.extractCookies(loginResponse.headers['set-cookie'] || []);

      // Submit login form
      const loginData = {
        'LoginForm[email]': username,
        'LoginForm[password]': password,
        '_csrf': csrfToken
      };

      const loginSubmitResponse = await axios.post(
        'https://www.spielerplus.de/site/login',
        new URLSearchParams(loginData).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          maxRedirects: 0,
          validateStatus: status => status === 302 || status === 200
        }
      );

      // Extract all cookies from login response
      const allCookies = this.extractCookies(loginSubmitResponse.headers['set-cookie'] || []);
      
      // Create authenticated axios instance
      this.axiosInstance = axios.create({
        headers: {
          'Cookie': allCookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });

      this.isAuthenticated = true;
      this.authCredentials = { username, password };
      
      return true;
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  extractCookies(cookieHeaders) {
    return cookieHeaders
      .map(cookie => cookie.split(';')[0])
      .join('; ');
  }

  async fetchOriginalCalendar(icalUrl, username, password) {
    try {
      const response = await axios.get(icalUrl, {
        auth: { username, password }
      });
      return ical.parseICS(response.data);
    } catch (error) {
      throw new Error(`Failed to fetch calendar: ${error.message}`);
    }
  }

  async checkAttendanceStatus(eventUrl) {
    if (!this.axiosInstance || !this.isAuthenticated) {
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }

    try {
      const response = await this.axiosInstance.get(eventUrl, {
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
      });

      const $ = cheerio.load(response.data);
      
      // Check for "Nicht nominiert" text
      const bodyText = $('body').text();
      const hasNichtNominiert = bodyText.includes('Nicht nominiert');
      
      if (hasNichtNominiert) {
        return {
          nominated: false,
          attending: false,
          status: 'not_nominated',
          emoji: '❌'
        };
      }

      // Find all attendance buttons with broader selectors
      const attendanceButtons = $('button[class*="btn"], .btn, input[type="button"], [class*="participation"], [class*="attendance"], [data-value]');
      const disabledButtons = attendanceButtons.filter(':disabled, [disabled]');
      const hasSelectedButton = attendanceButtons.filter('.selected, .active, [class*="selected"], [class*="primary"]').length > 0;
      
      // Check if all buttons are disabled but there's a selection
      if (disabledButtons.length === attendanceButtons.length && !hasSelectedButton) {
        return {
          nominated: false,
          attending: false,
          status: 'not_nominated',
          emoji: '❌'
        };
      }

      // Look for specific attendance indicators
      let foundStatus = null;
      
      // Check for positive attendance (thumbs up, yes, attending)
      if (bodyText.includes('👍') || 
          $('[class*="thumbs-up"], [class*="yes"], [class*="attending"], .btn-success.selected, .btn-primary.selected').length > 0 ||
          attendanceButtons.filter('.selected, .active').text().toLowerCase().includes('zusage')) {
        foundStatus = {
          nominated: true,
          attending: true,
          status: 'attending',
          emoji: '👍'
        };
      }
      
      // Check for negative attendance (thumbs down, no, not attending)
      else if (bodyText.includes('👎') || 
               $('[class*="thumbs-down"], [class*="no"], [class*="not-attending"], .btn-danger.selected').length > 0 ||
               attendanceButtons.filter('.selected, .active').text().toLowerCase().includes('absage')) {
        foundStatus = {
          nominated: true,
          attending: false,
          status: 'not_attending',
          emoji: '👎'
        };
      }
      
      // Check for maybe/uncertain
      else if (bodyText.includes('❓') || bodyText.includes('?') ||
               $('[class*="maybe"], [class*="uncertain"], .btn-warning.selected').length > 0 ||
               attendanceButtons.filter('.selected, .active').text().toLowerCase().includes('vielleicht')) {
        foundStatus = {
          nominated: true,
          attending: false,
          status: 'maybe',
          emoji: '❓'
        };
      }

      if (foundStatus) {
        return foundStatus;
      }

      // Default fallback
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
      
    } catch (error) {
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }
  }

  createCalendarWithTimezone(teamName) {
    const calendar = icalGenerator({
      name: teamName,
      description: 'Calendar with attendance status indicators',
      prodId: {
        company: 'SpielerPlus Filter',
        product: 'Calendar Filter'
      }
    });

    // Add proper VTIMEZONE definition for Europe/Berlin
    calendar.timezone({
      name: 'Europe/Berlin',
      generator: () => [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Berlin',
        'BEGIN:DAYLIGHT',
        'DTSTART:20240703T223210',
        'TZNAME:CEST',
        'TZOFFSETTO:+0200',
        'TZOFFSETFROM:+0200',
        'END:DAYLIGHT',
        'BEGIN:STANDARD',
        'DTSTART:20241027T020000',
        'TZNAME:CET',
        'TZOFFSETTO:+0100',
        'TZOFFSETFROM:+0200',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:20250330T030000',
        'TZNAME:CEST',
        'TZOFFSETTO:+0200',
        'TZOFFSETFROM:+0100',
        'END:DAYLIGHT',
        'BEGIN:STANDARD',
        'DTSTART:20251026T020000',
        'TZNAME:CET',
        'TZOFFSETTO:+0100',
        'TZOFFSETFROM:+0200',
        'END:STANDARD',
        'END:VTIMEZONE'
      ].join('\r\n')
    });

    return calendar;
  }

  createLocalDateFromOriginal(originalDate) {
    // Create a new Date object with the same local time components
    // This prevents timezone conversion issues
    return new Date(
      originalDate.getFullYear(),
      originalDate.getMonth(),
      originalDate.getDate(),
      originalDate.getHours(),
      originalDate.getMinutes(),
      originalDate.getSeconds()
    );
  }

  async processEventsWithAttendance(events, originalEvents) {
    const processedEvents = [];
    
    // Process events sequentially to avoid overwhelming the server
    for (const key of events) {
      const event = originalEvents[key];
      
      if (!event.url) {
        // No URL to check attendance, assume attending
        event.summary = `👍 ${event.summary}`;
        event.attendanceStatus = { nominated: true };
        processedEvents.push(event);
        continue;
      }

      try {
        const attendanceStatus = await this.checkAttendanceStatus(event.url);
        event.summary = `${attendanceStatus.emoji} ${event.summary}`;
        event.attendanceStatus = attendanceStatus;
        processedEvents.push(event);
        
        // Small delay to be nice to the server
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // If attendance check fails, default to no response
        event.summary = `🤷 ${event.summary}`;
        event.attendanceStatus = { nominated: true };
        processedEvents.push(event);
      }
    }
    
    return processedEvents;
  }

  async filterCalendarWithBasicAuth(icalUrl, teamName, username, password, showNotNominated = false) {
    try {
      // Authenticate with SpielerPlus
      await this.loginWithCredentials(username, password);
      
      // Fetch and parse original calendar
      const originalEvents = await this.fetchOriginalCalendar(icalUrl, username, password);
      
      // Filter out absence events and get only VEVENTs
      const eventKeys = Object.keys(originalEvents).filter(key => {
        const event = originalEvents[key];
        return event.type === 'VEVENT' && !event.uid.includes('absence');
      });
      
      // Process events with attendance status
      const processedEvents = await this.processEventsWithAttendance(eventKeys, originalEvents);
      
      // Filter out not nominated events unless explicitly requested
      const filteredEvents = processedEvents.filter(event => {
        if (event.attendanceStatus && !event.attendanceStatus.nominated && !showNotNominated) {
          return false;
        }
        return true;
      });
      
      // Create calendar with proper timezone
      const calendar = this.createCalendarWithTimezone(teamName);
      
      // Add events to calendar
      filteredEvents.forEach(event => {
        calendar.createEvent({
          id: event.uid,
          summary: event.summary,
          description: event.description,
          start: this.createLocalDateFromOriginal(event.start),
          end: this.createLocalDateFromOriginal(event.end),
          location: event.location,
          url: event.url,
          status: event.status,
          sequence: Math.floor(Date.now() / 1000)
        });
      });

      return calendar.toString();
    } catch (error) {
      throw new Error(`Failed to filter calendar: ${error.message}`);
    }
  }
}

module.exports = ICalFilter;