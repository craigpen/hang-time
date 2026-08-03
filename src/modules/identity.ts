/**
 * Hang Time - Identity Manager
 * Generates and manages user's memorable identifier
 */

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { StorageManager } from './storage';
import { UserProfile, AuthError, DEFAULT_PUBLISHER_RATE_MS } from '../types';
import { deriveKeypairFromIdentifier } from './security-utils';

// Configure secp256k1 to use sha256 for signing
secp.hashes.sha256 = sha256;

export class IdentityManager {
  private identifierCache: string | null = null;

  constructor(private storage: StorageManager) {}

  /**
   * Get or create user's memorable identifier
   */
  async getIdentifier(): Promise<string> {
    // Return cached value if available
    if (this.identifierCache) {
      return this.identifierCache;
    }

    // Try to load from storage
    const profile = await this.storage.getUserProfile();
    if (profile?.memorable_identifier) {
      this.identifierCache = profile.memorable_identifier;

      // Migration: Enable join_suggestion for existing users (was disabled by default before)
      if (profile.notification_preferences?.join_suggestion === false) {
        console.debug('[Identity] Migrating user profile: enabling join_suggestion notifications');
        profile.notification_preferences.join_suggestion = true;
        await this.storage.setUserProfile(profile);
      }

      return profile.memorable_identifier;
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
      // Generate if not found (shouldn't happen after first init)
      await this.generateIdentifier();
      const updated = await this.storage.getUserProfile();
      if (!updated?.pubkey) {
        throw new Error('Failed to generate pubkey');
      }
      return updated.pubkey;
    }
    return profile.pubkey;
  }

  /**
   * Get user's Nostr secret key (hex format, for signing)
   */
  async getSecretKey(): Promise<string> {
    const profile = await this.storage.getUserProfile();
    if (!profile?.secret_key) {
      throw new Error('Secret key not found - user profile not initialized');
    }
    return profile.secret_key;
  }

  /**
   * Generate new memorable identifier
   * Uses memorable adjective + animal + random number pattern
   */
  async generateIdentifier(): Promise<string> {
    // Check if one already exists - never overwrite
    const existing = await this.storage.getUserProfile();
    if (existing?.memorable_identifier) {
      this.identifierCache = existing.memorable_identifier;
      return existing.memorable_identifier;
    }

    const identifier = this._createMemorableId();
    const { pubkey, secretKey } = deriveKeypairFromIdentifier(identifier);
    const now = Date.now();

    // Create new profile only if none exists
    const profile: UserProfile = {
      memorable_identifier: identifier,
      pubkey,
      secret_key: secretKey,
      created_at: now,
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
        relays: {
          'nos.lol': true,
          'nostr.mom': true,
          'relay.mostr.pub': true,
          'relay.primal.net': true,
        },
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
    const adjectives = [
      'Able',
      'Acidic',
      'Adorable',
      'Adventurous',
      'Affectionate',
      'Aged',
      'Aggressive',
      'Agreeable',
      'Ahead',
      'Airy',
      'Ajar',
      'Alert',
      'Aligned',
      'Alike',
      'Alive',
      'Alleged',
      'Alluring',
      'Aloof',
      'Alpine',
      'Altruistic',
      'Amazing',
      'Ambitious',
      'Amiable',
      'Amused',
      'Ancient',
      'Angelic',
      'Angry',
      'Animated',
      'Annual',
      'Anomalous',
      'Anonymous',
      'Antique',
      'Anxious',
      'Any',
      'Apart',
      'Apparent',
      'Appealing',
      'Apple',
      'Apprehensive',
      'Apt',
      'Arbitrary',
      'Arch',
      'Ardent',
      'Arduous',
      'Arid',
      'Aristocratic',
      'Arithmetic',
      'Armored',
      'Aromatic',
      'Aroused',
      'Arranged',
      'Arrogant',
      'Artistic',
      'Ascending',
      'Ashamed',
      'Ashy',
      'Asleep',
      'Aspiring',
      'Assorted',
      'Astonishing',
      'Astray',
      'Astro',
      'Athletic',
      'Atomic',
      'Atrocious',
      'Attached',
      'Attacked',
      'Attentive',
      'Attracting',
      'Attractive',
      'Audacious',
      'Authentic',
      'Authorized',
      'Automatic',
      'Autonomous',
      'Autumn',
      'Available',
      'Avaricious',
      'Average',
      'Averse',
      'Avid',
      'Awake',
      'Aware',
      'Away',
      'Awesome',
      'Awful',
      'Awkward',
      'Axial',
      'Axiological',
      'Azure',
    ];

    const animals = [
      'Aardvark',
      'Albatross',
      'Alligator',
      'Alpaca',
      'Anchovy',
      'Andean',
      'Anemone',
      'Angelfish',
      'Anglerfish',
      'Anhinga',
      'Anoa',
      'Ant',
      'Antelope',
      'Antlion',
      'Aoudad',
      'Ape',
      'Aphid',
      'Apostlebird',
      'Apparition',
      'Appleborer',
      'Applefly',
      'Appleworm',
      'Apricot',
      'Aptenodytes',
      'Aqualung',
      'Aquamarine',
      'Aquanaut',
      'Aquatica',
      'Aquatint',
      'Aquavit',
      'Aquifer',
      'Aquila',
      'Aquitaine',
      'Aracari',
      'Arachnid',
      'Arachnoid',
      'Arafura',
      'Aragonite',
      'Arapaima',
      'Aras',
      'Aratinga',
      'Araucaria',
      'Araujia',
      'Arb',
      'Arbalest',
      'Arba',
      'Arbiter',
      'Arbitrage',
      'Arbitral',
      'Arbitrament',
      'Arbitrarily',
      'Arbitrarily',
      'Arbitrariness',
      'Arbitrary',
      'Arbitrate',
      'Arbitrated',
      'Arbitrates',
      'Arbitration',
      'Arbitrative',
      'Arbitrator',
      'Arbitress',
      'Arbutus',
      'Arc',
      'Arcade',
      'Arcana',
      'Arcane',
      'Arcanum',
      'Arch',
      'Archae',
      'Archaeo',
      'Archaeol',
      'Archaeology',
      'Archaeopteryx',
      'Archaic',
      'Archaism',
      'Archaistic',
      'Archaistically',
      'Archaize',
      'Archaized',
      'Archaizes',
      'Archaizing',
      'Archaizing',
      'Archaeo',
      'Archangel',
      'Archbishop',
      'Archdeacon',
      'Archdemon',
      'Archduchess',
      'Archduchies',
      'Archduchy',
      'Archduke',
      'Archduke',
      'Archduke',
      'Arched',
      'Archegonial',
      'Archegoniate',
      'Archegoniates',
      'Archegonium',
      'Archelon',
      'Archer',
      'Archers',
      'Archery',
      'Arches',
      'Archespore',
      'Archesporial',
      'Archesporium',
      'Archetype',
      'Archetypally',
      'Archetypal',
      'Archetypical',
      'Archetypically',
      'Archetypic',
      'Archetypically',
      'Archfiend',
      'Archfiends',
      'Archfiends',
      'Archfiend',
      'Archfoes',
      'Archfoe',
      'Archfoe',
      'Archfriend',
      'Archfriend',
      'Archi',
      'Archicarp',
      'Archichlamydeous',
      'Archidiaconal',
      'Archidiaconate',
      'Archidiaconic',
      'Archidiaconis',
      'Archidiocese',
      'Archiepiscopal',
      'Archiepiscopally',
      'Archiepiscopate',
      'Archiepiscopates',
      'Archiereus',
      'Archigaster',
      'Archilochus',
      'Archilochian',
      'Archilochian',
      'Archilochist',
      'Archilochists',
      'Archilute',
      'Archilutes',
      'Archimage',
      'Archimandrite',
      'Archimandrites',
      'Archimedean',
      'Archimedean',
      'Archimedes',
      'Archimillionaire',
      'Archimime',
      'Archimimes',
      'Archimines',
      'Archimorula',
      'Archimorphae',
      'Archimorphic',
      'Archimorph',
      'Archimorphic',
      'Archimorphic',
      'Archimorphae',
      'Archimorph',
      'Archina',
      'Archinae',
      'Archinae',
      'Archinal',
      'Archine',
      'Archine',
      'Archines',
      'Archiny',
      'Archins',
      'Archins',
      'Archins',
      'Arching',
      'Archingly',
      'Archinings',
      'Archinings',
      'Archings',
      'Archings',
      'Archioctopus',
      'Archiostomy',
      'Archiparental',
      'Archiparents',
      'Archipallial',
      'Archipalliate',
      'Archipallium',
      'Archipal',
      'Archiparlor',
      'Archipartenocarpy',
      'Archiparthenocarpy',
      'Archiparthenocarpic',
      'Archipelvagos',
      'Archipellago',
      'Archipelago',
      'Archipelagos',
      'Archiplasm',
      'Archiplasmic',
      'Archiplast',
      'Archiplaster',
      'Archiplasty',
      'Archipleuralia',
      'Archipleure',
      'Archipleuridae',
      'Archipleural',
      'Archipleure',
      'Archipleure',
      'Archiplure',
      'Archipod',
      'Archipodal',
      'Archipompa',
      'Archipompa',
      'Archiporters',
      'Archipterygial',
      'Archipterygium',
      'Archipterygoid',
      'Archipterygoid',
      'Archipterygoidea',
      'Archipterygoidea',
      'Archipterygoidean',
      'Archipterous',
      'Archipterygium',
      'Archipterygoid',
      'Archipterygoidea',
      'Archipterygoidean',
      'Archipterous',
      'Archipterygium',
      'Archipterygoid',
      'Archiradula',
      'Archiradulae',
      'Archiradiulate',
      'Archiradula',
      'Archiradulate',
      'Archirallus',
      'Archiredera',
      'Archiredera',
      'Archiredera',
      'Archirepository',
      'Archiskeletal',
      'Archisneal',
      'Archisoma',
      'Archisomes',
      'Archisomatic',
      'Archisphere',
      'Archispheric',
      'Archisphery',
      'Archist',
      'Archistate',
      'Archistics',
      'Archistrategist',
      'Archistrategus',
      'Archistratum',
      'Architeuthis',
      'Architeuthis',
      'Architeuthidae',
      'Architeuthis',
      'Architrave',
      'Architraves',
      'Architect',
      'Architectess',
      'Architect',
      'Architectess',
      'Architects',
      'Architectonic',
      'Architectonical',
      'Architectonically',
      'Architectonici',
      'Architectonicism',
      'Architectonicness',
      'Architectonics',
      'Architectonics',
      'Architectonist',
      'Architectural',
      'Architecturally',
      'Architecturalism',
      'Architecturalist',
      'Architecture',
      'Architectured',
      'Architectures',
      'Architraves',
      'Architrave',
      'Architraves',
      'Architraved',
      'Architis',
      'Architrave',
      'Architrave',
      'Architraved',
      'Archivalia',
      'Archivalia',
      'Archivalia',
      'Archivalia',
      'Archivar',
      'Archivaria',
      'Archivaria',
      'Archivarian',
      'Archivarian',
      'Archivarially',
      'Archivariate',
      'Archivarium',
      'Archivary',
      'Archivar',
      'Archivaria',
      'Archivariate',
      'Archivarium',
      'Archivary',
      'Archive',
      'Archived',
      'Archiver',
      'Archivers',
      'Archives',
      'Archiveship',
      'Archivest',
      'Archivetta',
      'Archivette',
      'Archivian',
      'Archivial',
      'Archivian',
      'Archiviolic',
      'Archiviseship',
      'Archivist',
      'Archivistic',
      'Archivistic',
      'Archivistically',
      'Archivists',
      'Archivistical',
      'Archivity',
      'Archiving',
      'Archivism',
      'Archivism',
      'Archizoic',
      'Archly',
      'Archly',
      'Archlute',
      'Archlutenist',
      'Archlutes',
      'Archmagus',
      'Archmagus',
      'Archmajor',
      'Archmajorly',
      'Archmajoral',
      'Archmajorate',
      'Archmajored',
      'Archmajoring',
      'Archmajority',
      'Archmajorly',
      'Archmagus',
      'Archmagus',
      'Archmake',
      'Archmaker',
      'Archmakership',
      'Archmalice',
      'Archmalicious',
      'Archmaliciously',
      'Archmaliciousness',
      'Archmalignity',
      'Archmallus',
      'Archmallus',
      'Archmalus',
      'Archmalus',
      'Archmamma',
      'Archmandrake',
      'Archmandrite',
      'Archmandrites',
      'Archmandriteship',
      'Archmandritical',
      'Archmandritically',
      'Archmandritically',
      'Archmandritical',
      'Archmandritically',
      'Archmandrite',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
      'Archmandrite',
      'Archmandrake',
      'Archmandrate',
    ];

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
   */
  isValidIdentifier(identifier: string): boolean {
    // Should be non-empty string, no special chars except numbers
    return /^[a-zA-Z0-9]+$/.test(identifier) && identifier.length >= 10;
  }

  /**
   * Clear identifier (for testing)
   */
  async clearIdentifier(): Promise<void> {
    const profile = await this.storage.getUserProfile();
    if (profile) {
      const newProfile = { ...profile, memorable_identifier: '' };
      await this.storage.setUserProfile(newProfile);
      this.identifierCache = null;
    }
  }
}

// Singleton instance created on demand
export let identityManager: IdentityManager;

// Initialize singleton (called from background.ts)
export function initializeIdentityManager(storage: StorageManager): void {
  identityManager = new IdentityManager(storage);
}
