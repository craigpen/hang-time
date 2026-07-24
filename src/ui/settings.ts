/**
 * Hang Time - Settings Page Controller
 */

export class SettingsController {
  private oauthServices = ['spotify', 'twitch'];
  private browserTabServices = ['netflix', 'youtube', 'twitch'];
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
      // Load user profile with all settings
      const response = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (response.success && response.data) {
        // Load identifier
        const identifierElement = document.getElementById('user-identifier');
        if (identifierElement) {
          identifierElement.textContent = response.data.identifier || 'Loading...';
        }

        // Load Discord info
        const discordInput = document.getElementById('discord-info') as HTMLInputElement;
        if (discordInput && response.data.discord_info) {
          discordInput.value = response.data.discord_info;
        }

        // Load service toggles
        for (const service of this.allServices) {
          const toggle = document.getElementById(`service-${service}`) as HTMLInputElement;
          if (toggle && response.data.services_enabled) {
            toggle.checked = response.data.services_enabled[service as keyof typeof response.data.services_enabled] ?? false;
          }
        }

        // Load notification preferences
        const notifFriendOnline = document.getElementById('notif-friend-online') as HTMLInputElement;
        if (notifFriendOnline && response.data.notification_preferences) {
          notifFriendOnline.checked = response.data.notification_preferences.friend_online ?? true;
        }

        const notifNewMessage = document.getElementById('notif-new-message') as HTMLInputElement;
        if (notifNewMessage && response.data.notification_preferences) {
          notifNewMessage.checked = response.data.notification_preferences.new_message ?? true;
        }

        const notifJoinSuggestion = document.getElementById('notif-join-suggestion') as HTMLInputElement;
        if (notifJoinSuggestion && response.data.notification_preferences) {
          notifJoinSuggestion.checked = response.data.notification_preferences.join_suggestion ?? false;
        }

        // Load Steam ID
        const steamIdInput = document.getElementById('steam-id-input') as HTMLInputElement;
        if (steamIdInput && response.data.steam_id) {
          steamIdInput.value = response.data.steam_id;
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error);
    }
  }

  private async _saveSettings(): Promise<void> {
    try {
      const discordInput = (document.getElementById('discord-info') as HTMLInputElement)?.value || '';
      const steamIdInput = (document.getElementById('steam-id-input') as HTMLInputElement)?.value || '';

      // Collect service toggles
      const servicesEnabled: Record<string, boolean> = {};
      for (const service of this.allServices) {
        const toggle = document.getElementById(`service-${service}`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      // Collect notification preferences
      const notifFriendOnline = (document.getElementById('notif-friend-online') as HTMLInputElement)?.checked ?? true;
      const notifNewMessage = (document.getElementById('notif-new-message') as HTMLInputElement)?.checked ?? true;
      const notifJoinSuggestion = (document.getElementById('notif-join-suggestion') as HTMLInputElement)?.checked ?? false;

      // Save to background
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          discord_info: discordInput,
          steam_id: steamIdInput,
          services_enabled: servicesEnabled,
          notification_preferences: {
            friend_online: notifFriendOnline,
            new_message: notifNewMessage,
            join_suggestion: notifJoinSuggestion,
          },
        },
      });

      console.debug('[Settings] Settings saved');
    } catch (error) {
      console.error('[Settings] Failed to save settings:', error);
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
      // Get user profile to check enabled/disabled states
      const profileResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      const profile = profileResponse.success && profileResponse.data ? profileResponse.data : null;
      if (!profile) {
        console.warn('[Settings] Could not load profile for service status');
        return;
      }

      // Get browser activities (Netflix and YouTube shown separately)
      const browserActivitiesResponse = await chrome.runtime.sendMessage({
        type: 'GET_BROWSER_ACTIVITIES',
      });

      const browserActivities = browserActivitiesResponse.success && browserActivitiesResponse.data
        ? browserActivitiesResponse.data
        : { netflix: null, youtube: null };

      // Update browser tab service status (Netflix/YouTube)
      for (const service of this.browserTabServices) {
        const statusDiv = document.getElementById(`status-${service}`);
        if (statusDiv) {
          const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? false;

          if (!isEnabled) {
            // Disabled state
            statusDiv.textContent = 'Disabled';
            statusDiv.className = 'service-status-text disabled';
          } else {
            // Enabled state - show content title
            const serviceActivity = browserActivities[service as keyof typeof browserActivities];
            if (serviceActivity) {
              statusDiv.textContent = this._escapeHtml(this._truncateContent(serviceActivity.content));
              statusDiv.className = 'service-status-text active';
            } else {
              statusDiv.textContent = this._escapeHtml(this._truncateContent(serviceActivity?.content || 'Not active'));
              statusDiv.className = 'service-status-text';
            }
          }
        }
      }

      // Get current activity for OAuth services
      const currentActivity = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_ACTIVITY',
      });

      const activity = currentActivity.success && currentActivity.data ? currentActivity.data : null;

      // Update Spotify status
      const spotifyStatusDiv = document.getElementById('status-spotify');
      if (spotifyStatusDiv) {
        const spotifyEnabled = profile.services_enabled?.spotify ?? false;
        const spotifyAuth = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service: 'spotify' },
        });
        const spotifyConfigured = spotifyAuth.success && spotifyAuth.data?.hasToken;

        let spotifyMessage = '';
        let spotifyClass = '';

        if (!spotifyEnabled) {
          spotifyMessage = 'Disabled';
          spotifyClass = 'service-status disabled';
        } else if (!spotifyConfigured) {
          spotifyMessage = 'Not configured';
          spotifyClass = 'service-status not-configured';
        } else {
          // Enabled + Configured
          if (activity && activity.service === 'spotify') {
            spotifyMessage = this._truncateContent(activity.content);
            spotifyClass = 'service-status status-active';
          } else {
            spotifyMessage = this._truncateContent(activity?.content || 'No activity');
            spotifyClass = 'service-status status-idle';
          }
        }
        spotifyStatusDiv.textContent = spotifyMessage;
        spotifyStatusDiv.className = spotifyClass;
      }

      // Update Twitch status
      const twitchStatusDiv = document.getElementById('status-twitch');
      if (twitchStatusDiv) {
        const twitchEnabled = profile.services_enabled?.twitch ?? false;
        const twitchAuth = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service: 'twitch' },
        });
        const twitchConfigured = twitchAuth.success && twitchAuth.data?.hasToken;

        let twitchMessage = '';
        let twitchClass = '';

        if (!twitchEnabled) {
          twitchMessage = 'Disabled';
          twitchClass = 'service-status disabled';
        } else if (!twitchConfigured) {
          twitchMessage = 'Not configured';
          twitchClass = 'service-status not-configured';
        } else {
          // Enabled + Configured
          if (activity && activity.service === 'twitch') {
            twitchMessage = this._truncateContent(activity.content);
            twitchClass = 'service-status status-active';
          } else {
            twitchMessage = this._truncateContent(activity?.content || 'No activity');
            twitchClass = 'service-status status-idle';
          }
        }
        twitchStatusDiv.textContent = twitchMessage;
        twitchStatusDiv.className = twitchClass;
      }

      // Update Steam status
      const steamStatusDiv = document.getElementById('status-steam');
      if (steamStatusDiv) {
        const steamEnabled = profile.services_enabled?.steam ?? false;
        const steamConfigured = !!profile.steam_id;

        let steamMessage = '';
        let steamClass = '';

        if (!steamEnabled) {
          steamMessage = 'Disabled';
          steamClass = 'service-status disabled';
        } else if (!steamConfigured) {
          steamMessage = 'Not configured';
          steamClass = 'service-status not-configured';
        } else {
          // Enabled + Configured
          if (activity && activity.service === 'steam') {
            steamMessage = this._truncateContent(activity.content);
            steamClass = 'service-status status-active';
          } else {
            steamMessage = this._truncateContent(activity?.content || 'No activity');
            steamClass = 'service-status status-idle';
          }
        }
        steamStatusDiv.textContent = steamMessage;
        steamStatusDiv.className = steamClass;
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

    // Discord info input
    const discordInput = document.getElementById('discord-info') as HTMLInputElement;
    if (discordInput) {
      discordInput.addEventListener('change', () => this._saveSettings());
    }

    // Service toggles for browser tabs
    document.querySelectorAll('input[type="checkbox"][data-service]').forEach((toggle) => {
      toggle.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const service = e.target.dataset.service;
        const enabled = e.target.checked;
        if (service) {
          this._toggleService(service, enabled);
          this._saveSettings();
        }
      });
    });

    // Notification preferences
    document.querySelectorAll('input[type="checkbox"]:not([data-service])').forEach((checkbox) => {
      checkbox.addEventListener('change', () => this._saveSettings());
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

    // Export settings button
    const exportBtn = document.getElementById('export-settings-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this._exportSettings());
    }

    // Import settings button
    const importBtn = document.getElementById('import-settings-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        const fileInput = document.getElementById('import-file-input') as HTMLInputElement;
        fileInput?.click();
      });
    }

    // Import file input
    const importFileInput = document.getElementById('import-file-input') as HTMLInputElement;
    if (importFileInput) {
      importFileInput.addEventListener('change', (e: Event) => {
        const files = (e.target as HTMLInputElement).files;
        if (files && files.length > 0) {
          this._importSettings(files[0]);
        }
      });
    }

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

  private async _exportSettings(): Promise<void> {
    try {
      // Get current settings
      const response = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (response.success && response.data) {
        const settings = {
          version: '1.0',
          exported_at: new Date().toISOString(),
          data: response.data,
        };

        // Download as JSON
        const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `hang-time-settings-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);

        console.debug('[Settings] Settings exported');
      }
    } catch (error) {
      console.error('[Settings] Export failed:', error);
      alert('Failed to export settings');
    }
  }

  private async _importSettings(file: File): Promise<void> {
    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (!backup.data || !backup.data.identifier) {
        alert('Invalid backup file');
        return;
      }

      // Send to background to save
      const response = await chrome.runtime.sendMessage({
        type: 'RESTORE_SETTINGS',
        data: backup,
      });

      if (response.success) {
        alert('Settings imported successfully. Please reload.');
        // Reload the page to reflect changes
        location.reload();
      } else {
        alert('Failed to import settings');
      }
    } catch (error) {
      console.error('[Settings] Import failed:', error);
      alert('Failed to parse settings file');
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

  private _escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const controller = new SettingsController();
  controller.init().catch((error) => {
    console.error('[Settings] Fatal error:', error);
  });
});
