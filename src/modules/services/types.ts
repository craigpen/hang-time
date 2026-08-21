/**
 * Hang Time - Service Module Types & Interfaces
 */

import { Activity } from '../../types';

export interface IServiceModule {
  // Inherited from types.ts - all services must implement this interface
  isEnabled(): Promise<boolean>;
  getCurrentActivity(): Promise<Activity | null>;
  hasToken(): Promise<boolean>;
  clearToken(): Promise<void>;
  getAuthUrl(): Promise<string>;
  handleAuthCallback(code: string): Promise<void>;
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  hasAuth: boolean;
}
