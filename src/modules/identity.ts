/**
 * Hang Time - Identity Manager
 * Generates and manages user's memorable identifier
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { StorageManager } from './storage';
import { UserProfile, DEFAULT_PUBLISHER_RATE_MS, DEFAULT_RELAY_URLS } from '../types';
import { deriveKeypairFromIdentifier } from './security-utils';

// Configure secp256k1 to use sha256 for signing
secp.hashes.sha256 = sha256;

export class IdentityManager {
  private identifierCache: string | null = null;

  constructor(private storage: StorageManager) {}

  /**
   * Get user's memorable identifier
   * Generates new one if not found
   */
  async getIdentifier(): Promise<string> {
    if (this.identifierCache) {
      return this.identifierCache;
    }

    const profile = await this.storage.getUserProfile();
    if (profile?.uuid) {
      this.identifierCache = profile.uuid;

      // Migration: Ensure join_suggestion notification preference is enabled for existing users
      if (profile.notification_preferences?.join_suggestion === false) {
        console.debug('[Identity] Migrating user profile: enabling join_suggestion notifications');
        profile.notification_preferences.join_suggestion = true;
        await this.storage.setUserProfile(profile);
      }

      // Migration: Add missing new_message notification preference
      if (profile.notification_preferences && (profile.notification_preferences as any).new_message === undefined) {
        console.debug('[Identity] Migrating user profile: adding new_message notification preference');
        profile.notification_preferences.new_message = true;
        await this.storage.setUserProfile(profile);
      }

      return profile.uuid;
    }

    // Generate new if not found
    return this.generateIdentifier();
  }

  /**
   * Get user's Nostr public key (hex format)
   */
  async getPubkey(): Promise<string> {
    const profile = await this.storage.getUserProfile();
    if (!profile?.pubkey) {
      // Trigger generation
      await this.getIdentifier();
      const updated = await this.storage.getUserProfile();
      return updated!.pubkey;
    }
    return profile.pubkey;
  }

  /**
   * Get user's Nostr secret key (hex format)
   * Internal method for signing operations
   */
  async getSecretKey(): Promise<string> {
    const profile = await this.storage.getUserProfile();
    if (!profile?.secret_key) {
      // Trigger generation
      await this.getIdentifier();
      const updated = await this.storage.getUserProfile();
      return updated!.secret_key;
    }
    return profile.secret_key;
  }

  /**
   * Generate a new memorable identifier and derive Nostr keys
   * Deterministic: secret key = SHA-256(identifier), pubkey = Schnorr(secret key)
   */
  async generateIdentifier(): Promise<string> {
    const identifier = this._createMemorableId();
    const { pubkey, secretKey } = deriveKeypairFromIdentifier(identifier);

    const profile: UserProfile = {
      uuid: identifier,
      pubkey,
      secret_key: secretKey,
      created_at: Date.now(),
      services_enabled: {
        'spotify-api': false,
        'twitch-api': false,
        'steam-api': false,
        'discord-api': false,
        'youtube-tab': true,
        'netflix-tab': true,
        'twitch-tab': true,
        'video-tab': true,
      },
      notification_preferences: {
        friend_online: true,
        new_message: true,
        join_suggestion: true,
      },
      publisher_config: {
        enabled: true,
        size: 'atomic',
        scope: 'updates',
        rate_ms: DEFAULT_PUBLISHER_RATE_MS,
        relays: Object.fromEntries(DEFAULT_RELAY_URLS.map(url => [url.replace('wss://', '').replace('ws://', '').replace(/\/$/, ''), true])),
        retry_backoff_ms: 1000,
        compression: false,
        verbose_logging: false,
        delta_publishing: false,
      },
    };

    await this.storage.setUserProfile(profile);
    this.identifierCache = identifier;

    console.debug('[Identity] Generated identifier:', identifier);
    return identifier;
  }


  /**
   * Create a memorable identifier using adjective + animal + number
   * Examples: VascillatingMonkeyCough, TangibleElephantSneeze, etc.
   */
  private _createMemorableId(): string {
    // Use 4 words from different categories for strong collision resistance
    const descriptors = [
      'luminous', 'wandering', 'vibrant', 'silver', 'golden', 'crimson', 'azure', 'emerald',
      'scarlet', 'violet', 'bronze', 'copper', 'crystal', 'frozen', 'blazing', 'serene',
      'dancing', 'sleeping', 'soaring', 'diving', 'climbing', 'flowing', 'rushing', 'gentle',
      'mighty', 'tender', 'ancient', 'modern', 'distant', 'hidden', 'bright', 'dark',
      'swift', 'slow', 'bold', 'shy', 'wild', 'tame', 'deep', 'shallow',
      'vast', 'tiny', 'warm', 'cool', 'dry', 'wet', 'thick', 'thin',
      'smooth', 'rough', 'soft', 'hard', 'quiet', 'loud', 'fast', 'slow',
      'heavy', 'light', 'full', 'empty', 'rich', 'poor', 'strong', 'weak',
    ];

    const elements = [
      'mountain', 'river', 'ocean', 'forest', 'desert', 'glacier', 'volcano', 'canyon',
      'valley', 'plateau', 'island', 'coast', 'lake', 'storm', 'sunset', 'sunrise',
      'meadow', 'garden', 'grove', 'cliff', 'peak', 'summit', 'ridge', 'slope',
      'stream', 'waterfall', 'spring', 'cave', 'grotto', 'bridge', 'tower', 'temple',
      'stone', 'sand', 'soil', 'tree', 'flower', 'grass', 'herb', 'vine',
      'cloud', 'wind', 'rain', 'snow', 'frost', 'mist', 'shadow', 'light',
      'fire', 'water', 'earth', 'air', 'sky', 'star', 'moon', 'sun',
    ];

    const creatures = [
      'penguin', 'eagle', 'dolphin', 'whale', 'bear', 'wolf', 'fox', 'deer',
      'rabbit', 'squirrel', 'owl', 'raven', 'swan', 'crane', 'heron', 'kingfisher',
      'butterfly', 'dragonfly', 'bee', 'ant', 'spider', 'beetle', 'moth', 'cricket',
      'salmon', 'trout', 'pike', 'perch', 'shark', 'ray', 'octopus', 'squid',
      'lion', 'tiger', 'leopard', 'cheetah', 'panther', 'cougar', 'puma', 'jaguar',
      'otter', 'seal', 'walrus', 'manatee', 'dugong', 'badger', 'meerkat', 'mongoose',
      'peacock', 'pheasant', 'partridge', 'quail', 'ibis', 'flamingo', 'stork', 'pelican',
    ];

    const objects = [
      'crystal', 'lighthouse', 'compass', 'anchor', 'lantern', 'prism', 'mirror', 'lens',
      'shell', 'pearl', 'gem', 'jewel', 'coin', 'key', 'lock', 'chest',
      'bell', 'chime', 'gong', 'harp', 'lute', 'flute', 'drum', 'horn',
      'candle', 'torch', 'ember', 'spark', 'flame', 'coal', 'dust', 'ash',
      'feather', 'quill', 'brush', 'thread', 'needle', 'knot', 'rope', 'net',
      'sail', 'mast', 'hull', 'deck', 'bow', 'stern', 'anchor', 'helm',
      'dagger', 'sword', 'shield', 'arrow', 'bow', 'spear', 'lance', 'staff',
    ];

    const desc = descriptors[Math.floor(Math.random() * descriptors.length)];
    const elem = elements[Math.floor(Math.random() * elements.length)];
    const creature = creatures[Math.floor(Math.random() * creatures.length)];
    const obj = objects[Math.floor(Math.random() * objects.length)];

    return `${desc}-${elem}-${creature}-${obj}`;
  }

  /**
   * Verify identifier is valid
   * Supports 4-word hyphenated identifiers (e.g. word-word-word-word) and legacy alphanumeric IDs
   */
  isValidIdentifier(identifier: string): boolean {
    if (!identifier || typeof identifier !== 'string' || identifier.length < 10) {
      return false;
    }
    // Allow hyphenated word identifiers or alphanumeric identifiers
    return /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(identifier);
  }

  /**
   * Clear identifier (for testing)
   */
  async clearIdentifier(): Promise<void> {
    const profile = await this.storage.getUserProfile();
    if (profile) {
      const newProfile = { ...profile, uuid: '' };
      await this.storage.setUserProfile(newProfile);
      this.identifierCache = null;
    }
  }
}

// Singleton instance created on demand
let identityManager: IdentityManager | undefined;

// Initialize singleton (called from background.ts)
export function initializeIdentityManager(storage: StorageManager): void {
  identityManager = new IdentityManager(storage);
}

// Safe getter - throws if not initialized (consistent with other managers)
export function getIdentityManager(): IdentityManager {
  if (!identityManager) {
    throw new Error('IdentityManager not initialized');
  }
  return identityManager;
}
