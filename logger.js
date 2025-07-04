const crypto = require('crypto');

class Logger {
  constructor() {
    this.requestId = null;
  }

  // Generate a unique request ID for tracking
  generateRequestId() {
    return crypto.randomBytes(8).toString('hex');
  }

  // Set request ID for this logging session
  setRequestId(requestId) {
    this.requestId = requestId;
  }

  // Mask sensitive data like tokens, cookies, passwords
  maskSensitiveData(data) {
    if (typeof data === 'string') {
      // Mask tokens, passwords, cookies
      return data
        .replace(/([?&]t=)[^&]+/g, '$1***TOKEN***')
        .replace(/([?&]u=)[^&]+/g, '$1***USER***') 
        .replace(/(password['"=:]\s*)[^'",\s}]+/gi, '$1***')
        .replace(/(cookie['"=:]\s*)[^'",\s}]+/gi, '$1***')
        .replace(/(_identity=)[^;]+/g, '$1***')
        .replace(/(SID=)[^;]+/g, '$1***')
        .replace(/(Basic\s+)[A-Za-z0-9+/=]+/g, '$1***');
    }
    
    if (typeof data === 'object' && data !== null) {
      const masked = { ...data };
      const sensitiveKeys = ['password', 'token', 'cookie', 'authorization', 'auth', 'credentials'];
      
      for (const key of Object.keys(masked)) {
        if (sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive))) {
          masked[key] = '***';
        } else if (typeof masked[key] === 'string') {
          masked[key] = this.maskSensitiveData(masked[key]);
        }
      }
      return masked;
    }
    
    return data;
  }

  // Format log message with timestamp and request ID
  formatMessage(level, message, context = {}) {
    const timestamp = new Date().toISOString();
    const reqId = this.requestId || 'system';
    const maskedContext = this.maskSensitiveData(context);
    
    const logEntry = {
      timestamp,
      level,
      requestId: reqId,
      message,
      ...(Object.keys(maskedContext).length > 0 && { context: maskedContext })
    };

    return JSON.stringify(logEntry);
  }

  info(message, context = {}) {
    console.log(this.formatMessage('INFO', message, context));
  }

  warn(message, context = {}) {
    console.warn(this.formatMessage('WARN', message, context));
  }

  error(message, context = {}) {
    console.error(this.formatMessage('ERROR', message, context));
  }

  // Create a child logger with the same request ID
  child() {
    const childLogger = new Logger();
    childLogger.setRequestId(this.requestId);
    return childLogger;
  }
}

module.exports = Logger;