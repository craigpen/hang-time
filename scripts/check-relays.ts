/**
 * Quick relay validation script
 * Checks connectivity and publishing capability for all configured relays
 */

const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.mostr.pub',
  'wss://relay.primal.net',
];

interface RelayStatus {
  url: string;
  connected: boolean;
  latency: number | null;
  error?: string;
  canPublish?: boolean;
}

async function testRelay(url: string, timeout = 5000): Promise<RelayStatus> {
  const startTime = Date.now();
  const status: RelayStatus = {
    url,
    connected: false,
    latency: null,
  };

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      status.error = 'Timeout';
      resolve(status);
    }, timeout);

    let receivedPong = false;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        status.connected = true;
        status.latency = Date.now() - startTime;

        // Send a simple subscription to test publishing capability
        try {
          ws.send(JSON.stringify([
            'REQ',
            'test-' + Math.random().toString(36).slice(2, 9),
            { kinds: [1], limit: 1 }
          ]));
        } catch (err) {
          status.error = 'Failed to send';
          ws.close();
          clearTimeout(timer);
          resolve(status);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          // Check for EOSE (end of stored events) which means relay accepted the subscription
          if (msg[0] === 'EOSE') {
            receivedPong = true;
            status.canPublish = true;
            ws.close();
            clearTimeout(timer);
            resolve(status);
          }
        } catch (err) {
          // Ignore parse errors
        }
      };

      ws.onerror = (error) => {
        status.error = error.type || 'Connection error';
        clearTimeout(timer);
        resolve(status);
      };

      ws.onclose = () => {
        clearTimeout(timer);
        if (!receivedPong) {
          if (!status.error) {
            status.error = 'Closed without EOSE';
          }
          resolve(status);
        }
      };
    } catch (err) {
      status.error = err instanceof Error ? err.message : 'Unknown error';
      clearTimeout(timer);
      resolve(status);
    }
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
      console.log(`   ${canPublish} Can receive subscriptions`);
    } else {
      console.log(`   ${canPublish} Cannot receive subscriptions`);
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
  console.log(`   Publishing: ${canPublish}/${DEFAULT_RELAYS.length}`);
  console.log();

  if (allGood && canPublish >= 2) {
    console.log('✅ All relays operational and can accept events');
    process.exit(0);
  } else if (canPublish >= 2) {
    console.log('⚠️  Some relays are down, but enough are working');
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
