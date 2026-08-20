#!/usr/bin/env node

/**
 * Hang Time - Dual Edge Launcher for Peer Testing
 * Launches two Microsoft Edge instances with remote debugging enabled:
 * - Profile 2 on Port 9222
 * - Profile 3 on Port 9223
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');
const extensionPath = path.join(projectRoot, 'dist', 'chrome-mv3');

// Find Edge executable
function findEdgePath() {
  const possiblePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback to command name
  return 'msedge';
}

async function main() {
  const edgePath = findEdgePath();
  console.log(`[Dual Launcher] Using Edge at: ${edgePath}`);

  // 1. Build Chrome/Edge MV3 extension first if needed
  if (!fs.existsSync(extensionPath)) {
    console.log('[Dual Launcher] Extension build not found, building dist/chrome-mv3...');
    execSync('npm run build:chrome', { cwd: projectRoot, stdio: 'inherit' });
  }

  const profileA = process.env.EDGE_PROFILE_A || 'Profile 2';
  const profileB = process.env.EDGE_PROFILE_B || 'Profile 3';
  const portA = process.env.EDGE_PORT_A || '9222';
  const portB = process.env.EDGE_PORT_B || '9223';

  console.log(`\n========================================================`);
  console.log(`  Hang Time Dual Browser Test Environment (MS Edge)`);
  console.log(`========================================================`);
  console.log(`  • Instance 1: ${profileA} -> Debug Port http://127.0.0.1:${portA}`);
  console.log(`  • Instance 2: ${profileB} -> Debug Port http://127.0.0.1:${portB}`);
  console.log(`  • Extension : ${extensionPath}`);
  console.log(`========================================================\n`);

  const argsA = [
    `--remote-debugging-port=${portA}`,
    `--profile-directory=${profileA}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  const argsB = [
    `--remote-debugging-port=${portB}`,
    `--profile-directory=${profileB}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  console.log(`[Dual Launcher] Spawning Instance 1 (${profileA})...`);
  const procA = spawn(edgePath, argsA, { detached: true, stdio: 'ignore' });
  procA.unref();

  // Small delay between launches to prevent process race
  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log(`[Dual Launcher] Spawning Instance 2 (${profileB})...`);
  const procB = spawn(edgePath, argsB, { detached: true, stdio: 'ignore' });
  procB.unref();

  console.log(`\n✅ Both Edge instances launched!`);
  console.log(`To inspect live logs or state, run: npm run debug:inspect\n`);
}

main().catch((err) => {
  console.error('[Dual Launcher] Error launching browsers:', err);
  process.exit(1);
});
