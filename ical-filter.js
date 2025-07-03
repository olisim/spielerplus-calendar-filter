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
      // Follow redirects and handle login-by-team page
      const response = await this.axiosInstance.get(eventUrl, {
        maxRedirects: 5,
        timeout: 30000,
        validateStatus: function (status) {
          return status >= 200 && status < 400;
        }
      });
      
      const finalUrl = response.request.res.responseUrl || eventUrl;
      
      // Handle the login-by-team countdown page
      if (finalUrl.includes('/site/login-by-team')) {
        // Update cookies from redirect
        const newCookies = response.headers['set-cookie'];
        if (newCookies) {
          const existingCookies = this.axiosInstance.defaults.headers.Cookie.split('; ');
          const updatedCookies = [...existingCookies];
          
          newCookies.forEach(cookie => {
            const cookieName = cookie.split('=')[0];
            const cookieValue = cookie.split(';')[0];
            
            const existingIndex = updatedCookies.findIndex(c => c.startsWith(cookieName + '='));
            if (existingIndex >= 0) {
              updatedCookies[existingIndex] = cookieValue;
            } else {
              updatedCookies.push(cookieValue);
            }
          });
          
          this.axiosInstance.defaults.headers.Cookie = updatedCookies.join('; ');
          
          // Try again with updated cookies
          await new Promise(resolve => setTimeout(resolve, 2000));
          const retryResponse = await this.axiosInstance.get(eventUrl);
          const $ = cheerio.load(retryResponse.data);
          const bodyText = $('body').text();
          return this.parseAttendanceFromPage($, bodyText, eventUrl);
        }
      }

      const $ = cheerio.load(response.data);
      const bodyText = $('body').text();
      
      return this.parseAttendanceFromPage($, bodyText, eventUrl);
      
    } catch (error) {
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }
  }

  parseAttendanceFromPage($, bodyText, eventUrl) {
    
    // Check for "Nicht nominiert" text
    const hasNichtNominiert = bodyText.includes('Nicht nominiert');
    if (hasNichtNominiert) {
      return {
        nominated: false,
        attending: false,
        status: 'not_nominated',
        emoji: '❌'
      };
    }

    // Look for SpielerPlus participation buttons
    const participationButtons = $('.participation-button');
    const selectedParticipationButton = participationButtons.filter('.selected');
    
    if (selectedParticipationButton.length > 0) {
      const buttonText = selectedParticipationButton.text().trim();
      
      
      // First check button value/position for attendance status
      // Button positions often correspond to: 1=Yes, 2=Maybe, 8/3=No
      if (buttonText === '1') {
        return {
          nominated: true,
          attending: true,
          status: 'attending',
          emoji: '👍'
        };
      } else if (buttonText === '8' || buttonText === '3') {
        return {
          nominated: true,
          attending: false,
          status: 'not_attending',
          emoji: '👎'
        };
      } else if (buttonText === '2') {
        return {
          nominated: true,
          attending: false,
          status: 'maybe',
          emoji: '❓'
        };
      }
      
      // If button value is unclear, check page text as fallback
      if (bodyText.includes('Absage')) {
        return {
          nominated: true,
          attending: false,
          status: 'not_attending',
          emoji: '👎'
        };
      }
      
      if (bodyText.includes('Zusage')) {
        return {
          nominated: true,
          attending: true,
          status: 'attending',
          emoji: '👍'
        };
      }
    }
    
    // Look for other attendance buttons or status indicators
    const attendanceButtons = $('button, input[type="button"], .btn');
    
    // Check if there are attendance-specific buttons
    let foundAttendanceButton = false;
    attendanceButtons.each((i, btn) => {
      const $btn = $(btn);
      const btnText = $btn.text().toLowerCase();
      const btnClass = $btn.attr('class') || '';
      const isSelected = $btn.hasClass('selected') || $btn.hasClass('active') || $btn.hasClass('primary') || btnClass.includes('selected');
      
      if (btnText.includes('zusage') || btnText.includes('absage') || btnText.includes('vielleicht') ||
          btnText.includes('teilnehmen') || btnText.includes('nicht teilnehmen')) {
        foundAttendanceButton = true;
        
        if (isSelected) {
          if (btnText.includes('zusage') || btnText.includes('teilnehmen')) {
            return {
              nominated: true,
              attending: true,
              status: 'attending',
              emoji: '👍'
            };
          } else if (btnText.includes('absage') || btnText.includes('nicht teilnehmen')) {
            return {
              nominated: true,
              attending: false,
              status: 'not_attending',
              emoji: '👎'
            };
          } else if (btnText.includes('vielleicht')) {
            return {
              nominated: true,
              attending: false,
              status: 'maybe',
              emoji: '❓'
            };
          }
        }
      }
    });

    // Look for emoji or text-based attendance indicators in the page
    if (bodyText.includes('👍') || bodyText.includes('Zusage')) {
      return {
        nominated: true,
        attending: true,
        status: 'attending',
        emoji: '👍'
      };
    }
    
    if (bodyText.includes('👎') || bodyText.includes('Absage')) {
      return {
        nominated: true,
        attending: false,
        status: 'not_attending',
        emoji: '👎'
      };
    }
    
    if (bodyText.includes('❓') || bodyText.includes('Vielleicht')) {
      return {
        nominated: true,
        attending: false,
        status: 'maybe',
        emoji: '❓'
      };
    }

    // If we found attendance buttons but none selected, default to no response
    if (foundAttendanceButton) {
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }

    // Default to attending if nominated but no specific status found
    return {
      nominated: true,
      attending: true,
      status: 'attending',
      emoji: '👍'
    };
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