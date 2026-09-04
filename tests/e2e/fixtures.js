/**
 * fixtures.js — Playwright fixtures for the Hang Time extension.
 *
 * Provides:
 *   context      — a persistent Chromium context with the unpacked extension loaded
 *   extensionId  — the runtime id of the loaded extension
 *   serviceWorker— the MV3 background service worker (for white-box assertions)
 *   popupPage    — popup.html opened as a tab, ready to drive
 *   ext          — a small API for seeding/reading extension state
 *
 * NOTE ON LANGUAGE: this repo is vanilla CommonJS JavaScript with no TypeScript
 * toolchain, so the helpers are `.js` rather than `.ts`. Playwright loads them
 * identically; JSDoc gives editors the same autocomplete.
 *
 * NOTE ON BROWSERS: Chromium-family only. Playwright cannot load a WebExtension
 * into Firefox, so the Firefox build is verified structurally instead
 * (see 06-cross-browser.spec.js).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { test: base, chromium, expect } = require("@playwright/test");

const REPO_ROOT = path.join(__dirname, "..", "..");
const EXTENSION_PATH = path.join(REPO_ROOT, "dist", "chrome-mv3");

/**
 * The extension uses window.confirm() for destructive actions. Playwright blocks
 * on unhandled dialogs, so every page we drive gets a default "accept" handler
 * plus a one-shot queue tests can push onto:
 *
 *   page.onNextDialog(d => { expect(d.message()).toContain("…"); d.dismiss(); });
 */
function attachDialogHandling(page) {
  const queue = [];
  page.on("dialog", async dialog => {
    const next = queue.shift();
    try {
      if (next) await next(dialog);
      else await dialog.accept();
    } catch {
      /* dialog already resolved */
    }
  });
  page.onNextDialog = fn => queue.push(fn);
  return page;
}

function assertExtensionBuilt() {
  const manifest = path.join(EXTENSION_PATH, "manifest.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Extension build not found at ${EXTENSION_PATH}.\n` +
      `Run "npm run build:chrome" (or "npm run build:all") before the E2E suite.`
    );
  }
}

const test = base.extend({
  /**
   * Persistent context with the unpacked extension loaded. Each test gets a
   * throwaway user-data-dir so chrome.storage never leaks between tests.
   */
  context: async ({ channel, headless }, use, testInfo) => {
    assertExtensionBuilt();

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hang-time-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // `chromium` / `chrome` / `msedge` all run the *full* browser, which is
      // required for extension support (the headless shell cannot load them).
      channel: channel || "chromium",
      headless: headless !== false,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
        // DisableLoadExtensionCommandLineSwitch: stock Chrome 137+ ignores
        // --load-extension unless this feature is turned off.
        "--disable-features=DisableLoadExtensionCommandLineSwitch,DialMediaRouteProvider,OptimizationHints"
      ]
    });

    await use(context);

    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* Windows sometimes holds a lock briefly; the temp dir is disposable. */
    }
  },

  /** The MV3 background service worker. */
  serviceWorker: async ({ context, channel }, use, testInfo) => {
    let worker;
    for (const sw of context.serviceWorkers()) {
      worker = sw;
      break;
    }
    if (!worker) {
      worker = await context.waitForEvent("serviceworker");
    }
    await use(worker);
  },

  /** The extension's runtime ID, for driving chrome.runtime.sendMessage(). */
  extensionId: async ({ serviceWorker }, use) => {
    const id = await serviceWorker.evaluate(() => chrome.runtime.id);
    await use(id);
  },

  /** popup.html opened as a tab. */
  popupPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    attachDialogHandling(page);
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await use(page);
    await page.close();
  },

  /**
   * Small helper API for driving extension state.
   *   ext.storage.get(key)    → value
   *   ext.storage.set(key, value) → void
   *   ext.runtime.sendMessage(message) → response
   */
  ext: async ({ serviceWorker, extensionId }, use) => {
    const ext = {
      storage: {
        get: (key) =>
          serviceWorker.evaluate((k) => {
            return new Promise((resolve) => {
              chrome.storage.local.get([k], (r) => resolve(r[k]));
            });
          }, key),
        set: (key, value) =>
          serviceWorker.evaluate((k, v) => {
            return new Promise((resolve) => {
              chrome.storage.local.set({ [k]: v }, resolve);
            });
          }, key, value),
        clear: () =>
          serviceWorker.evaluate(() => {
            return new Promise((resolve) => {
              chrome.storage.local.clear(resolve);
            });
          })
      },
      runtime: {
        sendMessage: (message) =>
          serviceWorker.evaluate((msg, id) => {
            return new Promise((resolve, reject) => {
              chrome.runtime.sendMessage(id, msg, (response) => {
                if (chrome.runtime.lastError) {
                  reject(new Error(chrome.runtime.lastError.message));
                } else {
                  resolve(response);
                }
              });
            });
          }, message, extensionId)
      }
    };
    await use(ext);
  }
});

module.exports = { test, expect };
