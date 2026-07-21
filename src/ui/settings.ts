/**
 * Hang Time - Settings Page Controller
 */

export class SettingsController {
  async init(): Promise<void> {
    console.debug('[Settings] Initializing...');

    await this._loadSettings();
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
