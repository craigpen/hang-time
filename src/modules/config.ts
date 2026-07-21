/**
 * Hang Time - Secure Configuration Manager
 * Handles OAuth credentials and secrets securely
 * Credentials should be set via environment variables or secure config endpoints
 */

export interface OAuthConfig {
  spotify: {
    client_id: string;
    client_secret: string;
  };
  twitch: {
    client_id: string;
    client_secret: string;
  };
}

class ConfigManager {
  private config: OAuthConfig | null = null;

  /**
   * Load configuration from environment or secure source
   * DO NOT hardcode credentials in source code
   */
  async loadConfig(): Promise<OAuthConfig> {
    if (this.config) {
      return this.config;
    }

    // Try to load from chrome storage (admin set this up)
    const stored = await chrome.storage.local.get('oauth_config');
    if (stored.oauth_config) {
      this.config = stored.oauth_config;
      return this.config;
    }

    // If not found, throw error with clear instructions
    throw new Error(
      'OAuth configuration not found. ' +
      'Administrator must configure credentials via: ' +
      'chrome.storage.local.set({ oauth_config: { spotify: {...}, twitch: {...} } })'
    );
  }

  /**
   * Get Spotify OAuth configuration
   */
  async getSpotifyConfig(): Promise<OAuthConfig['spotify']> {
    const config = await this.loadConfig();
    if (!config.spotify?.client_id) {
      throw new Error('Spotify OAuth not configured');
    }
    return config.spotify;
  }

  /**
   * Get Twitch OAuth configuration
   */
  async getTwitchConfig(): Promise<OAuthConfig['twitch']> {
    const config = await this.loadConfig();
    if (!config.twitch?.client_id) {
      throw new Error('Twitch OAuth not configured');
    }
    return config.twitch;
  }

  /**
   * Verify configuration is valid (for admin setup)
   */
  async validateConfig(config: OAuthConfig): Promise<boolean> {
    if (!config.spotify?.client_id || !config.spotify?.client_secret) {
      throw new Error('Invalid Spotify configuration');
    }
    if (!config.twitch?.client_id || !config.twitch?.client_secret) {
      throw new Error('Invalid Twitch configuration');
    }
    return true;
  }

  /**
   * For testing: set config programmatically (admin only)
   */
  async setConfig(config: OAuthConfig): Promise<void> {
    await this.validateConfig(config);
    await chrome.storage.local.set({ oauth_config: config });
    this.config = config;
  }

  /**
   * Clear configuration (for logout/reset)
   */
  async clearConfig(): Promise<void> {
    await chrome.storage.local.remove('oauth_config');
    this.config = null;
  }
}

export const configManager = new ConfigManager();
