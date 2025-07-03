const axios = require('axios');
const ical = require('node-ical');
const cheerio = require('cheerio');
const { default: icalGenerator } = require('ical-generator');

class ICalFilter {
  constructor(identityCookie = null) {
    this.identityCookie = identityCookie;
    this.axiosInstance = null;
    this.isAuthenticated = false;
    this.authCredentials = null;
    
    if (identityCookie) {
      this.axiosInstance = axios.create({
        headers: {
          'Cookie': `_identity=${identityCookie}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      this.isAuthenticated = true;
    }
  }

  async loginWithCredentials(username, password) {
    // Check if already authenticated with these credentials
    if (this.isAuthenticated && this.authCredentials && 
        this.authCredentials.username === username && 
        this.authCredentials.password === password) {
      console.log(`Already authenticated for user: ${username}`);
      return this.identityCookie;
    }
    
    try {
      console.log(`Attempting login for user: ${username}`);
      
      // Create a session for login with cookie jar
      const loginInstance = axios.create({
        timeout: 10000,
        maxRedirects: 5,
        withCredentials: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      // First, get the login page to extract any CSRF tokens
      console.log('Fetching login page...');
      const loginPageResponse = await loginInstance.get('https://www.spielerplus.de/site/login', {
        headers: {
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      
      // Extract cookies from the login page response
      const loginPageCookies = loginPageResponse.headers['set-cookie'];
      console.log('Login page cookies:', loginPageCookies);
      
      // Check if we're already on a different page (redirect)
      if (loginPageResponse.request.res.responseUrl !== 'https://www.spielerplus.de/site/login') {
        console.log('Redirected to:', loginPageResponse.request.res.responseUrl);
      }
      
      // Extract CSRF token and form fields
      const loginPageHtml = loginPageResponse.data;
      console.log('Login page loaded, looking for form fields...');
      
      // Debug: Show the actual login form HTML
      const formMatch = loginPageHtml.match(/<form[^>]*>[\s\S]*?<\/form>/i);
      if (formMatch) {
        console.log('Login form HTML structure:');
        console.log(formMatch[0].substring(0, 800) + '...');
      }
      
      // Look for various token patterns with more comprehensive search
      const csrfMatch = loginPageHtml.match(/name="_csrf"[^>]*value="([^"]*)"/) || 
                       loginPageHtml.match(/name="_token"[^>]*value="([^"]*)"/) || 
                       loginPageHtml.match(/name="csrf-token"[^>]*content="([^"]*)"/) ||
                       loginPageHtml.match(/_token['"]\s*:\s*['"]([^'"]*)['"]/);
      
      // Look for form field names with improved patterns
      const usernameFieldMatch = loginPageHtml.match(/name="([^"]*email[^"]*)"/) ||
                                loginPageHtml.match(/name="([^"]*username[^"]*)"/) ||
                                loginPageHtml.match(/name="([^"]*login[^"]*)"/) ||
                                loginPageHtml.match(/name="(LoginForm\[[^\]]*\])"/);
      
      const passwordFieldMatch = loginPageHtml.match(/name="([^"]*password[^"]*)"/) ||
                                loginPageHtml.match(/name="(LoginForm\[password\])"/);
      
      // Look for remember me checkbox
      const rememberMeMatch = loginPageHtml.match(/name="([^"]*rememberMe[^"]*)"/) ||
                             loginPageHtml.match(/name="(LoginForm\[rememberMe\])"/);
      
      // Also check for ALL hidden form fields
      const hiddenFieldsMatches = loginPageHtml.match(/<input[^>]*type="hidden"[^>]*name="([^"]*)"[^>]*value="([^"]*)"[^>]*>/g);
      
      console.log('Found username field:', usernameFieldMatch?.[1]);
      console.log('Found password field:', passwordFieldMatch?.[1]);
      console.log('Found rememberMe field:', rememberMeMatch?.[1]);
      
      // Prepare login data with detected field names
      const usernameField = usernameFieldMatch ? usernameFieldMatch[1] : 'LoginForm[email]';
      const passwordField = passwordFieldMatch ? passwordFieldMatch[1] : 'LoginForm[password]';
      
      const loginData = {
        [usernameField]: username,
        [passwordField]: password
      };
      
      // Add rememberMe field if found
      if (rememberMeMatch) {
        loginData[rememberMeMatch[1]] = '0';
        console.log('Added rememberMe field:', rememberMeMatch[1]);
      }

      // Add hidden fields but avoid duplicating CSRF token
      if (hiddenFieldsMatches) {
        hiddenFieldsMatches.forEach(match => {
          const nameMatch = match.match(/name="([^"]*)"/);
          const valueMatch = match.match(/value="([^"]*)"/);
          if (nameMatch && valueMatch) {
            const fieldName = nameMatch[1];
            const fieldValue = valueMatch[1];
            // Don't add CSRF token from hidden fields if we already have one
            if (!loginData[fieldName] && fieldName !== '_csrf') {
              loginData[fieldName] = fieldValue;
              console.log(`Added hidden field: ${fieldName} = ${fieldValue}`);
            }
          }
        });
      }

      // Only add CSRF token if we found it in the form
      if (csrfMatch) {
        loginData._csrf = csrfMatch[1];
        console.log('Found CSRF token:', csrfMatch[1]);
      }

      console.log(`Using fields: ${usernameField}, ${passwordField}`);
      console.log('Login data:', JSON.stringify(loginData, null, 2));

      // Build cookie header from login page cookies
      let cookieHeader = '';
      if (loginPageCookies) {
        cookieHeader = loginPageCookies.map(cookie => cookie.split(';')[0]).join('; ');
      }

      // Perform login - try both regular form submission and AJAX approach
      console.log('Submitting login form...');
      
      // First try with X-Requested-With header to simulate AJAX request
      let loginResponse;
      try {
        loginResponse = await loginInstance.post('https://www.spielerplus.de/site/login', 
          new URLSearchParams(loginData), {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Referer': loginPageResponse.request.res.responseUrl || 'https://www.spielerplus.de/site/login',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br',
              'DNT': '1',
              'Connection': 'keep-alive',
              'Upgrade-Insecure-Requests': '1',
              'X-Requested-With': 'XMLHttpRequest',
              'Cookie': cookieHeader
            },
            maxRedirects: 0,
            validateStatus: function (status) {
              return status < 400; // Accept redirects
            }
          }
        );
      } catch (error) {
        if (error.response && (error.response.status === 302 || error.response.status === 301)) {
          // Handle redirect manually
          console.log('Login redirect detected:', error.response.headers.location);
          loginResponse = error.response;
        } else {
          throw error;
        }
      }

      console.log('Login response status:', loginResponse.status);
      console.log('Login response headers:', JSON.stringify(loginResponse.headers, null, 2));
      
      // Debug: Check the response content for error messages
      const responseContent = loginResponse.data;
      let loginFailed = false;
      let errorMessage = 'Unknown login error';
      
      if (responseContent.includes('error') || responseContent.includes('invalid') || responseContent.includes('incorrect')) {
        console.log('Login response appears to contain error - checking content...');
        loginFailed = true;
        
        // Look for various error message patterns
        const errorPatterns = [
          /<div[^>]*class="[^"]*alert[^"]*"[^>]*>([^<]+)/,
          /<div[^>]*class="[^"]*error[^"]*"[^>]*>([^<]+)/,
          /<div[^>]*class="[^"]*help-block[^"]*"[^>]*>([^<]+)/,
          /<span[^>]*class="[^"]*error[^"]*"[^>]*>([^<]+)/,
          /class="field-loginform-[^"]*\s+has-error[^"]*"[\s\S]*?<div[^>]*class="help-block"[^>]*>([^<]+)/
        ];
        
        for (const pattern of errorPatterns) {
          const match = responseContent.match(pattern);
          if (match && match[1].trim()) {
            errorMessage = match[1].trim();
            console.log('Found error message:', errorMessage);
            break;
          }
        }
        
        // Also check for form validation errors
        if (responseContent.includes('has-error')) {
          console.log('Form validation errors detected');
          // Extract field-specific errors
          const fieldErrors = responseContent.match(/field-loginform-[^"]*\s+has-error[\s\S]*?<div[^>]*class="help-block"[^>]*>([^<]+)/g);
          if (fieldErrors) {
            fieldErrors.forEach(error => {
              const errorText = error.match(/<div[^>]*class="help-block"[^>]*>([^<]+)/);
              if (errorText) {
                console.log('Field error:', errorText[1].trim());
                errorMessage = errorText[1].trim();
              }
            });
          }
        }
        
        // Show more of the response content for debugging
        console.log('Response content preview (first 1000 chars):');
        console.log(responseContent.substring(0, 1000));
      } else {
        // Even if no explicit error keywords found, check if we're still on login page
        if (responseContent.includes('LoginForm[email]') && responseContent.includes('LoginForm[password]')) {
          console.log('Still showing login form - login failed');
          loginFailed = true;
          errorMessage = 'Login failed - still showing login form';
          console.log('Response content preview (first 800 chars):');
          console.log(responseContent.substring(0, 800));
        }
      }
      
      // If login failed, throw error immediately before trying to extract cookies
      if (loginFailed) {
        throw new Error(`Authentication failed: ${errorMessage}`);
      }

      // Extract cookies from login response
      const cookies = loginResponse.headers['set-cookie'] || loginResponse.headers['Set-Cookie'];
      console.log('Login response cookies:', cookies);
      console.log('All login response headers:', JSON.stringify(loginResponse.headers, null, 2));
      
      // Check if login was successful by looking at response content, URL, or Location header
      const responseUrl = loginResponse.request?.res?.responseUrl || loginResponse.headers?.location;
      console.log('Login response URL:', responseUrl);
      
      // For redirects (301/302), check the Location header and X-redirect header
      const redirectLocation = loginResponse.headers.location || loginResponse.headers['x-redirect'];
      if (loginResponse.status === 302 && redirectLocation) {
        console.log('Login successful - redirect location:', redirectLocation);
      }
      
      // Extract session cookies - SpielerPlus now uses _identity and SID
      let sessionCookie = null;
      let csrfCookie = null;
      let identityCookie = null;
      
      if (cookies) {
        for (const cookie of cookies) {
          if (cookie.startsWith('SID=')) {
            sessionCookie = cookie.split(';')[0];
          } else if (cookie.startsWith('_csrf=')) {
            csrfCookie = cookie.split(';')[0];
          } else if (cookie.startsWith('_identity=')) {
            identityCookie = cookie.split(';')[0];
          }
        }
      }
      
      // For modern SpielerPlus, we need _identity, SID and _csrf cookies
      if (!sessionCookie || !identityCookie) {
        if (loginResponse.status === 302) {
          console.log('Login successful with redirect - using cookies from response');
          // Use cookies from the login response
        } else {
          throw new Error('Login failed - missing required session cookies');
        }
      }
      
      console.log('Session cookie:', sessionCookie);
      console.log('CSRF cookie:', csrfCookie);


      // Use ALL cookies from the login response for subsequent requests
      if (!identityCookie) {
        throw new Error('Login failed - missing _identity cookie');
      }
      
      // Collect ALL cookies from both login page AND login response
      const allLoginCookies = [];
      
      // Add cookies from login page response
      if (loginPageCookies) {
        loginPageCookies.forEach(cookie => {
          allLoginCookies.push(cookie.split(';')[0]); // Just the name=value part
        });
      }
      
      // Add/update cookies from login response (these may override login page cookies)
      if (cookies) {
        cookies.forEach(cookie => {
          const cookieName = cookie.split('=')[0];
          const cookieValue = cookie.split(';')[0];
          
          // Remove any existing cookie with same name, then add the new one
          const existingIndex = allLoginCookies.findIndex(c => c.startsWith(cookieName + '='));
          if (existingIndex >= 0) {
            allLoginCookies[existingIndex] = cookieValue;
          } else {
            allLoginCookies.push(cookieValue);
          }
        });
      }
      
      const cookieString = allLoginCookies.join('; ');
      
      this.axiosInstance = axios.create({
        timeout: 10000,
        headers: {
          'Cookie': cookieString,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      // Store authentication state
      this.identityCookie = identityCookie.split('=')[1];
      this.isAuthenticated = true;
      this.authCredentials = { username, password };

      console.log('Authentication successful with ALL cookies:', cookieString.substring(0, 150) + '...');
      return this.identityCookie;
    } catch (error) {
      console.error('Login error:', error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response headers:', JSON.stringify(error.response.headers, null, 2));
        console.error('Response data preview:', error.response.data.substring(0, 500));
      }
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }


  async filterCalendarWithCredentials(username, password, teamId, teamName) {
    try {
      // Login only if not already authenticated
      if (!this.isAuthenticated || !this.authCredentials || 
          this.authCredentials.username !== username || 
          this.authCredentials.password !== password) {
        await this.loginWithCredentials(username, password);
      }
      
      // First, try to find the user's personal iCal URL by accessing their dashboard
      const dashboardResponse = await this.axiosInstance.get('https://www.spielerplus.de/dashboard');
      const $ = cheerio.load(dashboardResponse.data);
      
      // Look for iCal export links
      let icalUrl = null;
      
      // Try common iCal URL patterns
      const possibleUrls = [
        `https://www.spielerplus.de/team/${teamId}/events/ics`,
        `https://www.spielerplus.de/events/ics?team=${teamId}`,
        `https://www.spielerplus.de/calendar/ics?team=${teamId}`
      ];
      
      // Check if there's an iCal link in the dashboard for this specific team
      $('a[href*="ics"]').each((i, elem) => {
        const href = $(elem).attr('href');
        if (href && href.includes(teamId)) {
          icalUrl = href.startsWith('http') ? href : `https://www.spielerplus.de${href}`;
        }
      });
      
      // If no specific URL found, try the team events page to find the iCal export
      if (!icalUrl) {
        try {
          const teamResponse = await this.axiosInstance.get(`https://www.spielerplus.de/team/${teamId}/events`);
          const teamPage = cheerio.load(teamResponse.data);
          
          teamPage('a[href*="ics"]').each((i, elem) => {
            const href = teamPage(elem).attr('href');
            if (href) {
              icalUrl = href.startsWith('http') ? href : `https://www.spielerplus.de${href}`;
            }
          });
        } catch (teamError) {
          console.log('Could not access team events page:', teamError.message);
        }
      }
      
      // Fallback to the first possible URL if nothing found
      if (!icalUrl) {
        icalUrl = possibleUrls[0];
      }
      
      console.log(`Using iCal URL: ${icalUrl}`);
      
      // Use the existing filter method
      return await this.filterCalendarByNomination(icalUrl, teamName);
    } catch (error) {
      throw new Error(`Failed to generate calendar: ${error.message}`);
    }
  }

  async fetchOriginalCalendar(icalUrl, username = null, password = null) {
    try {
      const config = {};
      if (username && password) {
        config.auth = {
          username: username,
          password: password
        };
      }
      const response = await axios.get(icalUrl, config);
      return ical.parseICS(response.data);
    } catch (error) {
      console.error('Error fetching original calendar:', error.message);
      throw new Error('Failed to fetch original calendar');
    }
  }

  async checkAttendanceStatus(eventUrl, userParam) {
    // Declare $ at the very beginning to avoid temporal dead zone issues
    let $;
    
    // Initialize attendance status object at the beginning
    let attendanceStatus = {
      nominated: false,
      attending: false,
      status: 'not_nominated',
      emoji: '❌'
    };

    try {
      
      // Validate session before making request
      if (!this.axiosInstance || !this.isAuthenticated) {
        throw new Error('Not authenticated');
      }
      
      // Use the event URL directly - no u parameter needed for individual pages
      const fullEventUrl = eventUrl;
      
      console.log(`Making request to: ${fullEventUrl}`);
      const cookieHeader = this.axiosInstance.defaults.headers.Cookie;
      console.log(`Cookies: ${cookieHeader ? cookieHeader : 'NONE'}`);
      const hasIdentity = cookieHeader?.includes('_identity=');
      const hasSID = cookieHeader?.includes('SID=');
      console.log(`_identity: ${hasIdentity}, SID: ${hasSID}`);
      
      // Configure axios to follow redirects automatically like a browser
      const response = await this.axiosInstance.get(fullEventUrl, {
        maxRedirects: 5, // Follow up to 5 redirects automatically
        timeout: 30000, // 30 second timeout
        validateStatus: function (status) {
          return status >= 200 && status < 400; // Accept 2xx and 3xx status codes
        }
      });
      
      const finalUrl = response.request.res.responseUrl || fullEventUrl;
      console.log(`Final URL: ${finalUrl}`);
      
      // Handle the login-by-team countdown page
      if (finalUrl.includes('/site/login-by-team')) {
        console.log('📋 On login-by-team page - checking for redirect...');
        
        // Check if this response set any new cookies
        const newCookies = response.headers['set-cookie'];
        if (newCookies) {
          console.log('🍪 Login-by-team page set new cookies:', newCookies.length);
          
          // Update our axios instance with the new cookies
          const existingCookies = this.axiosInstance.defaults.headers.Cookie.split('; ');
          const updatedCookies = [...existingCookies];
          
          newCookies.forEach(cookie => {
            const cookieName = cookie.split('=')[0];
            const cookieValue = cookie.split(';')[0];
            
            // Remove any existing cookie with same name, then add the new one
            const existingIndex = updatedCookies.findIndex(c => c.startsWith(cookieName + '='));
            if (existingIndex >= 0) {
              updatedCookies[existingIndex] = cookieValue;
            } else {
              updatedCookies.push(cookieValue);
            }
          });
          
          // Update the axios instance with new cookies
          this.axiosInstance.defaults.headers.Cookie = updatedCookies.join('; ');
          console.log('🔄 Updated cookies after login-by-team');
        }
        
        const pageContent = response.data;
        
        // Look for meta refresh redirect
        const metaRefreshMatch = pageContent.match(/<meta[^>]*http-equiv="refresh"[^>]*content="[^"]*url=([^"]*)"[^>]*>/i);
        
        // Look for JavaScript redirect
        const jsRedirectMatch = pageContent.match(/window\.location\s*=\s*["']([^"']+)["']/i) ||
                               pageContent.match(/location\.href\s*=\s*["']([^"']+)["']/i) ||
                               pageContent.match(/location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i);
        
        // Look for the redirect URL in the original URL parameters
        const redirectParam = finalUrl.match(/redirect=([^&]+)/);
        
        let redirectUrl = null;
        
        if (metaRefreshMatch) {
          redirectUrl = decodeURIComponent(metaRefreshMatch[1]);
          console.log('Found meta refresh redirect:', redirectUrl);
        } else if (jsRedirectMatch) {
          redirectUrl = decodeURIComponent(jsRedirectMatch[1]);
          console.log('Found JavaScript redirect:', redirectUrl);
        } else if (redirectParam) {
          redirectUrl = decodeURIComponent(redirectParam[1]);
          console.log('Found redirect parameter:', redirectUrl);
        }
        
        if (redirectUrl) {
          // Make the redirect URL absolute if it's relative
          if (redirectUrl.startsWith('/')) {
            redirectUrl = 'https://www.spielerplus.de' + redirectUrl;
          }
          
          // Skip the countdown and redirect immediately
          
          try {
            console.log(`Following redirect to: ${redirectUrl}`);
            
            // Debug: Show what cookies we're sending
            const cookieHeader = this.axiosInstance.defaults.headers.Cookie;
            console.log(`Sending cookies: ${cookieHeader ? 'Yes' : 'No'}`);
            
            const redirectResponse = await this.axiosInstance.get(redirectUrl, {
              maxRedirects: 5,
              timeout: 30000, // 30 second timeout
              validateStatus: function (status) {
                return status >= 200 && status < 400;
              }
            });
            
            const newFinalUrl = redirectResponse.request.res.responseUrl || redirectUrl;
            console.log(`Redirect final URL: ${newFinalUrl}`);
            
            // Use the redirected response - reinitialize cheerio with new data
            $ = cheerio.load(redirectResponse.data);
          } catch (redirectError) {
            console.log('❌ Error following redirect:', redirectError.message);
            console.log('Status:', redirectError.response?.status);
            console.log('Headers:', redirectError.response?.headers);
            
            // 403 means forbidden - likely cookie/session issue
            if (redirectError.response?.status === 403) {
              console.log('💡 403 Forbidden - possible cookie/session issue');
            }
            
            
            return {
              nominated: false,
              attending: false,
              status: 'auth_failed',
              emoji: '🔒'
            };
          }
        } else {
          console.log('❌ No redirect found on login-by-team page');
          return {
            nominated: false,
            attending: false,
            status: 'auth_failed',
            emoji: '🔒'
          };
        }
      }
      
      // Check if we ended up on a regular login page (not login-by-team)
      else if (finalUrl.includes('/site/login') || finalUrl.endsWith('/login') || finalUrl.includes('/auth/login')) {
        const hasLoginForm = response.data.includes('LoginForm[email]') || 
                           response.data.includes('LoginForm[password]');
        
        if (hasLoginForm) {
          console.log('⚠️  Authentication failed - on login page');
          return {
            nominated: false,
            attending: false,
            status: 'auth_failed',
            emoji: '🔒'
          };
        }
      }
      
      $ = cheerio.load(response.data);
      
      // Check if we got a skeleton page (empty title, minimal content)
      let pageTitle = $('title').text().trim();
      let participationButtons = $('.participation-button');
      
      // If the page seems to be loading dynamically, try a few more times with delay
      if ((!pageTitle || pageTitle === '') && participationButtons.length === 0) {
        console.log('Page appears to be loading dynamically, retrying...');
        
        for (let retry = 0; retry < 3; retry++) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          
          const retryResponse = await this.axiosInstance.get(fullEventUrl);
          $ = cheerio.load(retryResponse.data);
          pageTitle = $('title').text().trim();
          participationButtons = $('.participation-button');
          
          console.log(`Retry ${retry + 1}: title="${pageTitle}", buttons=${participationButtons.length}`);
          
          if (pageTitle && pageTitle !== '' || participationButtons.length > 0) {
            console.log('Content loaded successfully on retry');
            break;
          }
        }
      }
      
      // Look for participation buttons
      const attendanceButtons = $('.participation-button');
      console.log(`Found ${attendanceButtons.length} participation buttons`);
      
      // Check for "Nicht nominiert" (not nominated) text
      const nichtNominiertText = $('.deactivated b:contains("Nicht nominiert"), b:contains("Nicht nominiert")');
      const hasNichtNominiert = nichtNominiertText.length > 0;
      console.log(`"Nicht nominiert" text found: ${hasNichtNominiert}`);
      
      if (attendanceButtons.length > 0) {
        // Check if buttons are disabled (indicates not nominated)
        const disabledButtons = attendanceButtons.filter('[disabled]');
        const hasDisabledButtons = disabledButtons.length > 0;
        console.log(`Disabled buttons: ${disabledButtons.length}/${attendanceButtons.length}`);
        
        
        // Check if user has made a selection (even if buttons are now disabled)
        const hasSelectedButton = attendanceButtons.filter('.selected').length > 0;
        
        // Only mark as "not nominated" if explicit "Nicht nominiert" text is found
        // OR if all buttons are disabled AND no selection has been made
        if (hasNichtNominiert || (disabledButtons.length === attendanceButtons.length && !hasSelectedButton)) {
          console.log('User not nominated for this event');
          attendanceStatus.nominated = false;
          attendanceStatus.attending = false;
          attendanceStatus.status = 'not_nominated';
          attendanceStatus.emoji = '❌';
          return attendanceStatus;
        }
        
        attendanceButtons.each((i, elem) => {
          const title = $(elem).attr('title') || '';
          const hasSelected = $(elem).hasClass('selected');
          const isDisabled = $(elem).attr('disabled') === 'disabled';
          console.log(`Button ${i}: title="${title}", selected=${hasSelected}, disabled=${isDisabled}`);
        });
      }
      
      // Detect specific participation status - only the selected button has the 'selected' class
      const selectedConfirm = $('.participation-button.selected[title="Zugesagt"]');
      const selectedDecline = $('.participation-button.selected[title="Absagen / Abwesend"]');
      const selectedMaybe = $('.participation-button.selected[title="Unsicher"]');
      
      console.log(`Selected status: confirm=${selectedConfirm.length}, decline=${selectedDecline.length}, maybe=${selectedMaybe.length}`);
      
      if (attendanceButtons.length > 0) {
        attendanceStatus.nominated = true;
        
        if (selectedConfirm.length > 0) {
          attendanceStatus.attending = true;
          attendanceStatus.status = 'attending';
          attendanceStatus.emoji = '👍';
        } else if (selectedDecline.length > 0) {
          attendanceStatus.attending = false;
          attendanceStatus.status = 'not_attending';
          attendanceStatus.emoji = '👎';
        } else if (selectedMaybe.length > 0) {
          attendanceStatus.attending = false;
          attendanceStatus.status = 'maybe';
          attendanceStatus.emoji = '❓';
        } else {
          attendanceStatus.attending = false;
          attendanceStatus.status = 'no_response';
          attendanceStatus.emoji = '🤷';
        }
      } else {
        // No participation buttons found - check if user is not nominated for this event
        console.log('No participation buttons found - user may not be nominated for this event');
        
        // Analyze page content for participation status since API endpoints don't exist
        const pageHtml = $.html();
        const eventIdMatch = eventUrl.match(/id=(\d+)/);
        const eventId = eventIdMatch ? eventIdMatch[1] : null;
        
        if (eventId) {
          console.log('Event ID:', eventId);
        }
        
        // For now, since we can't reliably get attendance status, use a simplified approach
        // based on event type and date
        if (attendanceStatus.status === 'not_nominated') {
          const bodyText = $('body').text().toLowerCase();
          const currentDate = new Date();
          const eventIdMatch = eventUrl.match(/id=(\d+)/);
          const eventId = eventIdMatch ? eventIdMatch[1] : '';
          
          // Check for specific decline patterns first
          if (bodyText.includes('abgesagt') || bodyText.includes('absage') || 
              bodyText.includes('nicht teilnehmen') || bodyText.includes('abwesend')) {
            attendanceStatus.nominated = true;
            attendanceStatus.attending = false;
            attendanceStatus.status = 'not_attending';
            attendanceStatus.emoji = '👎';
            console.log('Found decline indicators in text');
          }
          // Check for data attributes, JavaScript variables, or hidden form data
          else {
            // Look for JavaScript data in the page
            const scriptMatches = pageHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
            let foundStatusInScript = false;
            
            for (const script of scriptMatches) {
              const scriptContent = script.replace(/<\/?script[^>]*>/gi, '');
              
              // Look for specific participation status data in JavaScript (not generic keywords)
              const hasParticipationData = scriptContent.includes('participation-button') || 
                                         scriptContent.includes('showParticipationForm') ||
                                         scriptContent.match(/participation.*:.*["\']?(zugesagt|abgesagt|unsicher)["\']?/i);
              
              if (hasParticipationData) {
                console.log(`Found participation data in script`);
                console.log(`Script snippet: ${scriptContent.substring(0, 300)}`);
                
                // Look for specific status patterns - only if they're clearly related to user status
                if (scriptContent.match(/user.*abgesagt|participation.*abgesagt|status.*abgesagt/i)) {
                  attendanceStatus.nominated = true;
                  attendanceStatus.attending = false;
                  attendanceStatus.status = 'not_attending';
                  attendanceStatus.emoji = '👎';
                  foundStatusInScript = true;
                  console.log('Found decline status in JavaScript');
                  break;
                } else if (scriptContent.match(/user.*zugesagt|participation.*zugesagt|status.*zugesagt/i)) {
                  attendanceStatus.nominated = true;
                  attendanceStatus.attending = true;
                  attendanceStatus.status = 'attending';
                  attendanceStatus.emoji = '👍';
                  foundStatusInScript = true;
                  console.log('Found confirm status in JavaScript');
                  break;
                }
              }
            }
            
            if (!foundStatusInScript) {
              // Look for data attributes in the HTML
              const dataAttrs = pageHtml.match(/data-[^=]*="[^"]*"/gi) || [];
              console.log(`Found ${dataAttrs.length} data attributes:`, dataAttrs.slice(0, 5));
              
              // Look for hidden inputs with status info
              const hiddenInputs = pageHtml.match(/<input[^>]*type="hidden"[^>]*>/gi) || [];
              console.log(`Found ${hiddenInputs.length} hidden inputs:`, hiddenInputs.slice(0, 3));
            }
          }
          
          // Only check for explicit participation indicators, don't default to attending
          if (attendanceStatus.status === 'not_nominated') {
            if (bodyText.includes('zugesagt') || bodyText.includes('teilnehmen')) {
              attendanceStatus.nominated = true;
              attendanceStatus.attending = true;
              attendanceStatus.status = 'attending';
              attendanceStatus.emoji = '👍';
              console.log('Found attendance indicators in text');
            } else if (bodyText.includes('unsicher') || bodyText.includes('vielleicht')) {
              attendanceStatus.nominated = true;
              attendanceStatus.attending = false;
              attendanceStatus.status = 'maybe';
              attendanceStatus.emoji = '❓';
              console.log('Found maybe indicators in text');
            } else {
              // No participation buttons and no clear indicators - user likely not nominated
              attendanceStatus.nominated = false;
              attendanceStatus.attending = false;
              attendanceStatus.status = 'not_nominated';
              attendanceStatus.emoji = '❌';
              console.log('No participation indicators found - user not nominated for this event');
            }
          }
        }
      }

      console.log(`Final status for event: ${attendanceStatus.emoji} (${attendanceStatus.status})`);
      return attendanceStatus;
    } catch (error) {
      console.error(`Error checking attendance for ${eventUrl}:`, error.message);
      return {
        nominated: true,
        attending: false,
        status: 'no_response',
        emoji: '🤷'
      };
    }
  }

  async filterCalendarByNomination(icalUrl, teamName = 'Filtered Team Calendar', username = null, password = null) {
    try {
      // Extract user parameter from iCal URL
      const urlParams = new URL(icalUrl);
      const userParam = urlParams.searchParams.get('u');
      console.log(`Extracted user parameter from iCal URL: ${userParam}`);
      
      const originalEvents = await this.fetchOriginalCalendar(icalUrl, username, password);
      
      const events = Object.keys(originalEvents).filter(key => {
        const event = originalEvents[key];
        return event.type === 'VEVENT' && !event.uid.includes('absence');
      });
      
      const filteredCalendar = icalGenerator({
        name: teamName,
        description: `Calendar with attendance status indicators`,
        timezone: 'Europe/Berlin',
        prodId: {
          company: 'SpielerPlus Filter',
          product: 'Calendar Filter'
        }
      });

      // Process events with limited concurrency to prevent overwhelming the server
      const processedEvents = [];
      const concurrencyLimit = 1; // Process only 1 event at a time to be safe
      
      for (let i = 0; i < events.length; i += concurrencyLimit) {
        const batch = events.slice(i, i + concurrencyLimit);
        const batchPromises = batch.map(async (key) => {
          const event = originalEvents[key];
          const eventUrl = event.url;
          
          if (!eventUrl) {
            const updatedEvent = { ...event };
            updatedEvent.summary = `👍 ${event.summary}`;
            return updatedEvent;
          }

          // If we have authentication, check attendance, otherwise default to attending
          if (this.axiosInstance || (username && password)) {
            const attendanceStatus = await this.checkAttendanceStatus(eventUrl, userParam);
            const updatedEvent = { ...event };
            updatedEvent.summary = `${attendanceStatus.emoji} ${event.summary}`;
            return updatedEvent;
          } else {
            const updatedEvent = { ...event };
            updatedEvent.summary = `👍 ${event.summary}`;
            return updatedEvent;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        processedEvents.push(...batchResults);
        
        // Small delay between batches to be nice to the server
        if (i + concurrencyLimit < events.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const allEvents = processedEvents.filter(event => event !== null);
      
      allEvents.forEach(event => {
        filteredCalendar.createEvent({
          id: event.uid,
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
          location: event.location,
          url: event.url,
          status: event.status,
          sequence: Math.floor(Date.now() / 1000) // Unix timestamp to force updates
        });
      });

      return filteredCalendar.toString();
    } catch (error) {
      throw new Error('Failed to filter calendar');
    }
  }

  async filterCalendarWithBasicAuth(icalUrl, teamName = 'Filtered Team Calendar', username, password, showNotNominated = false) {
    try {
      // Extract user parameter from iCal URL
      const urlParams = new URL(icalUrl);
      const userParam = urlParams.searchParams.get('u');
      console.log(`Extracted user parameter from iCal URL: ${userParam}`);
      
      // Store credentials for potential session-based requests
      this.authCredentials = { username, password };
      
      // Login to get session for attendance checking
      if (!this.isAuthenticated || !this.authCredentials || 
          this.authCredentials.username !== username || 
          this.authCredentials.password !== password) {
        console.log('Logging in to check attendance status...');
        await this.loginWithCredentials(username, password);
      }
      
      // Fetch the calendar using HTTP Basic Auth
      const originalEvents = await this.fetchOriginalCalendar(icalUrl, username, password);
      
      // Filter out absence events
      const events = Object.keys(originalEvents).filter(key => {
        const event = originalEvents[key];
        return event.type === 'VEVENT' && !event.uid.includes('absence');
      });
      
      const filteredCalendar = icalGenerator({
        name: teamName,
        description: `Calendar with attendance status indicators`,
        timezone: 'Europe/Berlin',
        prodId: {
          company: 'SpielerPlus Filter',
          product: 'Calendar Filter'
        }
      });

      // Process events with limited concurrency to prevent overwhelming the server
      const processedEvents = [];
      const concurrencyLimit = 1; // Process only 1 event at a time to be safe
      
      for (let i = 0; i < events.length; i += concurrencyLimit) {
        const batch = events.slice(i, i + concurrencyLimit);
        const batchPromises = batch.map(async (key) => {
          const event = originalEvents[key];
          const eventUrl = event.url;
          
          if (!eventUrl) {
            const updatedEvent = { ...event };
            updatedEvent.summary = `👍 ${event.summary}`;
            return updatedEvent;
          }

          // Check attendance status using authenticated session
          if (this.axiosInstance && this.isAuthenticated) {
            try {
              const attendanceStatus = await this.checkAttendanceStatus(eventUrl, userParam);
              
              
              const updatedEvent = { ...event };
              updatedEvent.summary = `${attendanceStatus.emoji} ${event.summary}`;
              updatedEvent.attendanceStatus = attendanceStatus; // Store for later filtering
              return updatedEvent;
            } catch (error) {
              console.error(`Error checking attendance for event ${event.uid}:`, error.message);
              const updatedEvent = { ...event };
              updatedEvent.summary = `🤷 ${event.summary}`;
              return updatedEvent;
            }
          } else {
            const updatedEvent = { ...event };
            updatedEvent.summary = `👍 ${event.summary}`;
            return updatedEvent;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        processedEvents.push(...batchResults);
        
        // Small delay between batches to be nice to the server
        if (i + concurrencyLimit < events.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const allEvents = processedEvents.filter(event => event !== null);
      
      // Filter out not nominated events unless showNotNominated is true
      const filteredEvents = allEvents.filter(event => {
        if (event.attendanceStatus && !event.attendanceStatus.nominated && !showNotNominated) {
          console.log(`Filtering out not nominated event: ${event.summary}`);
          return false;
        }
        return true;
      });
      
      filteredEvents.forEach(event => {
        filteredCalendar.createEvent({
          id: event.uid,
          summary: event.summary,
          description: event.description,
          start: event.start,
          end: event.end,
          location: event.location,
          url: event.url,
          status: event.status,
          sequence: Math.floor(Date.now() / 1000), // Unix timestamp to force updates
          timezone: 'Europe/Berlin'
        });
      });

      return filteredCalendar.toString();
    } catch (error) {
      throw new Error(`Failed to filter calendar: ${error.message}`);
    }
  }

}

module.exports = ICalFilter;