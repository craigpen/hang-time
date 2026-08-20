#!/usr/bin/env node

/**
 * Hang Time - Browser CDP Inspector
 * Connects directly to running Chromium/Edge instances via CDP
 * Inspects extension targets, storage state, and logs without requiring manual copy-pasting
 */

import http from 'http';

const PORTS = [9222, 9223];

function fetchJson(port, path = '/json') {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function sendCdpCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    try {
      const ws = new WebSocket(wsUrl);
      const id = Math.floor(Math.random() * 100000);
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 4000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ id, method, params }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id === id) {
            resolved = true;
            clearTimeout(timer);
            ws.close();
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          }
        } catch (e) {
          // ignore non-json messages
        }
      };

      ws.onerror = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      };
    } catch (err) {
      reject(err);
    }
  });
}

async function inspectPort(port, options) {
  const version = await fetchJson(port, '/json/version');
  if (!version) {
    console.log(`[Port ${port}] 🔴 Browser not running or remote debugging disabled.`);
    return;
  }

  console.log(`\n========================================================`);
  console.log(`  Browser on Port ${port} (${version['User-Agent']?.split(' ')[0] || 'Chromium'})`);
  console.log(`========================================================`);

  const targets = await fetchJson(port, '/json');
  if (!targets || !Array.isArray(targets)) {
    console.log(`  No active targets found.`);
    return;
  }

  // Find Hang Time extension targets
  const extensionTargets = targets.filter(
    (t) =>
      t.url?.includes('chrome-extension://') ||
      t.title?.includes('Hang Time') ||
      t.type === 'service_worker'
  );

  console.log(`  Active Targets (${targets.length} total, ${extensionTargets.length} extension):`);
  for (const t of targets) {
    const isExt = extensionTargets.includes(t);
    const prefix = isExt ? '  🧩 [Extension]' : '  🌐 [Page]';
    console.log(`  ${prefix} ${t.type.padEnd(14)} ${t.title.substring(0, 40).padEnd(42)} ${t.url?.substring(0, 60)}`);
  }

  // If storage or eval requested, run against background worker or first extension page
  const bgTarget = targets.find((t) => t.type === 'service_worker' && t.url?.includes('background.js')) || extensionTargets[0];

  if (bgTarget && bgTarget.webSocketDebuggerUrl) {
    if (options.eval) {
      console.log(`\n  Executing in [${bgTarget.type}] ${bgTarget.title}:`);
      console.log(`  > ${options.eval}`);
      try {
        const result = await sendCdpCommand(bgTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: options.eval,
          returnByValue: true,
          awaitPromise: true,
        });
        console.log(`  Result:`, JSON.stringify(result.result?.value ?? result.result, null, 2));
      } catch (err) {
        console.error(`  Eval error:`, err.message);
      }
    }

    if (options.storage) {
      console.log(`\n  Dumping chrome.storage.local for [${bgTarget.title}]:`);
      try {
        const result = await sendCdpCommand(bgTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: 'new Promise(r => chrome.storage.local.get(null, r))',
          returnByValue: true,
          awaitPromise: true,
        });
        const storageData = result.result?.value || {};
        const keys = Object.keys(storageData);
        console.log(`  Keys (${keys.length}): ${keys.join(', ')}`);
        console.log(`  Storage Content:\n`, JSON.stringify(storageData, null, 2));
      } catch (err) {
        console.error(`  Storage dump error:`, err.message);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {
    storage: args.includes('--storage'),
    eval: null,
    port: null,
  };

  const evalIdx = args.indexOf('--eval');
  if (evalIdx !== -1 && args[evalIdx + 1]) {
    options.eval = args[evalIdx + 1];
  }

  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    options.port = parseInt(args[portIdx + 1], 10);
  }

  const targetPorts = options.port ? [options.port] : PORTS;

  for (const port of targetPorts) {
    await inspectPort(port, options);
  }

  console.log(`\n========================================================\n`);
}

main().catch((err) => {
  console.error('[Inspector] Error:', err);
  process.exit(1);
});
