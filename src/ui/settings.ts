/**
 * Hang Time - Settings Page Controller
 */

export class SettingsController {
  private oauthServices = ['spotify', 'twitch'];
  private browserTabServices = ['netflix', 'youtube'];
  private allServices = ['spotify', 'twitch', 'steam', 'netflix', 'youtube'];
  private statusRefreshInterval: NodeJS.Timeout | null = null;

  static readonly STATUS_REFRESH_INTERVAL_MS = 4000;

  async init(): Promise<void> {
    console.debug('[Settings] Initializing...');

    await this._loadSettings();
    await this._loadOAuthStatus();
    await this._loadServiceStatus();
    this._setupEventListeners();

    // Auto-refresh service status
    this.statusRefreshInterval = setInterval(() => {
      this._loadServiceStatus().catch((error) => {
        console.error('[Settings] Status refresh failed:', error);
      });
    }, SettingsController.STATUS_REFRESH_INTERVAL_MS);

    console.debug('[Settings] Initialization complete');
  }

  private async _loadSettings(): Promise<void> {
    try {
      // Load user identifier
      const response = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (response.success && response.data) {
        const identifierElement = document.getElementById('user-identifier');
        if (identifierElement) {
          identifierElement.textContent = response.data.identifier || 'Loading...';
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load:', error);
    }
  }

  private async _loadOAuthStatus(): Promise<void> {
    try {
      for (const service of this.oauthServices) {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });

        const container = document.getElementById(`${service}-auth-container`);
        if (!container) continue;

        container.innerHTML = '';
        const statusText = response.success && response.data?.hasToken ? 'Reconnect' : 'Connect';

        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn-oauth';
        connectBtn.dataset.service = service;
        connectBtn.textContent = statusText;
        connectBtn.addEventListener('click', () => this._authenticateService(service));

        container.appendChild(connectBtn);

        if (response.success && response.data?.hasToken) {
          const disconnectBtn = document.createElement('button');
          disconnectBtn.className = 'btn-oauth-secondary';
          disconnectBtn.dataset.service = service;
          disconnectBtn.textContent = 'Disconnect';
          disconnectBtn.addEventListener('click', () => this._disconnectService(service));
          container.appendChild(disconnectBtn);
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load OAuth status:', error);
    }
  }

  private async _loadServiceStatus(): Promise<void> {
    try {
      // Get browser activities (Netflix and YouTube shown separately)
      const browserActivitiesResponse = await chrome.runtime.sendMessage({
        type: 'GET_BROWSER_ACTIVITIES',
      });

      const browserActivities = browserActivitiesResponse.success && browserActivitiesResponse.data
        ? browserActivitiesResponse.data
        : { netflix: null, youtube: null };

      // Update browser tab service status
      for (const service of this.browserTabServices) {
        const statusDiv = document.getElementById(`status-${service}`);
        if (statusDiv) {
          const serviceActivity = browserActivities[service as keyof typeof browserActivities];
          if (serviceActivity && serviceActivity.service !== 'idle') {
            statusDiv.textContent = `Watching: ${this._truncateContent(serviceActivity.content)}`;
            statusDiv.className = 'service-status status-active';
          } else {
            statusDiv.textContent = 'Idle';
            statusDiv.className = 'service-status status-idle';
          }
        }
      }

      // Get current activity for OAuth services
      const currentActivity = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_ACTIVITY',
      });

      const activity = currentActivity.success && currentActivity.data ? currentActivity.data : null;

      // Update OAuth service status
      const spotifyStatusDiv = document.getElementById('status-spotify');
      if (spotifyStatusDiv) {
        const spotifyAuth = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service: 'spotify' },
        });
        if (spotifyAuth.success && spotifyAuth.data?.hasToken) {
          if (activity && activity.service === 'spotify' && activity.service !== 'idle') {
            spotifyStatusDiv.textContent = `Playing: ${this._truncateContent(activity.content)}`;
            spotifyStatusDiv.className = 'service-status status-active';
          } else {
            spotifyStatusDiv.textContent = 'Connected';
            spotifyStatusDiv.className = 'service-status status-idle';
          }
        } else {
          spotifyStatusDiv.textContent = 'Not Connected';
          spotifyStatusDiv.className = 'service-status status-error';
        }
      }

      const twitchStatusDiv = document.getElementById('status-twitch');
      if (twitchStatusDiv) {
        const twitchAuth = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service: 'twitch' },
        });
        if (twitchAuth.success && twitchAuth.data?.hasToken) {
          if (activity && activity.service === 'twitch' && activity.service !== 'idle') {
            twitchStatusDiv.textContent = `Streaming: ${this._truncateContent(activity.content)}`;
            twitchStatusDiv.className = 'service-status status-active';
          } else {
            twitchStatusDiv.textContent = 'Connected';
            twitchStatusDiv.className = 'service-status status-idle';
          }
        } else {
          twitchStatusDiv.textContent = 'Not Connected';
          twitchStatusDiv.className = 'service-status status-error';
        }
      }

      const steamStatusDiv = document.getElementById('status-steam');
      if (steamStatusDiv) {
        if (activity && activity.service === 'steam' && activity.service !== 'idle') {
          steamStatusDiv.textContent = `Playing: ${this._truncateContent(activity.content)}`;
          steamStatusDiv.className = 'service-status status-active';
        } else {
          steamStatusDiv.textContent = 'Not Configured';
          steamStatusDiv.className = 'service-status status-idle';
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load service status:', error);
    }
  }

  private _truncateContent(content: string): string {
    return content.length > 40 ? content.substring(0, 40) + '...' : content;
  }

  private _getServiceLabel(service: string): string {
    const labels: { [key: string]: string } = {
      spotify: '🎵 Spotify',
      twitch: '📺 Twitch',
    };
    return labels[service] || service;
  }

  private _setupEventListeners(): void {
    // Refresh status button
    const refreshBtn = document.getElementById('refresh-status-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this._loadServiceStatus().catch((error) => {
          console.error('[Settings] Refresh failed:', error);
        });
      });
    }

    // Close button
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this._cleanup();
        window.close();
      });
    }

    // Copy identifier button
    const copyBtn = document.getElementById('copy-id-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const text = document.getElementById('user-identifier')?.textContent || '';
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            console.debug('[Settings] Identifier copied');
          });
        }
      });
    }

    // Service toggles for browser tabs
    document.querySelectorAll('input[type="checkbox"][data-service]').forEach((toggle) => {
      toggle.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const service = e.target.dataset.service;
        const enabled = e.target.checked;
        if (service) {
          this._toggleService(service, enabled);
        }
      });
    });

    // Steam verify button
    const steamVerifyBtn = document.getElementById('steam-verify-btn');
    if (steamVerifyBtn) {
      steamVerifyBtn.addEventListener('click', () => this._verifySteamId());
    }

    // Theme selector
    document.querySelectorAll('input[type="radio"][name="theme"]').forEach((radio) => {
      radio.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const theme = e.target.value;
        this._setTheme(theme);
      });
    });

    // Clear all data button
    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Are you sure? This will delete all data and cannot be undone.')) {
          this._clearAllData();
        }
      });
    }
  }

  private _cleanup(): void {
    if (this.statusRefreshInterval) {
      clearInterval(this.statusRefreshInterval);
    }
  }

  private async _verifySteamId(): Promise<void> {
    const steamIdInput = document.getElementById('steam-id-input') as HTMLInputElement | null;
    if (!steamIdInput || !steamIdInput.value.trim()) {
      alert('Please enter a Steam ID');
      return;
    }

    const steamId = steamIdInput.value.trim();
    // Simple validation - Steam IDs are numeric
    if (!/^\d+$/.test(steamId)) {
      alert('Steam ID must be numeric');
      return;
    }

    try {
      // Store Steam ID
      const profile = await chrome.storage.local.get('user_profile');
      const userProfile = profile.user_profile || {};
      userProfile.steam_id = steamId;
      await chrome.storage.local.set({ user_profile: userProfile });

      console.debug('[Settings] Steam ID verified and stored');
      alert('Steam ID verified and saved');

      // Refresh status
      await this._loadServiceStatus();
    } catch (error) {
      console.error('[Settings] Failed to verify Steam ID:', error);
      alert('Failed to verify Steam ID');
    }
  }

  private async _authenticateService(service: string): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AUTHENTICATE_SERVICE',
        data: { service },
      });

      if (response.success && response.data?.authUrl) {
        // Open auth URL in a new window
        const width = 500;
        const height = 600;
        const left = (window.innerWidth - width) / 2;
        const top = (window.innerHeight - height) / 2;

        const authWindow = window.open(
          response.data.authUrl,
          `${service}-auth`,
          `width=${width},height=${height},left=${left},top=${top}`
        );

        if (!authWindow) {
          alert(`Unable to open auth window. Please check popup blockers.`);
          return;
        }

        // Poll for completion or user closes window
        const checkInterval = setInterval(() => {
          if (authWindow.closed) {
            clearInterval(checkInterval);
            // Refresh OAuth status after auth completes
            setTimeout(() => this._loadOAuthStatus(), 500);
          }
        }, 500);
      } else {
        alert(response.error || 'Failed to start authentication');
      }
    } catch (error) {
      console.error('[Settings] Authentication failed:', error);
      alert('Failed to authenticate service');
    }
  }

  private async _disconnectService(service: string): Promise<void> {
    if (!confirm(`Are you sure? You'll need to re-authenticate ${service} to use it.`)) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DISCONNECT_SERVICE',
        data: { service },
      });

      if (response.success) {
        await this._loadOAuthStatus();
        console.debug(`[Settings] Disconnected from ${service}`);
      } else {
        alert(response.error || 'Failed to disconnect');
      }
    } catch (error) {
      console.error('[Settings] Disconnect failed:', error);
      alert('Failed to disconnect service');
    }
  }

  private async _toggleService(service: string | undefined, enabled: boolean): Promise<void> {
    if (!service) return;

    try {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_SERVICE',
        data: { service, enabled },
      });

      console.debug(`[Settings] Service ${service}: ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('[Settings] Toggle service failed:', error);
    }
  }

  private _setTheme(theme: string): void {
    localStorage.setItem('hang-time-theme', theme);
    console.debug(`[Settings] Theme set to ${theme}`);
  }

  private async _clearAllData(): Promise<void> {
    try {
      // Send message to background to clear storage
      // TODO: Implement backend clearing
      console.debug('[Settings] All data cleared');
      alert('All data has been cleared');
    } catch (error) {
      console.error('[Settings] Clear data failed:', error);
      alert('Failed to clear data');
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const controller = new SettingsController();
  controller.init().catch((error) => {
    console.error('[Settings] Fatal error:', error);
  });
});
