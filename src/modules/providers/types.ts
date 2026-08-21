/**
 * Hang Time - Video Provider Interface & Types
 * Defines the contract for platform-specific video providers
 */

import { ServiceName } from '../../types';

export interface VideoProvider {
  /** Service identifier matching Nostr activity service names */
  readonly serviceName: ServiceName;

  /** Checks if this provider handles the current URL */
  matches(url: URL): boolean;

  /** Validates if the page is currently on a playable/watchable video view (e.g. not a search or home page) */
  isValidWatchUrl(url: URL): boolean;

  /** Locates the primary video element for the platform (skipping ads if applicable) */
  findVideoElement(): HTMLVideoElement | null;

  /** Extracts the clean video title / content description */
  extractTitle(videoElement: HTMLVideoElement | null): string;

  /** Optional favicon URL or provider-specific badge */
  getFavicon?(): string | null;

  /** Optional hook called when a video element is hooked */
  onVideoHooked?(videoElement: HTMLVideoElement): void;

  /** Optional hook called when the hooked video is unmounted or emptied */
  onVideoUnmounted?(): void;
}
