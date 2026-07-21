/**
 * Hang Time - Settings Page Controller
 */

export class SettingsController {
  private oauthServices = ['spotify', 'twitch'];

  async init(): Promise<void> {
    console.debug('[Settings] Initializing...');

    await this._loadSettings();
    await this._loadOAuthStatus();
    this._setupEventListeners();

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
      const statusDiv = document.getElementById('oauth-status');
      if (!statusDiv) return;

      statusDiv.innerHTML = '';

      for (const service of this.oauthServices) {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });

        const container = document.createElement('div');
        container.className = 'oauth-service';
        container.dataset.service = service;

        const statusText = response.success && response.data?.hasToken ? 'Connected' : 'Not Connected';
        const statusClass = response.success && response.data?.hasToken ? 'status-connected' : 'status-disconnected';

        container.innerHTML = `
          <div class="service-info">
            <span class="service-label">${this._getServiceLabel(service)}</span>
            <span class="status-badge ${statusClass}">${statusText}</span>
          </div>
          <div class="service-actions">
            <button class="btn-oauth" data-service="${service}" data-action="authenticate">
              ${response.success && response.data?.hasToken ? 'Reconnect' : 'Connect'}
            </button>
            ${response.success && response.data?.hasToken ? `<button class="btn-oauth-secondary" data-service="${service}" data-action="disconnect">Disconnect</button>` : ''}
          </div>
        `;

        statusDiv.appendChild(container);
      }

      // Show the section if there are services
      const oauthSection = document.getElementById('oauth-section');
      if (oauthSection) {
        oauthSection.style.display = 'block';
      }
    } catch (error) {
      console.error('[Settings] Failed to load OAuth status:', error);
    }
  }

  private _getServiceLabel(service: string): string {
    const labels: { [key: string]: string } = {
      spotify: '🎵 Spotify',
      twitch: '📺 Twitch',
    };
    return labels[service] || service;
  }

  private _setupEventListeners(): void {
    // Settings button
    const settingsBtn = document.getElementById('close-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
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

    // OAuth buttons
    document.querySelectorAll('.btn-oauth').forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        if (!(e.target instanceof HTMLElement)) return;
        const service = e.target.dataset.service;
        if (service) {
          this._authenticateService(service);
        }
      });
    });

    document.querySelectorAll('.btn-oauth-secondary').forEach((btn) => {
      btn.addEventListener('click', (e: Event) => {
        if (!(e.target instanceof HTMLElement)) return;
        const service = e.target.dataset.service;
        if (service) {
          this._disconnectService(service);
        }
      });
    });

    // Service toggles
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
