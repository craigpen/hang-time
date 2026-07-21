/**
 * Hang Time - OAuth Callback Handler
 * Handles OAuth redirects from Spotify and Twitch
 */

async function handleOAuthCallback(): Promise<void> {
  try {
    console.log('[OAuth Handler] Processing callback...');

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');

    if (error) {
      showError(`Authorization failed: ${error}`);
      return;
    }

    if (!code) {
      showError('No authorization code received');
      return;
    }

    // Verify state token
    const storedState = await getFromStorage('oauth_state');
    if (state !== storedState) {
      showError('State mismatch - invalid request');
      return;
    }

    // Determine which service based on hostname
    const service = detectService();
    if (!service) {
      showError('Could not determine service');
      return;
    }

    // Send code to background worker for token exchange
    const response = await chrome.runtime.sendMessage({
      type: 'HANDLE_OAUTH_CALLBACK',
      data: { service, code },
    });

    if (response.success) {
      console.log(`[OAuth Handler] ${service} authorization successful`);
      showSuccess(`Authorization successful! You can close this window.`);
      setTimeout(() => window.close(), 2000);
    } else {
      showError(response.error || 'Failed to complete authorization');
    }
  } catch (error) {
    console.error('[OAuth Handler] Error:', error);
    showError(error instanceof Error ? error.message : 'An error occurred');
  }
}

function detectService(): string | null {
  const hostname = window.location.hostname;
  if (hostname.includes('spotify')) {
    return 'spotify';
  }
  if (hostname.includes('twitch')) {
    return 'twitch';
  }
  // Check query params as fallback
  const params = new URLSearchParams(window.location.search);
  return params.get('service');
}

async function getFromStorage(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] || null);
    });
  });
}

function showError(message: string): void {
  const errorDiv = document.getElementById('error');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
  }
  const spinner = document.querySelector('.spinner');
  if (spinner) {
    spinner.style.display = 'none';
  }
  const h1 = document.querySelector('h1');
  if (h1) {
    h1.textContent = 'Authorization Failed';
  }
}

function showSuccess(message: string): void {
  const container = document.querySelector('.container');
  if (container) {
    container.innerHTML = `
      <div style="color: #16a34a;">
        <div style="font-size: 3em; margin-bottom: 10px;">✓</div>
        <h1>${message}</h1>
      </div>
    `;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  handleOAuthCallback().catch((error) => {
    console.error('[OAuth Handler] Fatal error:', error);
    showError('An unexpected error occurred');
  });
});
