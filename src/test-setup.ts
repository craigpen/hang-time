/**
 * Hang Time - Test Setup
 * Mock chrome API for testing
 */

import { vi } from 'vitest';

// Mock chrome API
global.chrome = {
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
    },
  },
  runtime: {
    sendMessage: vi.fn(),
    getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
  },
  notifications: {
    create: vi.fn(),
    onButtonClicked: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    create: vi.fn(),
    query: vi.fn(),
  },
} as any;
