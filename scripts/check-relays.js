#!/usr/bin/env node

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.mostr.pub',
  'wss://relay.primal.net',
];

async function testRelay(url, timeout = 5000) {
  const startTime = Date.now();
  const status = {
    url,
    connected: false,
    latency: null,
  };

  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const port = urlObj.port || (url.startsWith('wss:') ? 443 : 80);

    const req = https.request(
      {
        hostname,
        port,
        path: '/',
        method: 'GET',
        timeout,
      },
      (res) => {
        status.connected = true;
        status.latency = Date.now() - startTime;
        status.canPublish = res.statusCode < 400; // 2xx, 3xx likely means relay is up
        req.destroy();
        resolve(status);
      }
    );

    req.on('error', (error) => {
      status.error = error.message || 'Connection error';
      resolve(status);
    });

    req.on('timeout', () => {
      status.error = 'Timeout';
      req.destroy();
      resolve(status);
    });

    req.end();
  });
}

async function main() {
  console.log('🔍 Checking Nostr relays...\n');
  console.log('Relays to test:');
  DEFAULT_RELAYS.forEach((url) => console.log(`  - ${url}`));
  console.log('\n');

  const results = await Promise.all(
    DEFAULT_RELAYS.map((url) => testRelay(url))
  );

  console.log('📊 Results:\n');

  let allGood = true;
  results.forEach((result) => {
    const statusIcon = result.connected ? '✅' : '❌';
    const canPublish = result.canPublish ? '📤' : '❌';
    console.log(`${statusIcon} ${result.url}`);

    if (result.latency !== null) {
      console.log(`   Latency: ${result.latency}ms`);
    }

    if (result.canPublish) {
      console.log(`   ${canPublish} Responding`);
    } else {
      console.log(`   ${canPublish} Not responding`);
      allGood = false;
    }

    if (result.error) {
      console.log(`   Error: ${result.error}`);
      allGood = false;
    }
    console.log();
  });

  const connected = results.filter((r) => r.connected).length;
  const canPublish = results.filter((r) => r.canPublish).length;

  console.log('📈 Summary:');
  console.log(`   Connected: ${connected}/${DEFAULT_RELAYS.length}`);
  console.log(`   Responding: ${canPublish}/${DEFAULT_RELAYS.length}`);
  console.log();

  if (canPublish >= 2) {
    console.log('✅ Enough relays operational for publishing');
    process.exit(0);
  } else {
    console.log('❌ Not enough healthy relays');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
