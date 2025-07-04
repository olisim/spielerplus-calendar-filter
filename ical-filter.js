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
    // Check for "Nicht nominiert" (not nominated) text
    const nichtNominiertText = $('.deactivated b:contains("Nicht nominiert"), b:contains("Nicht nominiert")');
    const hasNichtNominiert = nichtNominiertText.length > 0;
    
    if (hasNichtNominiert) {
      return {
        nominated: false,
        attending: false,
        status: 'not_nominated',
        emoji: '❌'
      };
    }

    // Look for participation buttons
    const attendanceButtons = $('.participation-button');
    
    if (attendanceButtons.length > 0) {
      // Check if buttons are disabled (indicates not nominated)
      const disabledButtons = attendanceButtons.filter('[disabled]');
      const hasSelectedButton = attendanceButtons.filter('.selected').length > 0;
      
      // Only mark as "not nominated" if explicit "Nicht nominiert" text is found
      // OR if all buttons are disabled AND no selection has been made
      if (hasNichtNominiert || (disabledButtons.length === attendanceButtons.length && !hasSelectedButton)) {
        return {
          nominated: false,
          attending: false,
          status: 'not_nominated',
          emoji: '❌'
        };
      }
      
      // Detect specific participation status using title attributes - this is the key fix!
      const selectedConfirm = $('.participation-button.selected[title="Zugesagt"]');
      const selectedDecline = $('.participation-button.selected[title="Absagen / Abwesend"]');
      const selectedMaybe = $('.participation-button.selected[title="Unsicher"]');
      
      if (attendanceButtons.length > 0) {
        if (selectedConfirm.length > 0) {
          return {
            nominated: true,
            attending: true,
            status: 'attending',
            emoji: '👍'
          };
        } else if (selectedDecline.length > 0) {
          return {
            nominated: true,
            attending: false,
            status: 'not_attending',
            emoji: '👎'
          };
        } else if (selectedMaybe.length > 0) {
          return {
            nominated: true,
            attending: false,
            status: 'maybe',
            emoji: '❓'
          };
        } else {
          return {
            nominated: true,
            attending: false,
            status: 'no_response',
            emoji: '🤷'
          };
        }
      }
    } else {
      // No participation buttons found - check if user is not nominated for this event
      // Analyze page content for participation status since API endpoints don't exist
      const pageHtml = $.html();
      
      // Check for specific decline patterns first
      if (bodyText.includes('abgesagt') || bodyText.includes('absage') || 
          bodyText.includes('nicht teilnehmen') || bodyText.includes('abwesend')) {
        return {
          nominated: true,
          attending: false,
          status: 'not_attending',
          emoji: '👎'
        };
      }
      
      // Check for data attributes, JavaScript variables, or hidden form data
      const scriptMatches = pageHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
      let foundStatusInScript = false;
      
      for (const script of scriptMatches) {
        const scriptContent = script.replace(/<\/?script[^>]*>/gi, '');
        
        // Look for specific participation status data in JavaScript (not generic keywords)
        const hasParticipationData = scriptContent.includes('participation-button') || 
                                   scriptContent.includes('showParticipationForm') ||
                                   scriptContent.match(/participation.*:.*["\']?(zugesagt|abgesagt|unsicher)["\']?/i);
        
        if (hasParticipationData) {
          // Look for specific status patterns - only if they're clearly related to user status
          if (scriptContent.match(/user.*abgesagt|participation.*abgesagt|status.*abgesagt/i)) {
            foundStatusInScript = true;
            return {
              nominated: true,
              attending: false,
              status: 'not_attending',
              emoji: '👎'
            };
          } else if (scriptContent.match(/user.*zugesagt|participation.*zugesagt|status.*zugesagt/i)) {
            foundStatusInScript = true;
            return {
              nominated: true,
              attending: true,
              status: 'attending',
              emoji: '👍'
            };
          }
        }
      }
      
      // Only check for explicit participation indicators, don't default to attending
      if (bodyText.includes('zugesagt') || bodyText.includes('teilnehmen')) {
        return {
          nominated: true,
          attending: true,
          status: 'attending',
          emoji: '👍'
        };
      } else if (bodyText.includes('unsicher') || bodyText.includes('vielleicht')) {
        return {
          nominated: true,
          attending: false,
          status: 'maybe',
          emoji: '❓'
        };
      } else {
        // No participation buttons and no clear indicators - user likely not nominated
        return {
          nominated: false,
          attending: false,
          status: 'not_nominated',
          emoji: '❌'
        };
      }
    }

    // Default fallback - should not reach here
    return {
      nominated: true,
      attending: false,
      status: 'no_response',
      emoji: '🤷'
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