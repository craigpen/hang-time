// playwright.config.js — end-to-end suite for the Hang Time extension.
//
// The suite drives the *built* extension in dist/chrome-mv3, so run
// `npm run build:chrome` first (the `test:e2e` script does this for you).
//
// Browser support: Chromium-family only. Playwright cannot install a
// WebExtension into Firefox, so the Firefox MV3 build is verified structurally
// in tests/e2e/06-cross-browser.spec.js rather than by launching it.

import { defineConfig } from "@playwright/test";

const CROSS_BROWSER_SPEC = /06-cross-browser\.spec\.js/;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.js",

  // Extension tests each boot their own persistent browser profile; three
  // concurrent profiles is a good balance on a normal dev machine and in CI.
  workers: process.env.CI ? 3 : 3,
  fullyParallel: true,

  timeout: 30_000,
  expect: { timeout: 10_000 },

  // Zero retries on purpose: a flaky extension test is a bug worth seeing.
  retries: 0,

  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }], ["github"]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],

  outputDir: "test-results",

  use: {
    // Extensions need a real (non-headless-shell) browser; the fixtures pass
    // `channel` through to launchPersistentContext.
    headless: process.env.HEADED ? false : true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 15_000
  },

  projects: [
    // If CHROME_DEBUG_PORT is set, connect to an existing Chrome instance
    // (useful for testing against your already-running Chrome with the extension loaded).
    // Usage: CHROME_DEBUG_PORT=9222 npm run test:e2e
    ...(process.env.CHROME_DEBUG_PORT
      ? [
          {
            name: "chrome-connected",
            use: {
              connectOverCDP: `http://127.0.0.1:${process.env.CHROME_DEBUG_PORT}`
            }
          }
        ]
      : [
          {
            // Primary project: the whole suite against bundled Chromium.
            name: "chromium",
            use: { channel: "chromium" }
          },
          {
            // Cross-browser smoke only — stock Google Chrome.
            name: "chrome",
            testMatch: CROSS_BROWSER_SPEC,
            use: { channel: "chrome" }
          },
          {
            // Cross-browser smoke only — Microsoft Edge.
            name: "edge",
            testMatch: CROSS_BROWSER_SPEC,
            use: { channel: "msedge" }
          }
        ])
  ]
});
