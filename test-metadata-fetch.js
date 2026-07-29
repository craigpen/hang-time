/**
 * Test script to debug MetadataFetcher issues
 * Run in DevTools console or as Node script with: node test-metadata-fetch.js
 */

const FETCH_TIMEOUT_MS = 5000;

async function testFetch(appId) {
  const API_BASE = 'https://store.steampowered.com/api';
  const url = `${API_BASE}/appdetails?appids=${appId}`;

  console.log(`\n[TEST] Fetching: ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // Try with no special headers
    });
    clearTimeout(timeoutId);

    console.log(`[TEST] Status: ${response.status} ${response.statusText}`);
    console.log(`[TEST] Headers:`, {
      'content-type': response.headers.get('content-type'),
      'content-length': response.headers.get('content-length'),
    });

    if (!response.ok) {
      console.log(`[TEST] ❌ Response not OK`);
      return null;
    }

    const data = await response.json();
    console.log(`[TEST] ✅ Success! Got data for appId ${appId}:`, data[appId] ? 'present' : 'missing');
    return data;

  } catch (error) {
    clearTimeout(timeoutId);
    console.log(`[TEST] ❌ Error:`, {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });
    return null;
  }
}

// Test a few app IDs
async function runTests() {
  console.log('=== MetadataFetcher Test Suite ===');

  // Test with a known working game
  await testFetch(440); // Team Fortress 2

  // Wait between requests
  await new Promise(r => setTimeout(r, 1000));

  // Test with another app
  await testFetch(570); // Dota 2

  console.log('\n=== Test Complete ===');
}

// Auto-run if in browser console
if (typeof window !== 'undefined') {
  console.log('Run: await runTests()');
} else {
  runTests().catch(console.error);
}
