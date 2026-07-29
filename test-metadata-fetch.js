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
  console.log('=== Third-Party Steam API Alternatives ===\n');

  // Test SteamSpy
  console.log('1. SteamSpy API');
  await testSteamSpy(427520); // Factorio

  console.log('\n2. RAWG.io API');
  await testRawg('factorio');

  console.log('\n=== Complete ===');
}

async function testSteamSpy(appId) {
  const url = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;
  console.log(`Testing: ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`❌ Status: ${response.status}`);
      return;
    }
    const data = await response.json();
    console.log('✅ Response fields:', Object.keys(data).sort());
    if (data.positive || data.negative) {
      console.log(`   Positive: ${data.positive}, Negative: ${data.negative}`);
      const total = data.positive + data.negative;
      const percent = Math.round((data.positive / total) * 100);
      console.log(`   Score: ${percent}% (${total} reviews)`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function testRawg(gameName) {
  const url = `https://api.rawg.io/api/games?search=${encodeURIComponent(gameName)}`;
  console.log(`Testing: ${url}`);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`❌ Status: ${response.status}`);
      return;
    }
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      const game = data.results[0];
      console.log(`✅ Found: ${game.name}`);
      console.log(`   Rating: ${game.rating}/5`);
      console.log(`   Review count: ${game.reviews_count}`);
    } else {
      console.log('❌ No results');
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function testFetchFullData(appId) {
  const API_BASE = 'https://store.steampowered.com/api';
  const url = `${API_BASE}/appdetails?appids=${appId}`;

  console.log(`\n[TEST] Fetching appId ${appId}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`[TEST] ❌ Response not OK: ${response.status}`);
      return;
    }

    const data = await response.json();
    const gameData = data[appId];

    if (!gameData || !gameData.data) {
      console.log(`[TEST] ❌ No data for appId ${appId}`);
      return;
    }

    const game = gameData.data;
    console.log(`Game: ${game.name}`);
    console.log(`\nAll top-level fields:`);
    console.log(Object.keys(game).sort());

    console.log(`\n=== FULL RESPONSE ===`);
    console.log(JSON.stringify(game, null, 2));

  } catch (error) {
    console.log(`[TEST] ❌ Error:`, error.message);
  }
}

async function testFetchWithMetacritic(appId) {
  const API_BASE = 'https://store.steampowered.com/api';
  const url = `${API_BASE}/appdetails?appids=${appId}`;

  console.log(`\n[TEST] Fetching appId ${appId}: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`[TEST] ❌ Response not OK: ${response.status}`);
      return;
    }

    const data = await response.json();
    const gameData = data[appId];

    if (!gameData || !gameData.data) {
      console.log(`[TEST] ❌ No data for appId ${appId}`);
      return;
    }

    const game = gameData.data;
    console.log(`\n[TEST] Game: ${game.name}`);
    console.log(`[TEST] ---- Scoring/Rating Fields ----`);

    // Extract only scoring-related fields
    const scoringFields = {};
    Object.keys(game).forEach(key => {
      if (key.includes('score') || key.includes('rating') || key.includes('review') || key.includes('recommend') || key.includes('metacritic')) {
        scoringFields[key] = game[key];
      }
    });

    console.log(JSON.stringify(scoringFields, null, 2));

  } catch (error) {
    console.log(`[TEST] ❌ Error:`, error.message);
  }
}

// Auto-run if in browser console
if (typeof window !== 'undefined') {
  console.log('Run: await runTests()');
} else {
  runTests().catch(console.error);
}
