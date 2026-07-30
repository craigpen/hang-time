/**
 * Hang Time - Discovery Tab UI Controller
 * Manages the game discovery tab with filtering, sorting, and result display
 */

import { OwnedGame, GameMetadata, DiscoveryUIState, Friend } from '../types';
import { GameLibraryManager } from '../modules/game-library';
import { MetadataFetcher } from '../modules/metadata-fetcher';
import { StorageManager } from '../modules/storage';
import { showInviteModal } from './invite-modal-builder';

/**
 * Enriched game with metadata and friend owner count
 */
interface EnrichedGame extends OwnedGame {
  metadata?: GameMetadata;
  friendCount: number;
  friendNames: string[];
}

/**
 * Controls the Discovery tab UI
 */
export class DiscoveryTabController {
  private gameLibraryManager: GameLibraryManager;
  private metadataFetcher: MetadataFetcher;
  private storage: StorageManager;
  private popupElement: HTMLElement | null = null;
  private currentFilters: DiscoveryUIState['filters'] = {
    genres: [],
    modes: [],
    playtime: 'all',
  };
  private currentSort: DiscoveryUIState['sortBy'] = 'recent';
  private allFriends: Friend[] = [];
  private allGameMetadata: Map<number, GameMetadata> = new Map();
  private loading: boolean = false;

  constructor(
    popupElement: HTMLElement | null,
    gameLibraryManager: GameLibraryManager,
    metadataFetcher: MetadataFetcher,
    storage: StorageManager
  ) {
    this.popupElement = popupElement;
    this.gameLibraryManager = gameLibraryManager;
    this.metadataFetcher = metadataFetcher;
    this.storage = storage;
  }

  /**
   * Initialize the discovery tab controller
   */
  async init(): Promise<void> {
    console.debug('[Discovery] Initializing');

    // Load saved state
    await this._loadSavedState();

    // Setup event listeners
    this._setupEventListeners();

    console.debug('[Discovery] Initialization complete');
  }

  /**
   * Render the discovery tab
   */
  async render(): Promise<void> {
    console.debug('[Discovery] Rendering');

    if (!this.popupElement) {
      console.error('[Discovery] Popup element not found');
      return;
    }

    this.loading = true;
    this._showLoading();

    try {
      // Load all friends
      const friendsResponse = await chrome.runtime.sendMessage({
        type: 'GET_ALL_FRIENDS',
      });

      if (!friendsResponse.success || !friendsResponse.data) {
        this._showError('Failed to load friends');
        return;
      }

      this.allFriends = friendsResponse.data || [];
      console.debug(`[Discovery] Loaded ${this.allFriends.length} friends`);

      // Get user's game library
      const myGames = await this.gameLibraryManager.getMyGameLibrary();
      console.debug(`[Discovery] User owns ${myGames.length} games`);

      if (myGames.length === 0) {
        this._showEmpty('Configure Steam to discover games with friends');
        return;
      }

      // Fetch metadata for all owned games
      await this._fetchAllGameMetadata(myGames);

      // Build enriched games with friend counts
      const enrichedGames = await this._buildEnrichedGames(myGames);

      // Apply filters and sorting
      const filteredAndSorted = this._applyFiltersAndSort(enrichedGames);

      // Render result cards
      if (filteredAndSorted.length === 0) {
        this._showEmpty('No games match your filters');
      } else {
        this._renderResultCards(filteredAndSorted);
      }
    } catch (error) {
      console.error('[Discovery] Render error:', error);
      this._showError('Failed to load games');
    } finally {
      this.loading = false;
    }
  }

  /**
   * Force refresh all data
   */
  async refresh(): Promise<void> {
    console.debug('[Discovery] Refreshing');
    await this.render();
  }

  /**
   * Private: Load saved UI state from storage
   */
  private async _loadSavedState(): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      const saved = profile?.discovery_ui_state;

      if (saved) {
        this.currentFilters = saved.filters;
        this.currentSort = saved.sortBy;
        console.debug('[Discovery] Loaded saved state:', { filters: this.currentFilters, sort: this.currentSort });
      }
    } catch (error) {
      console.error('[Discovery] Failed to load saved state:', error);
    }
  }

  /**
   * Private: Save UI state to storage
   */
  private async _saveSavedState(): Promise<void> {
    try {
      const profile = await this.storage.getUserProfile();
      if (profile) {
        profile.discovery_ui_state = {
          filters: this.currentFilters,
          sortBy: this.currentSort,
        };
        await this.storage.setUserProfile(profile);
        console.debug('[Discovery] Saved UI state');
      }
    } catch (error) {
      console.error('[Discovery] Failed to save state:', error);
    }
  }

  /**
   * Private: Setup event listeners
   */
  private _setupEventListeners(): void {
    const filtersButton = document.getElementById('filters-button');
    const filtersPanel = document.getElementById('filters-panel');
    const applyButton = document.getElementById('apply-filters-btn');
    const clearButton = document.getElementById('clear-filters-btn');
    const sortDropdown = document.getElementById('sort-dropdown') as HTMLSelectElement;

    // Toggle filter panel
    if (filtersButton && filtersPanel) {
      filtersButton.addEventListener('click', () => {
        filtersPanel.classList.toggle('hidden');
      });
    }

    // Apply filters
    if (applyButton) {
      applyButton.addEventListener('click', async () => {
        this._handleApplyFilters();
        if (filtersPanel) {
          filtersPanel.classList.add('hidden');
        }
      });
    }

    // Clear filters
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        this._handleClearFilters();
      });
    }

    // Sort dropdown change
    if (sortDropdown) {
      sortDropdown.addEventListener('change', async () => {
        this.currentSort = sortDropdown.value as DiscoveryUIState['sortBy'];
        await this._saveSavedState();
        await this.render();
      });
    }

    // Set initial sort dropdown value
    if (sortDropdown) {
      sortDropdown.value = this.currentSort;
    }
  }

  /**
   * Private: Handle apply filters
   */
  private async _handleApplyFilters(): Promise<void> {
    const genres = Array.from(
      document.querySelectorAll('.genre-filter:checked') as NodeListOf<HTMLInputElement>
    ).map((el) => el.value);

    const modes = Array.from(
      document.querySelectorAll('.mode-filter:checked') as NodeListOf<HTMLInputElement>
    ).map((el) => el.value);

    const playtimeRadios = document.querySelector(
      '.playtime-filter:checked'
    ) as HTMLInputElement | null;
    const playtime = (playtimeRadios?.value || 'all') as DiscoveryUIState['filters']['playtime'];

    this.currentFilters = { genres, modes, playtime };
    await this._saveSavedState();
    this._updateFilterChips();
    await this.render();
  }

  /**
   * Private: Handle clear filters
   */
  private async _handleClearFilters(): Promise<void> {
    this.currentFilters = { genres: [], modes: [], playtime: 'all' };

    // Uncheck all checkboxes and radios
    document.querySelectorAll('.genre-filter, .mode-filter').forEach((el) => {
      (el as HTMLInputElement).checked = false;
    });

    const allPlaytimeRadios = document.querySelectorAll('.playtime-filter');
    allPlaytimeRadios.forEach((el, index) => {
      (el as HTMLInputElement).checked = index === 0; // Check first one (all)
    });

    await this._saveSavedState();
    this._updateFilterChips();
    await this.render();
  }

  /**
   * Private: Update filter chips display
   */
  private _updateFilterChips(): void {
    const chipsContainer = document.getElementById('active-filters');
    if (!chipsContainer) return;

    chipsContainer.innerHTML = '';

    const allFilters = [
      ...this.currentFilters.genres.map((g) => ({ type: 'genre', value: g })),
      ...this.currentFilters.modes.map((m) => ({ type: 'mode', value: m })),
      ...(this.currentFilters.playtime !== 'all' ? [{ type: 'playtime', value: this.currentFilters.playtime }] : []),
    ];

    for (const filter of allFilters) {
      const chip = document.createElement('div');
      chip.className = 'filter-chip';
      chip.innerHTML = `
        <span>${this._escapeHtml(filter.value)}</span>
        <button class="chip-remove" data-filter-type="${filter.type}" data-filter-value="${filter.value}">✕</button>
      `;

      const removeBtn = chip.querySelector('.chip-remove') as HTMLElement;
      removeBtn.addEventListener('click', async () => {
        await this._removeFilter(filter.type as any, filter.value);
      });

      chipsContainer.appendChild(chip);
    }
  }

  /**
   * Private: Remove individual filter
   */
  private async _removeFilter(filterType: 'genre' | 'mode' | 'playtime', value: string): Promise<void> {
    if (filterType === 'genre') {
      this.currentFilters.genres = this.currentFilters.genres.filter((g) => g !== value);
    } else if (filterType === 'mode') {
      this.currentFilters.modes = this.currentFilters.modes.filter((m) => m !== value);
    } else if (filterType === 'playtime') {
      this.currentFilters.playtime = 'all';
    }

    await this._saveSavedState();
    this._updateFilterChips();
    await this.render();
  }

  /**
   * Private: Load cached metadata for all games (background fetcher handles new fetches)
   */
  private async _fetchAllGameMetadata(games: OwnedGame[]): Promise<void> {
    console.debug(`[Discovery] Loading cached metadata for ${games.length} games`);

    this.allGameMetadata.clear();

    // Only load already-cached metadata; don't try to fetch on-demand
    // Background fetcher handles all fetches at 1.5 games/sec
    for (const game of games) {
      try {
        const cached = await this.metadataFetcher.getCachedMetadata(game.appId);
        if (cached) {
          this.allGameMetadata.set(game.appId, cached);
        }
      } catch (error) {
        // Silently skip games without cached metadata
        console.debug(`[Discovery] No cached metadata for appId ${game.appId}`);
      }
    }

    console.debug(`[Discovery] Loaded cached metadata for ${this.allGameMetadata.size}/${games.length} games`);
  }

  /**
   * Private: Build enriched games with friend ownership info
   */
  private async _buildEnrichedGames(myGames: OwnedGame[]): Promise<EnrichedGame[]> {
    const enriched: EnrichedGame[] = [];

    for (const game of myGames) {
      const metadata = this.allGameMetadata.get(game.appId);
      const friendsWithGame = await this._getFreindNamesWithGame(game.appId);

      enriched.push({
        ...game,
        metadata,
        friendCount: friendsWithGame.length,
        friendNames: friendsWithGame,
      });
    }

    return enriched;
  }

  /**
   * Private: Get friend names that own a specific game
   */
  private async _getFreindNamesWithGame(appId: number): Promise<string[]> {
    const friendNames: string[] = [];

    for (const friend of this.allFriends) {
      try {
        const friendGames = await this.gameLibraryManager.getFriendGameLibrary(friend.pubkey);
        if (friendGames && friendGames.some((game) => game.appId === appId)) {
          friendNames.push(friend.local_name);
        }
      } catch (error) {
        console.debug(`[Discovery] Failed to get library for friend ${friend.local_name}:`, error);
      }
    }

    return friendNames;
  }

  /**
   * Private: Apply filters and sorting
   */
  private _applyFiltersAndSort(games: EnrichedGame[]): EnrichedGame[] {
    let filtered = this._filterGames(games);
    return this._sortGames(filtered);
  }

  /**
   * Private: Filter games based on current filters
   */
  private _filterGames(games: EnrichedGame[]): EnrichedGame[] {
    return games.filter((game) => {
      // If any filters are active, require metadata to be present
      const hasActiveFilters = this.currentFilters.genres.length > 0 ||
                               this.currentFilters.modes.length > 0 ||
                               this.currentFilters.playtime !== 'all';

      if (hasActiveFilters && !game.metadata) {
        return false; // Hide games without metadata when filtering
      }

      // Filter by genres
      if (this.currentFilters.genres.length > 0 && game.metadata) {
        const hasGenre = this.currentFilters.genres.some((genre) =>
          game.metadata!.genres.some((g) => g.toLowerCase().includes(genre.toLowerCase()))
        );
        if (!hasGenre) return false;
      }

      // Filter by modes
      if (this.currentFilters.modes.length > 0 && game.metadata) {
        const hasMode = this.currentFilters.modes.some((mode) =>
          game.metadata!.categories.some((c) => c.toLowerCase().includes(mode.toLowerCase()))
        );
        if (!hasMode) return false;
      }

      // Filter by playtime (based on friend activity - Phase 7)
      // For now, just allow all

      return true;
    });
  }

  /**
   * Private: Sort games
   */
  private _sortGames(games: EnrichedGame[]): EnrichedGame[] {
    const sorted = [...games];

    // Default to 'recent' if no sort is selected
    const sortBy = this.currentSort || 'recent';

    switch (sortBy) {
      case 'most-friends':
        sorted.sort((a, b) => b.friendCount - a.friendCount);
        break;
      case 'score':
        sorted.sort((a, b) => {
          const scoreA = a.metadata?.metacriticScore || 0;
          const scoreB = b.metadata?.metacriticScore || 0;
          return scoreB - scoreA;
        });
        break;
      case 'recent':
        sorted.sort((a, b) => {
          const lastA = a.rtime_last_played || 0;
          const lastB = b.rtime_last_played || 0;
          return lastB - lastA; // Most recently played first
        });
        break;
      case 'alphabetical':
        sorted.sort((a, b) => {
          const nameA = a.metadata?.name || String(a.appId);
          const nameB = b.metadata?.name || String(b.appId);
          return nameA.localeCompare(nameB);
        });
        break;
    }

    return sorted;
  }

  /**
   * Private: Render result cards
   */
  private _renderResultCards(games: EnrichedGame[]): void {
    const resultsContainer = document.getElementById('game-results');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = '';

    for (const game of games) {
      const card = this._createGameCard(game);
      resultsContainer.appendChild(card);
    }
  }

  /**
   * Private: Create a game card element
   */
  private _createGameCard(game: EnrichedGame): HTMLElement {
    const card = document.createElement('div');
    card.className = 'game-card';

    const metadata = game.metadata;
    const gameName = metadata?.name || `Game ${game.appId}`;
    const imageUrl = metadata?.capsuleImageUrl || 'public/icons/steam.png';
    const storeUrl = metadata?.storePageUrl || `https://steampowered.com/app/${game.appId}`;
    const score = metadata?.metacriticScore || 0;
    const genres = metadata?.genres.slice(0, 2).join(', ') || 'Unknown';
    const modes = metadata?.categories.slice(0, 2).join(', ') || '';

    const friendNamesText =
      game.friendCount === 0
        ? 'No friends own this'
        : game.friendCount === 1
          ? `${game.friendNames[0]}`
          : game.friendCount <= 3
            ? game.friendNames.join(', ')
            : `${game.friendNames.slice(0, 3).join(', ')}, +${game.friendCount - 3} more`;

    const hasInvitableFriends = game.friendCount > 0;

    card.innerHTML = `
      <div class="game-card-inner">
        <img src="${this._escapeHtml(imageUrl)}" alt="${this._escapeHtml(gameName)}" class="game-card-image" onerror="this.src='public/icons/steam.png'">
        <div class="game-card-content">
          <div class="game-card-header">
            <a href="${this._escapeHtml(storeUrl)}" target="_blank" class="game-name">
              ${this._escapeHtml(gameName)}
            </a>
            ${score > 0 ? `<span class="game-score">⭐ ${score}/100</span>` : ''}
          </div>
          <div class="game-genres">
            <span>${this._escapeHtml(genres)}${modes ? ' • ' + this._escapeHtml(modes) : ''}</span>
          </div>
          <div class="game-friends">
            <span class="friends-count">Owned by:</span>
            <span class="friends-list">${this._escapeHtml(friendNamesText)}</span>
          </div>
        </div>
        <button class="game-card-invite-btn ${hasInvitableFriends ? '' : 'disabled'}" title="${hasInvitableFriends ? 'Invite friends to play' : 'No friends own this game'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="envelope-icon">
            <rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect>
            <path d="M 2 6 L 12 13 L 22 6"></path>
          </svg>
        </button>
      </div>
    `;

    // Add event listener for invite button
    const inviteBtn = card.querySelector('.game-card-invite-btn') as HTMLButtonElement;
    if (inviteBtn && hasInvitableFriends) {
      inviteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const friendsWhoOwn = this.allFriends.filter((friend) => game.friendNames.includes(friend.local_name));
        await showInviteModal(friendsWhoOwn, {
          title: gameName,
          onInvite: (friendIds) => this._sendInvitesToFriends(game, friendIds),
        });
      });
    }

    return card;
  }

  /**
   * Private: Show loading state
   */
  private _showLoading(): void {
    const resultsContainer = document.getElementById('game-results');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `
      <div class="loading-skeleton">
        <div style="text-align: center; padding: 40px 20px;">
          <div style="font-size: 24px; margin-bottom: 16px;">⏳</div>
          <p style="margin: 8px 0; font-size: 14px; font-weight: 500;">Building game cache...</p>
          <p style="margin: 4px 0; font-size: 12px; opacity: 0.7;">Fetching metadata for your games</p>
          <div style="margin-top: 16px;">
            <div style="display: inline-block; width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.3); border-top: 3px solid #4a9eff; border-radius: 50%; animation: spin 1s linear infinite;"></div>
          </div>
        </div>
        <style>
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </div>
    `;
  }

  /**
   * Private: Show empty state
   */
  private _showEmpty(message: string): void {
    const resultsContainer = document.getElementById('game-results');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `
      <div class="empty-state">
        <p>${this._escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Private: Show error state
   */
  private _showError(message: string): void {
    const resultsContainer = document.getElementById('game-results');
    if (!resultsContainer) return;

    resultsContainer.innerHTML = `
      <div class="error-state">
        <p>⚠️ ${this._escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Private: Escape HTML special characters
   */
  private _escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }

  /**
   * Private: Send invites to selected friends for a game
   */
  private async _sendInvitesToFriends(game: EnrichedGame, friendIds: string[]): Promise<void> {
    const gameName = game.metadata?.name || `Game ${game.appId}`;

    try {
      // Create activity from game data
      const activity = {
        id: `steam-game-${game.appId}`,
        service: 'steam-api' as const,
        content: gameName,
        url: `steam://run/${game.appId}/`,
        state: 'playing' as const,
        audio: 'on' as const,
        timestamp: Date.now(),
        freshness_timestamp: Date.now(),
        metadata: {
          appid: game.appId,
        },
      };

      // Send invites to each selected friend
      for (const friendId of friendIds) {
        await chrome.runtime.sendMessage({
          type: 'SEND_INVITE',
          data: { activity, friendId },
        });
      }

      this._showToast(`Invited ${friendIds.length} friend${friendIds.length !== 1 ? 's' : ''}`);
    } catch (error) {
      console.error('[Discovery] Failed to send invites:', error);
      this._showToast('Failed to send invites');
    }
  }

  /**
   * Private: Show toast notification
   */
  private _showToast(message: string, duration: number = 3000): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    const container = document.getElementById('toast-container') || document.body;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}
