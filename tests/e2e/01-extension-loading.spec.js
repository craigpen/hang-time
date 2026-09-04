/**
 * 01-extension-loading.spec.js — Smoke test: can the extension load and respond?
 */

const { test, expect } = require("./fixtures");

test.describe("Extension Loading", () => {
  test("extension loads and service worker is available", async ({ serviceWorker, extensionId }) => {
    expect(extensionId).toBeTruthy();
    expect(serviceWorker).toBeTruthy();
  });

  test("popup page loads without errors", async ({ popupPage }) => {
    // Wait for the page to fully load
    await popupPage.waitForLoadState("networkidle");

    // Check that basic elements are present
    const title = await popupPage.title();
    expect(title).toBeTruthy();
  });

  test("extension can store and retrieve data", async ({ ext }) => {
    const testKey = "test_key";
    const testValue = { name: "test", value: 123 };

    await ext.storage.set(testKey, testValue);
    const retrieved = await ext.storage.get(testKey);

    expect(retrieved).toEqual(testValue);

    // Cleanup
    await ext.storage.clear();
  });

  test("runtime messaging works", async ({ ext, serviceWorker, extensionId }) => {
    // Test that we can send a message to the service worker
    const response = await ext.runtime.sendMessage({ type: "PING" });

    // The service worker should respond (even if just with undefined)
    expect(response).toBeDefined();
  });
});
