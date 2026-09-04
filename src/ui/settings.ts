/**
 * Hang Time - Settings UI Controller
 * Manages settings panel, configurations (Steam, Xbox, Discord, Relays), themes, and export/import
 */

import { Activity, DEFAULT_RELAY_URLS } from '../types';
import { StorageManager } from '../modules/storage';
import { GamesTabController } from './games';
import { toastManager } from './toast';

export class SettingsTabController {
  private storage: StorageManager;
  private settingsPanel: HTMLElement | null = null;
  private popupContainer: HTMLElement | null = null;
  private serviceIntegrationEnabled: Map<string, boolean> = new Map();
  private settingsListenersSetup: boolean = false;
  private getGamesTabController: () => GamesTabController | null;

  constructor(
    storage: StorageManager,
    options?: {
      settingsPanel?: HTMLElement | null;
      popupContainer?: HTMLElement | null;
      getGamesTabController?: () => GamesTabController | null;
    }
  ) {
    this.storage = storage;
    this.settingsPanel = options?.settingsPanel ?? document.getElementById('settings-panel');
    this.popupContainer = options?.popupContainer ?? document.getElementById('popup-container');
    this.getGamesTabController = options?.getGamesTabController ?? (() => null);
  }

  showSettingsPanel(): void {
    if (this.settingsPanel) {
      this.settingsPanel.style.display = 'block';
      document.body.classList.add('settings-open');
      this.resizePopupToFitSettings();
      // Always reload freshest saved values into settings panel inputs
      this.loadSettingsPanel().catch((err) => {
        console.debug('[Settings] Failed to reload settings panel on open:', err);
      });
    }
  }

  async hideSettingsPanel(): Promise<void> {
    if (this.settingsPanel) {
      // Save settings before closing
      await this.saveSettingsPanel();
      this.settingsPanel.style.display = 'none';
      document.body.classList.remove('settings-open');
      this.resizePopupToFitContent();
    }
  }

  resizePopupToFitSettings(): void {
    const body = document.body;
    body.style.minHeight = '600px';
    console.debug(`[Settings] Settings panel opened (min height: 600px)`);
  }

  resizePopupToFitContent(): void {
    const body = document.body;
    if (this.popupContainer) {
      const contentHeight = this.popupContainer.scrollHeight;
      body.style.minHeight = Math.max(100, contentHeight) + 'px';
      console.debug(`[Settings] Resized for content: ${contentHeight}px`);
    }
  }

  async updateIntegrationHealthDisplays(): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (!profile) return;

      const integrations = ['steam-api', 'xbox-api', 'discord-api'];
      for (const service of integrations) {
        const statusEl = document.getElementById(`status-${service}-popup`);
        if (!statusEl) continue;

        const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? true;
        if (!isEnabled) {
          statusEl.textContent = 'Disabled';
          statusEl.style.color = '';
          continue;
        }

        if (service === 'steam-api') {
          const health = await this.storage.getIntegrationHealth();
          const steamHealth = health['steam-api'];
          if (steamHealth) {
            const timeSinceLastPing = Date.now() - steamHealth.lastPing;
            const secondsAgo = Math.floor(timeSinceLastPing / 1000);
            const minutesAgo = Math.floor(timeSinceLastPing / (60 * 1000));
            const timeStr = secondsAgo < 60 ? `${secondsAgo}s ago` : `${minutesAgo}m ago`;
            const personaStr = steamHealth.personaname ? ` - ${steamHealth.personaname}` : '';

            if (steamHealth.alive) {
              statusEl.textContent = `✅ Active${personaStr} (${timeStr})`;
              statusEl.style.color = '#10b981';
            } else {
              statusEl.textContent = `⚠️ Unavailable${personaStr} (${timeStr})`;
              statusEl.style.color = '#ef4444';
            }
          } else if (profile.steam_config?.steam_id && profile.steam_config?.api_key) {
            statusEl.textContent = 'Configured, no activity';
            statusEl.style.color = '#10b981';
          } else {
            statusEl.textContent = 'Not configured';
            statusEl.style.color = 'var(--text-secondary)';
          }
        } else if (service === 'xbox-api') {
          if (profile.xbox_config?.api_key) {
            const gamertagStr = profile.xbox_config.gamertag ? ` - ${profile.xbox_config.gamertag}` : '';
            statusEl.textContent = `✅ Connected${gamertagStr}`;
            statusEl.style.color = '#10b981';
          } else {
            statusEl.textContent = 'Not configured';
            statusEl.style.color = 'var(--text-secondary)';
          }
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to update integration health displays:', error);
    }
  }

  async loadSettingsPanel(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      if (!response.success || !response.data) return;

      const profile = response.data;

      // Load identifier
      const idDisplay = document.getElementById('user-identifier-popup');
      if (idDisplay) {
        idDisplay.textContent = profile.uuid || profile.identifier || '';
      }

      // Load nickname
      const nicknameInput = document.getElementById('nickname-popup') as HTMLInputElement;
      if (nicknameInput && profile.nickname) {
        nicknameInput.value = profile.nickname;
      }

      // Load Discord info
      const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
      if (discordInput && profile.discord_info) {
        discordInput.value = profile.discord_info;
      }

      // Load Steam configuration
      const steamIdInput = document.getElementById('steam-id-popup') as HTMLInputElement;
      const steamApiKeyInput = document.getElementById('steam-api-key-popup') as HTMLInputElement;
      if (steamIdInput && profile.steam_config?.steam_id) {
        steamIdInput.value = profile.steam_config.steam_id;
      }
      if (steamApiKeyInput && profile.steam_config?.api_key) {
        steamApiKeyInput.value = profile.steam_config.api_key;
      }

      // Load Xbox configuration
      const xboxGamertagInput = document.getElementById('xbox-gamertag-popup') as HTMLInputElement;
      const xboxApiKeyInput = document.getElementById('xbox-api-key-popup') as HTMLInputElement;
      if (xboxGamertagInput && profile.xbox_config?.gamertag) {
        xboxGamertagInput.value = profile.xbox_config.gamertag;
      }
      if (xboxApiKeyInput && profile.xbox_config?.api_key) {
        xboxApiKeyInput.value = profile.xbox_config.api_key;
      }

      // Load service toggles for browser tabs
      const tabServices = ['youtube-tab', 'netflix-tab', 'video-tab'];
      for (const service of tabServices) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        if (toggle && profile.services_enabled) {
          toggle.checked = profile.services_enabled[service as keyof typeof profile.services_enabled] ?? false;
        }
      }

      // Load service toggles for OAuth / API integrations
      const oauthServices = ['steam-api', 'xbox-api', 'discord-api'];
      for (const service of oauthServices) {
        const toggle = document.getElementById(`service-${service}-enabled`) as HTMLInputElement;
        if (toggle) {
          const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? true;
          toggle.checked = isEnabled;
          this.serviceIntegrationEnabled.set(service, isEnabled);
        }
      }

      // Load notification preferences
      const notifFriendOnline = document.getElementById('notif-friend-online-popup') as HTMLInputElement;
      if (notifFriendOnline && profile.notification_preferences) {
        notifFriendOnline.checked = profile.notification_preferences.friend_online ?? true;
      }

      const notifNewMessage = document.getElementById('notif-new-message-popup') as HTMLInputElement;
      if (notifNewMessage && profile.notification_preferences) {
        notifNewMessage.checked = profile.notification_preferences.new_message ?? true;
      }

      const notifJoinSuggestion = document.getElementById('notif-join-suggestion-popup') as HTMLInputElement;
      if (notifJoinSuggestion && profile.notification_preferences) {
        notifJoinSuggestion.checked = profile.notification_preferences.join_suggestion ?? false;
      }

      // Load publisher config
      const pubConfig = profile.publisher_config || {
        enabled: true,
        size: 'full',
        scope: 'updates',
        rate_ms: 12000,
        relays: Object.fromEntries(DEFAULT_RELAY_URLS.map(url => [url.replace('wss://', '').replace('ws://', '').replace(/\/$/, ''), true])),
        retry_backoff_ms: 1000,
        compression: false,
        verbose_logging: false,
        delta_publishing: false,
      };

      const publisherEnabledToggle = document.getElementById('publisher-enabled-popup') as HTMLInputElement;
      if (publisherEnabledToggle) {
        publisherEnabledToggle.checked = pubConfig.enabled ?? true;
      }

      const publisherRateInput = document.getElementById('publisher-rate-popup') as HTMLInputElement;
      if (publisherRateInput) {
        const rateSeconds = Math.round((pubConfig.rate_ms || 12000) / 1000);
        publisherRateInput.value = rateSeconds.toString();
      }

      const lowBandwidthToggle = document.getElementById('low-bandwidth-mode-popup') as HTMLInputElement;
      if (lowBandwidthToggle) {
        lowBandwidthToggle.checked = pubConfig.low_bandwidth_mode ?? false;
      }

      // Load OAuth status
      await this.loadOAuthStatusInPanel();

      // Load game discovery setting
      const gameDiscoveryToggle = document.getElementById('game-discovery-enabled-popup') as HTMLInputElement;
      if (gameDiscoveryToggle) {
        gameDiscoveryToggle.checked = profile.game_discovery_enabled ?? false;
      }

      // Load appearance / theme setting
      const theme = profile.theme || localStorage.getItem('hang-time-theme') || 'auto';
      const themeRadio = document.querySelector(`input[name="theme-popup"][value="${theme}"]`) as HTMLInputElement;
      if (themeRadio) {
        themeRadio.checked = true;
      }
      this.setTheme(theme);

      // Update Steam & Xbox status after loading
      await this.updateIntegrationHealthDisplays();
      await this.updateServiceStatus('steam-api');
      await this.updateServiceStatus('xbox-api');

      // Add event listeners for settings panel
      this.setupSettingsPanelListeners();
    } catch (error) {
      console.error('[Settings] Failed to load settings panel:', error);
    }
  }

  async loadOAuthStatusInPanel(): Promise<void> {
    const oauthServices: string[] = [];
    for (const service of oauthServices) {
      try {
        console.debug(`[Settings] Loading OAuth status for ${service}`);
        const response = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });

        const container = document.getElementById(`${service}-auth-popup-container`);
        if (!container) continue;

        container.innerHTML = '';
        const hasToken = response.success && response.data?.hasToken;
        const statusText = hasToken ? 'Reconnect' : 'Connect';

        const connectBtn = document.createElement('button');
        connectBtn.className = 'btn-oauth';
        connectBtn.textContent = statusText;
        connectBtn.dataset['service'] = service;

        connectBtn.addEventListener('click', () => {
          this.authenticateServicePopup(service);
        });

        container.appendChild(connectBtn);

        if (hasToken) {
          const disconnectBtn = document.createElement('button');
          disconnectBtn.className = 'btn-oauth-secondary';
          disconnectBtn.textContent = 'Disconnect';
          disconnectBtn.addEventListener('click', () => this.disconnectServicePopup(service));
          container.appendChild(disconnectBtn);
        }

        await this.updateServiceStatus(service);
      } catch (error) {
        console.error(`[Settings] Failed to load ${service} status:`, error);
      }
    }
  }

  async loadBrowserStatusInPanel(): Promise<void> {
    try {
      const profileResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });
      const profile = profileResponse.success && profileResponse.data ? profileResponse.data : null;

      const response = await chrome.runtime.sendMessage({
        type: 'GET_BROWSER_ACTIVITIES',
      });

      const browserActivities = response.success && response.data ? response.data : { 'video-tab': null };

      for (const service of ['video-tab']) {
        const statusDiv = document.getElementById(`status-${service}-popup`);
        if (statusDiv && profile) {
          const isEnabled = profile.services_enabled?.[service as keyof typeof profile.services_enabled] ?? false;

          if (!isEnabled) {
            statusDiv.textContent = 'Disabled';
          } else {
            const activity = browserActivities[service as keyof typeof browserActivities];
            if (activity) {
              statusDiv.textContent = this.truncateActivityContent(activity.content);
            } else {
              statusDiv.textContent = 'Idle';
            }
          }
        }
      }
    } catch (error) {
      console.error('[Settings] Failed to load browser status:', error);
    }
  }

  setupSettingsPanelListeners(): void {
    if (this.settingsListenersSetup) return;
    this.settingsListenersSetup = true;

    // Copy identifier button
    const copyBtn = document.getElementById('copy-id-popup-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.handleCopyId());
    }

    // Service integration enable/disable checkboxes
    document.querySelectorAll('input.service-enable-toggle').forEach((toggle) => {
      if (toggle instanceof HTMLInputElement) {
        toggle.addEventListener('change', () => {
          const service = toggle.dataset['service'];
          if (service) {
            const isEnabled = toggle.checked;
            this.serviceIntegrationEnabled.set(service, isEnabled);
            this.saveSettingsPanel();
            this.updateServiceStatus(service);
          }
        });
      }
    });

    // Browser tab service toggles (Netflix/YouTube)
    document.querySelectorAll('input.service-toggle').forEach((toggle) => {
      if (toggle instanceof HTMLInputElement) {
        toggle.addEventListener('change', () => {
          this.saveSettingsPanel();
          this.loadBrowserStatusInPanel();
        });
      }
    });

    // Game discovery toggle
    const gameDiscoveryToggle = document.getElementById('game-discovery-enabled-popup') as HTMLInputElement;
    if (gameDiscoveryToggle) {
      gameDiscoveryToggle.addEventListener('change', async () => {
        const wasEnabled = this.storage ? (await this.storage.getUserProfile())?.game_discovery_enabled : false;
        const nowEnabled = gameDiscoveryToggle.checked;

        await this.saveSettingsPanel();

        if (!wasEnabled && nowEnabled) {
          console.debug('[Settings] Game discovery enabled - triggering immediate refresh');
          try {
            await chrome.runtime.sendMessage({
              type: 'REFRESH_GAME_LIBRARY',
            });
          } catch (error) {
            console.debug('[Settings] Game library refresh initiated');
          }
        } else if (!nowEnabled) {
          console.debug('[Settings] Game discovery disabled');
        }
      });
    }

    // Steam configuration inputs
    const steamIdInput = document.getElementById('steam-id-popup') as HTMLInputElement;
    const steamApiKeyInput = document.getElementById('steam-api-key-popup') as HTMLInputElement;
    const steamToggleVisibility = document.getElementById('steam-toggle-key-visibility') as HTMLButtonElement;

    if (steamIdInput) {
      steamIdInput.addEventListener('input', () => this.saveSettingsPanel());
      steamIdInput.addEventListener('change', () => this.saveSettingsPanel());
      steamIdInput.addEventListener('blur', () => this.saveSettingsPanel());
    }
    if (steamApiKeyInput) {
      steamApiKeyInput.addEventListener('input', () => this.saveSettingsPanel());
      steamApiKeyInput.addEventListener('change', () => this.saveSettingsPanel());
      steamApiKeyInput.addEventListener('blur', () => this.saveSettingsPanel());
    }
    if (steamToggleVisibility) {
      steamToggleVisibility.addEventListener('click', () => {
        if (steamApiKeyInput) {
          const isPassword = steamApiKeyInput.type === 'password';
          steamApiKeyInput.type = isPassword ? 'text' : 'password';
          const eyeOpen = steamToggleVisibility.querySelector('.eye-open-icon') as HTMLElement;
          const eyeClosed = steamToggleVisibility.querySelector('.eye-closed-icon') as HTMLElement;
          if (eyeOpen && eyeClosed) {
            eyeOpen.style.display = isPassword ? 'none' : 'block';
            eyeClosed.style.display = isPassword ? 'block' : 'none';
          }
        }
      });
    }

    // Steam Connect button
    const steamConnectBtn = document.getElementById('steam-connect-btn') as HTMLButtonElement;
    if (steamConnectBtn) {
      steamConnectBtn.addEventListener('click', () => this.handleSteamConnect());
    }

    // Xbox configuration inputs
    const xboxGamertagInput = document.getElementById('xbox-gamertag-popup') as HTMLInputElement;
    const xboxApiKeyInput = document.getElementById('xbox-api-key-popup') as HTMLInputElement;
    const xboxToggleVisibility = document.getElementById('xbox-toggle-key-visibility') as HTMLButtonElement;

    if (xboxGamertagInput) {
      xboxGamertagInput.addEventListener('input', () => this.saveSettingsPanel());
      xboxGamertagInput.addEventListener('change', () => this.saveSettingsPanel());
      xboxGamertagInput.addEventListener('blur', () => this.saveSettingsPanel());
    }
    if (xboxApiKeyInput) {
      xboxApiKeyInput.addEventListener('input', () => this.saveSettingsPanel());
      xboxApiKeyInput.addEventListener('change', () => this.saveSettingsPanel());
      xboxApiKeyInput.addEventListener('blur', () => this.saveSettingsPanel());
    }
    if (xboxToggleVisibility) {
      xboxToggleVisibility.addEventListener('click', () => {
        if (xboxApiKeyInput) {
          const isPassword = xboxApiKeyInput.type === 'password';
          xboxApiKeyInput.type = isPassword ? 'text' : 'password';
          const eyeOpen = xboxToggleVisibility.querySelector('.eye-open-icon') as HTMLElement;
          const eyeClosed = xboxToggleVisibility.querySelector('.eye-closed-icon') as HTMLElement;
          if (eyeOpen && eyeClosed) {
            eyeOpen.style.display = isPassword ? 'none' : 'block';
            eyeClosed.style.display = isPassword ? 'block' : 'none';
          }
        }
      });
    }

    // Xbox Connect button
    const xboxConnectBtn = document.getElementById('xbox-connect-btn') as HTMLButtonElement;
    if (xboxConnectBtn) {
      xboxConnectBtn.addEventListener('click', () => this.handleXboxConnect());
    }

    // Theme selector
    document.querySelectorAll('input[name="theme-popup"]').forEach((radio) => {
      radio.addEventListener('change', (e: Event) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        const theme = e.target.value;
        this.setTheme(theme);
        this.saveSettingsPanel();
      });
    });

    // Nickname input changes
    const nicknameInput = document.getElementById('nickname-popup') as HTMLInputElement;
    if (nicknameInput) {
      nicknameInput.addEventListener('input', () => this.saveSettingsPanel());
      nicknameInput.addEventListener('change', () => this.saveSettingsPanel());
      nicknameInput.addEventListener('blur', () => this.saveSettingsPanel());
    }

    // Discord input changes
    const discordInput = document.getElementById('discord-info-popup') as HTMLInputElement;
    if (discordInput) {
      discordInput.addEventListener('input', () => this.saveSettingsPanel());
      discordInput.addEventListener('change', () => this.saveSettingsPanel());
      discordInput.addEventListener('blur', () => this.saveSettingsPanel());
    }

    // Notification checkboxes
    document.querySelectorAll('input[id*="notif-"][id*="-popup"]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => this.saveSettingsPanel());
    });

    // Publisher config
    const publisherEnabledToggle = document.getElementById('publisher-enabled-popup') as HTMLInputElement;
    if (publisherEnabledToggle) {
      publisherEnabledToggle.addEventListener('change', () => this.saveSettingsPanel());
    }

    const publisherRateInput = document.getElementById('publisher-rate-popup') as HTMLInputElement;
    if (publisherRateInput) {
      publisherRateInput.addEventListener('change', () => this.saveSettingsPanel());
    }

    const lowBandwidthToggle = document.getElementById('low-bandwidth-mode-popup') as HTMLInputElement;
    if (lowBandwidthToggle) {
      lowBandwidthToggle.addEventListener('change', () => this.saveSettingsPanel());
    }

    // Export/Import buttons
    const exportBtn = document.getElementById('export-settings-popup-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportSettings());
    }

    const importInput = document.getElementById('import-settings-popup-input') as HTMLInputElement;
    if (importInput) {
      importInput.addEventListener('change', (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          this.importSettings(file);
        }
      });
    }
  }

  async handleSteamConnect(): Promise<void> {
    const steamIdInput = document.getElementById('steam-id-popup') as HTMLInputElement;
    const steamApiKeyInput = document.getElementById('steam-api-key-popup') as HTMLInputElement;
    const steamConnectBtn = document.getElementById('steam-connect-btn') as HTMLButtonElement;

    const steamId = steamIdInput?.value.trim() || '';
    const apiKey = steamApiKeyInput?.value.trim() || '';

    if (!steamId || !apiKey) {
      toastManager.showError('Please enter both Steam ID and Web API Key');
      return;
    }

    if (steamConnectBtn) {
      steamConnectBtn.disabled = true;
      steamConnectBtn.textContent = 'Connecting...';
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          steam_id: steamId,
          steam_api_key: apiKey,
        },
      });

      if (response.success) {
        toastManager.showSuccess('Steam connected! Fetching your library...');
        await this.updateServiceStatus('steam-api');
      } else {
        toastManager.showError(response.error || 'Failed to connect to Steam');
      }
    } catch (error) {
      toastManager.showError('Error connecting to Steam: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      if (steamConnectBtn) {
        steamConnectBtn.disabled = false;
        steamConnectBtn.textContent = 'Connect to Steam';
      }
    }
  }

  async handleXboxConnect(): Promise<void> {
    const xboxGamertagInput = document.getElementById('xbox-gamertag-popup') as HTMLInputElement;
    const xboxApiKeyInput = document.getElementById('xbox-api-key-popup') as HTMLInputElement;
    const xboxConnectBtn = document.getElementById('xbox-connect-btn') as HTMLButtonElement;

    const gamertag = xboxGamertagInput?.value.trim() || '';
    const apiKey = xboxApiKeyInput?.value.trim() || '';

    if (!apiKey) {
      toastManager.showError('Please enter your OpenXBL API Key');
      return;
    }

    if (xboxConnectBtn) {
      xboxConnectBtn.disabled = true;
      xboxConnectBtn.textContent = 'Connecting...';
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          xbox_gamertag: gamertag || undefined,
          xbox_api_key: apiKey,
          services_enabled: { 'xbox-api': true },
        },
      });

      if (response.success) {
        this.serviceIntegrationEnabled.set('xbox-api', true);
        const toggle = document.getElementById('service-xbox-api-enabled') as HTMLInputElement;
        if (toggle) toggle.checked = true;

        toastManager.showSuccess('Xbox connected! Fetching your library...');
        await this.updateIntegrationHealthDisplays();
        await this.updateServiceStatus('xbox-api');

        chrome.runtime.sendMessage({ type: 'REFRESH_GAME_LIBRARY' }).catch(() => {});
        const gamesTab = this.getGamesTabController();
        if (gamesTab) {
          gamesTab.render().catch(() => {});
        }
      } else {
        toastManager.showError(response.error || 'Failed to connect to Xbox');
      }
    } catch (error) {
      toastManager.showError('Error connecting to Xbox: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      if (xboxConnectBtn) {
        xboxConnectBtn.disabled = false;
        xboxConnectBtn.textContent = 'Connect to Xbox';
      }
    }
  }

  async authenticateServicePopup(service: string): Promise<void> {
    console.debug(`[Settings] Authenticating ${service}...`);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'AUTHENTICATE_SERVICE',
        data: { service },
      });

      if (response.success && response.data?.authUrl) {
        const authWindow = window.open(response.data.authUrl, `${service}-auth`, 'width=500,height=600');
        if (!authWindow) {
          alert('Popup window blocked. Please allow popups for this extension.');
          return;
        }

        const checkInterval = setInterval(() => {
          if (authWindow?.closed) {
            clearInterval(checkInterval);
            setTimeout(() => this.loadOAuthStatusInPanel(), 500);
          }
        }, 500);
      } else {
        alert(`Authentication failed: ${response.error}`);
      }
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async disconnectServicePopup(service: string): Promise<void> {
    if (!confirm(`Disconnect from ${service}?`)) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'DISCONNECT_SERVICE',
        data: { service },
      });

      if (response.success) {
        await this.loadOAuthStatusInPanel();
      }
    } catch (error) {
      console.error('[Settings] Disconnect failed:', error);
    }
  }

  setTheme(theme: string): void {
    localStorage.setItem('hang-time-theme', theme);
    const root = document.documentElement;
    if (theme === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }

  async updateServiceStatus(service: string): Promise<void> {
    const isEnabled = this.serviceIntegrationEnabled.get(service) ?? true;
    const statusDiv = document.getElementById(`status-${service}-popup`);
    if (!statusDiv) return;

    if (!isEnabled) {
      statusDiv.textContent = 'Disabled';
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CURRENT_ACTIVITY',
        data: { service },
      });

      if (response.success && response.data) {
        const activity = response.data as Activity;
        statusDiv.textContent = this.truncateActivityContent(activity.content);
        return;
      }
    } catch (error) {
      // Continue to check config
    }

    if (service === 'steam-api') {
      try {
        const health = await this.storage.getIntegrationHealth();
        const steamHealth = health['steam-api'];
        if (steamHealth) {
          const timeSinceLastPing = Date.now() - steamHealth.lastPing;
          const secondsAgo = Math.floor(timeSinceLastPing / 1000);
          const minutesAgo = Math.floor(timeSinceLastPing / (60 * 1000));
          const timeStr = secondsAgo < 60 ? `${secondsAgo}s ago` : `${minutesAgo}m ago`;

          if (steamHealth.alive) {
            statusDiv.textContent = `✅ Active (${timeStr})`;
            statusDiv.style.color = '#10b981';
          } else {
            statusDiv.textContent = `⚠️ Unavailable (${timeStr})`;
            statusDiv.style.color = '#ef4444';
          }
          return;
        }
      } catch (error) {
        console.error('[Settings] Failed to check Steam health:', error);
      }
    }

    let isConfigured = false;
    if (service === 'steam-api') {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_USER_IDENTIFIER',
        });
        const profile = response.data;
        isConfigured = !!(profile?.steam_config?.steam_id && profile?.steam_config?.api_key);
        if (!isConfigured) {
          statusDiv.textContent = 'Not configured';
          statusDiv.style.color = 'var(--text-secondary)';
        } else {
          statusDiv.textContent = 'Configured, no activity';
          statusDiv.style.color = 'var(--text-secondary)';
        }
        return;
      } catch (error) {
        console.error('[Settings] Failed to check Steam config:', error);
      }
    } else if (service === 'xbox-api') {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'GET_USER_IDENTIFIER',
        });
        const profile = response.data;
        isConfigured = !!(profile?.xbox_config?.api_key);
        if (!isConfigured) {
          statusDiv.textContent = 'Not configured';
          statusDiv.style.color = 'var(--text-secondary)';
        } else {
          statusDiv.textContent = 'Configured, no activity';
          statusDiv.style.color = '#10b981';
        }
        return;
      } catch (error) {
        console.error('[Settings] Failed to check Xbox config:', error);
      }
    } else if (['video-tab'].includes(service)) {
      statusDiv.textContent = 'No activity';
      return;
    } else {
      try {
        const authResponse = await chrome.runtime.sendMessage({
          type: 'GET_OAUTH_STATUS',
          data: { service },
        });
        isConfigured = authResponse.success && authResponse.data?.hasToken;
      } catch (error) {
        console.error(`[Settings] Failed to check ${service} OAuth status:`, error);
      }
    }

    if (!isConfigured) {
      statusDiv.textContent = 'Not configured';
    } else {
      statusDiv.textContent = 'No activity';
    }
  }

  async saveSettingsPanel(): Promise<void> {
    try {
      const nicknameInput = (document.getElementById('nickname-popup') as HTMLInputElement)?.value.trim() || '';
      const discordInput = (document.getElementById('discord-info-popup') as HTMLInputElement)?.value || '';
      const steamIdInput = (document.getElementById('steam-id-popup') as HTMLInputElement)?.value.trim() || '';
      const steamApiKeyInput = (document.getElementById('steam-api-key-popup') as HTMLInputElement)?.value.trim() || '';
      const xboxGamertagInput = (document.getElementById('xbox-gamertag-popup') as HTMLInputElement)?.value.trim() || '';
      const xboxApiKeyInput = (document.getElementById('xbox-api-key-popup') as HTMLInputElement)?.value.trim() || '';

      const servicesEnabled: Record<string, boolean> = {};
      const tabServices = ['youtube-tab', 'netflix-tab', 'video-tab'];
      for (const service of tabServices) {
        const toggle = document.getElementById(`service-${service}-popup`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      const oauthServices = ['steam-api', 'xbox-api', 'discord-api'];
      for (const service of oauthServices) {
        const toggle = document.getElementById(`service-${service}-enabled`) as HTMLInputElement;
        servicesEnabled[service] = toggle?.checked ?? false;
      }

      const notifFriendOnline = (document.getElementById('notif-friend-online-popup') as HTMLInputElement)?.checked ?? true;
      const notifNewMessage = (document.getElementById('notif-new-message-popup') as HTMLInputElement)?.checked ?? true;
      const notifJoinSuggestion = (document.getElementById('notif-join-suggestion-popup') as HTMLInputElement)?.checked ?? false;

      const publisherEnabled = (document.getElementById('publisher-enabled-popup') as HTMLInputElement)?.checked ?? true;
      const publisherRateInput = (document.getElementById('publisher-rate-popup') as HTMLInputElement)?.value || '12';
      const publisherRateSeconds = Math.max(5, Math.min(120, parseInt(publisherRateInput) || 12));
      const lowBandwidthMode = (document.getElementById('low-bandwidth-mode-popup') as HTMLInputElement)?.checked ?? false;

      const gameDiscoveryEnabled = (document.getElementById('game-discovery-enabled-popup') as HTMLInputElement)?.checked ?? false;

      const themeRadio = document.querySelector('input[name="theme-popup"]:checked') as HTMLInputElement;
      const theme = (themeRadio?.value as 'light' | 'dark' | 'auto') || 'auto';

      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        data: {
          nickname: nicknameInput || undefined,
          discord_info: discordInput,
          steam_id: steamIdInput || undefined,
          steam_api_key: steamApiKeyInput || undefined,
          xbox_gamertag: xboxGamertagInput || undefined,
          xbox_api_key: xboxApiKeyInput || undefined,
          services_enabled: servicesEnabled,
          notification_preferences: {
            friend_online: notifFriendOnline,
            new_message: notifNewMessage,
            join_suggestion: notifJoinSuggestion,
          },
          publisher_config: {
            enabled: publisherEnabled,
            rate_ms: publisherRateSeconds * 1000,
            low_bandwidth_mode: lowBandwidthMode,
          },
          game_discovery_enabled: gameDiscoveryEnabled,
          theme,
        },
      });

      console.debug('[Settings] Settings saved');
    } catch (error) {
      console.error('[Settings] Failed to save settings:', error);
    }
  }

  async exportSettings(): Promise<void> {
    try {
      const profileResponse = await chrome.runtime.sendMessage({
        type: 'GET_USER_IDENTIFIER',
      });

      const friendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_FRIENDS',
      });

      if (profileResponse.success && profileResponse.data) {
        const profile = profileResponse.data;
        const friends = friendsResponse.success ? friendsResponse.data : [];

        const backup = {
          version: '1.0',
          exported_at: new Date().toISOString(),
          data: {
            ...profile,
            friends: friends,
          },
        };

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `hang-time-backup-${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);

        console.debug('[Settings] Settings backed up');
      }
    } catch (error) {
      console.error('[Settings] Export failed:', error);
      alert('Failed to export settings');
    }
  }

  async importSettings(file: File): Promise<void> {
    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (!backup.data || !backup.data.identifier) {
        alert('Invalid backup file');
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: 'RESTORE_SETTINGS',
        data: backup,
      });

      if (response.success) {
        alert('Settings imported successfully');
        await this.loadSettingsPanel();
      } else {
        alert('Failed to import settings');
      }
    } catch (error) {
      console.error('[Settings] Import failed:', error);
      alert('Failed to parse settings file');
    }
  }

  handleCopyId(): void {
    const idDisplay = document.getElementById('user-identifier-popup');
    if (idDisplay && idDisplay.textContent && idDisplay.textContent !== 'Loading...') {
      navigator.clipboard.writeText(idDisplay.textContent).then(() => {
        console.debug('[Settings] Identifier copied');
        const copyBtn = document.getElementById('copy-id-popup-btn');
        if (copyBtn) {
          const originalHtml = copyBtn.innerHTML;
          copyBtn.textContent = '✓';
          setTimeout(() => {
            copyBtn.innerHTML = originalHtml;
          }, 2000);
        }
      });
    }
  }

  private truncateActivityContent(content: string): string {
    const maxLength = 25;
    return content.length > maxLength ? content.substring(0, maxLength) + '...' : content;
  }
}
