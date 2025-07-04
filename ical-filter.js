const axios = require('axios');
const ical = require('node-ical');
const cheerio = require('cheerio');
const { default: icalGenerator } = require('ical-generator');
const Logger = require('./logger');

class ICalFilter {
  constructor(logger = null) {
    this.axiosInstance = null;
    this.isAuthenticated = false;
    this.authCredentials = null;
    this.logger = logger || new Logger();
  }

  async loginWithCredentials(username, password) {
    // Skip login if already authenticated with same credentials
    if (this.isAuthenticated && 
        this.authCredentials?.username === username && 
        this.authCredentials?.password === password) {
      this.logger.info('Reusing existing authentication session', { username: '***' });
      return true;
    }

    this.logger.info('Starting SpielerPlus authentication', { username: '***' });

    try {
      // Get login page and extract CSRF token
      this.logger.info('Fetching login page');
      const loginResponse = await axios.get('https://www.spielerplus.de/site/login');
      const $ = cheerio.load(loginResponse.data);
      const csrfToken = $('input[name="_csrf"]').val();
      
      if (!csrfToken) {
        this.logger.error('CSRF token not found in login page');
        throw new Error('Could not find CSRF token');
      }

      this.logger.info('CSRF token extracted successfully');

      // Extract cookies from login page
      const cookies = this.extractCookies(loginResponse.headers['set-cookie'] || []);
      this.logger.info('Login page cookies extracted', { cookieCount: (loginResponse.headers['set-cookie'] || []).length });

      // Submit login form
      const loginData = {
        'LoginForm[email]': username,
        'LoginForm[password]': password,
        '_csrf': csrfToken
      };

      this.logger.info('Submitting login form');
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

      this.logger.info('Login form submitted', { 
        statusCode: loginSubmitResponse.status,
        hasRedirect: loginSubmitResponse.status === 302
      });

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
      
      this.logger.info('Authentication successful', { username: '***' });
      return true;
    } catch (error) {
      this.logger.error('Authentication failed', { 
        username: '***',
        error: error.message,
        statusCode: error.response?.status
      });
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  extractCookies(cookieHeaders) {
    return cookieHeaders
      .map(cookie => cookie.split(';')[0])
      .join('; ');
  }

  async fetchOriginalCalendar(icalUrl, username, password) {
    const maskedUrl = this.logger.maskSensitiveData(icalUrl);
    this.logger.info('Fetching original calendar', { url: maskedUrl });
    
    try {
      const response = await axios.get(icalUrl, {
        auth: { username, password }
      });
      
      const parsedCalendar = ical.parseICS(response.data);
      const eventCount = Object.keys(parsedCalendar).filter(key => 
        parsedCalendar[key].type === 'VEVENT'
      ).length;
      
      this.logger.info('Calendar fetched and parsed successfully', {
        responseSize: response.data.length,
        totalItems: Object.keys(parsedCalendar).length,
        eventCount
      });
      
      return parsedCalendar;
    } catch (error) {
      this.logger.error('Failed to fetch calendar', {
        url: maskedUrl,
        error: error.message,
        statusCode: error.response?.status
      });
      throw new Error(`Failed to fetch calendar: ${error.message}`);
    }
  }

  async checkAttendanceStatus(eventUrl) {
    const maskedUrl = this.logger.maskSensitiveData(eventUrl);
    
    if (!this.axiosInstance || !this.isAuthenticated) {
      this.logger.warn('Attendance check skipped - not authenticated', { url: maskedUrl });
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }

    this.logger.info('Checking attendance status', { url: maskedUrl });

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
        this.logger.info('Handling login-by-team redirect page');
        
        // Update cookies from redirect
        const newCookies = response.headers['set-cookie'];
        if (newCookies) {
          this.logger.info('Updating cookies from redirect', { newCookieCount: newCookies.length });
          
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
          this.logger.info('Retrying request after cookie update');
          await new Promise(resolve => setTimeout(resolve, 2000));
          const retryResponse = await this.axiosInstance.get(eventUrl);
          const $ = cheerio.load(retryResponse.data);
          const bodyText = $('body').text();
          return this.parseAttendanceFromPage($, bodyText, eventUrl);
        }
      }

      const $ = cheerio.load(response.data);
      const bodyText = $('body').text();
      
      const attendanceStatus = this.parseAttendanceFromPage($, bodyText, eventUrl);
      
      this.logger.info('Attendance status determined', {
        url: maskedUrl,
        status: attendanceStatus.status,
        emoji: attendanceStatus.emoji,
        nominated: attendanceStatus.nominated
      });
      
      return attendanceStatus;
      
    } catch (error) {
      this.logger.error('Error checking attendance status', {
        url: maskedUrl,
        error: error.message,
        statusCode: error.response?.status
      });
      
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
    
    this.logger.info('Starting event processing with attendance checking', { 
      totalEvents: events.length 
    });
    
    // Process events sequentially to avoid overwhelming the server
    for (let i = 0; i < events.length; i++) {
      const key = events[i];
      const event = originalEvents[key];
      
      if (!event.url) {
        // No URL to check attendance, assume attending
        event.summary = `👍 ${event.summary}`;
        event.attendanceStatus = { nominated: true };
        processedEvents.push(event);
        
        this.logger.info('Event processed without URL check', {
          eventIndex: i + 1,
          totalEvents: events.length,
          eventSummary: event.summary?.substring(0, 50) + '...'
        });
        continue;
      }

      try {
        const attendanceStatus = await this.checkAttendanceStatus(event.url);
        event.summary = `${attendanceStatus.emoji} ${event.summary}`;
        event.attendanceStatus = attendanceStatus;
        processedEvents.push(event);
        
        this.logger.info('Event processed with attendance check', {
          eventIndex: i + 1,
          totalEvents: events.length,
          status: attendanceStatus.status,
          emoji: attendanceStatus.emoji
        });
        
        // Small delay to be nice to the server
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        // If attendance check fails, default to no response
        event.summary = `🤷 ${event.summary}`;
        event.attendanceStatus = { nominated: true };
        processedEvents.push(event);
        
        this.logger.warn('Event attendance check failed, using fallback', {
          eventIndex: i + 1,
          totalEvents: events.length,
          error: error.message
        });
      }
    }
    
    this.logger.info('Event processing completed', { 
      processedCount: processedEvents.length,
      originalCount: events.length
    });
    
    return processedEvents;
  }

  async filterCalendarWithBasicAuth(icalUrl, teamName, username, password, showNotNominated = false) {
    const maskedUrl = this.logger.maskSensitiveData(icalUrl);
    
    this.logger.info('Starting calendar filtering process', {
      url: maskedUrl,
      teamName,
      showNotNominated,
      username: '***'
    });
    
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
      
      this.logger.info('Events filtered and prepared for processing', {
        totalOriginalItems: Object.keys(originalEvents).length,
        validEventKeys: eventKeys.length
      });
      
      // Process events with attendance status
      const processedEvents = await this.processEventsWithAttendance(eventKeys, originalEvents);
      
      // Filter out not nominated events unless explicitly requested
      const beforeFilterCount = processedEvents.length;
      const filteredEvents = processedEvents.filter(event => {
        if (event.attendanceStatus && !event.attendanceStatus.nominated && !showNotNominated) {
          return false;
        }
        return true;
      });
      
      const filteredOutCount = beforeFilterCount - filteredEvents.length;
      if (filteredOutCount > 0) {
        this.logger.info('Non-nominated events filtered out', { 
          filteredOutCount,
          remainingEvents: filteredEvents.length
        });
      }
      
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

      const calendarString = calendar.toString();
      
      this.logger.info('Calendar filtering completed successfully', {
        finalEventCount: filteredEvents.length,
        calendarSize: calendarString.length,
        teamName
      });

      return calendarString;
    } catch (error) {
      this.logger.error('Calendar filtering failed', {
        url: maskedUrl,
        teamName,
        error: error.message,
        stack: error.stack?.split('\n')[0]
      });
      throw new Error(`Failed to filter calendar: ${error.message}`);
    }
  }
}

module.exports = ICalFilter;