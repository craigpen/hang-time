/**
 * Hang Time - Security Utilities
 * Cryptographic functions and input validation helpers
 */

/**
 * Generate cryptographically secure random string
 * For use in CSRF tokens, state parameters, nonces
 */
export function generateSecureRandom(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);

  // Convert to base64 URL-safe
  let result = '';
  for (let i = 0; i < array.length; i++) {
    result += String.fromCharCode(array[i]);
  }

  return btoa(result)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Validate URL is from expected OAuth provider
 * Prevents CSRF attacks via open redirects
 */
export function validateOAuthRedirect(
  redirectUrl: string,
  expectedOrigin: string
): boolean {
  try {
    const url = new URL(redirectUrl);

    // Must use HTTPS
    if (url.protocol !== 'https:') {
      return false;
    }

    // Must match expected origin exactly
    if (url.origin !== expectedOrigin) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate OAuth state parameter
 * Ensures round-trip integrity
 */
export function validateState(providedState: string, storedState: string): boolean {
  if (!providedState || !storedState) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  return constantTimeCompare(providedState, storedState);
}

/**
 * Constant-time string comparison
 * Prevents timing attacks on state validation
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Validate friend name input
 * Prevents injection and excessive length
 */
export function validateFriendName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Friend name is required' };
  }

  const trimmed = name.trim();

  // Check length
  if (trimmed.length === 0) {
    return { valid: false, error: 'Friend name cannot be empty' };
  }
  if (trimmed.length > 50) {
    return { valid: false, error: 'Friend name must be 50 characters or less' };
  }

  // Check for control characters
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, error: 'Friend name contains invalid characters' };
  }

  return { valid: true };
}

/**
 * Validate message content
 * Prevents excessively long messages
 */
export function validateMessage(content: string): { valid: boolean; error?: string } {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Message is required' };
  }

  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Message cannot be empty' };
  }

  if (trimmed.length > 10000) {
    return { valid: false, error: 'Message must be 10,000 characters or less' };
  }

  return { valid: true };
}

/**
 * Validate OAuth token response
 * Ensures required fields are present
 */
export function validateOAuthToken(response: any): { valid: boolean; error?: string } {
  if (!response || typeof response !== 'object') {
    return { valid: false, error: 'Invalid token response' };
  }

  if (!response.access_token || typeof response.access_token !== 'string') {
    return { valid: false, error: 'No access token in response' };
  }

  if (!response.expires_in || typeof response.expires_in !== 'number') {
    return { valid: false, error: 'No expiry information in response' };
  }

  return { valid: true };
}

/**
 * Sanitize error message for logging
 * Removes sensitive information before logging
 */
export function sanitizeErrorForLogging(error: any): string {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return sanitizeString(error);
  }

  if (error instanceof Error) {
    // Extract only safe error properties
    const safeMessage = sanitizeString(error.message);
    const safeStack = sanitizeString(error.stack || '');

    return `${error.name}: ${safeMessage}`;
  }

  return 'Unknown error';
}

/**
 * Remove sensitive information from strings
 */
function sanitizeString(str: string): string {
  if (!str || typeof str !== 'string') {
    return '';
  }

  // Remove tokens (patterns like "token: xyz" or "access_token=...")
  let sanitized = str.replace(/token[_=:\s][\w\-./]+/gi, 'token:[REDACTED]');

  // Remove secrets (patterns like "secret: xyz")
  sanitized = sanitized.replace(/secret[_=:\s][\w\-./]+/gi, 'secret:[REDACTED]');

  // Remove passwords
  sanitized = sanitized.replace(/password[_=:\s][\w\-./]+/gi, 'password:[REDACTED]');

  // Remove API keys
  sanitized = sanitized.replace(/api[_\-]?key[_=:\s][\w\-./]+/gi, 'api_key:[REDACTED]');

  // Remove client secrets
  sanitized = sanitized.replace(/client[_\-]?secret[_=:\s][\w\-./]+/gi, 'client_secret:[REDACTED]');

  return sanitized;
}

/**
 * Safe console logging wrapper
 * Always sanitizes error information
 */
export const secureLog = {
  debug: (module: string, message: string, data?: any) => {
    const safe = `[${module}] ${sanitizeString(message)}`;
    if (data) {
      console.debug(safe, sanitizeString(JSON.stringify(data)));
    } else {
      console.debug(safe);
    }
  },

  error: (module: string, message: string, error?: any) => {
    const safe = `[${module}] ${sanitizeString(message)}`;
    if (error) {
      const sanitizedError = sanitizeErrorForLogging(error);
      console.error(safe, sanitizedError);
    } else {
      console.error(safe);
    }
  },

  warn: (module: string, message: string) => {
    const safe = `[${module}] ${sanitizeString(message)}`;
    console.warn(safe);
  },
};
