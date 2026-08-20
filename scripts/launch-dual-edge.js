#!/usr/bin/env node

/**
 * Hang Time - Dual Edge Launcher for Peer Testing
 * Launches two independent Microsoft Edge test instances with remote debugging:
 * - Instance 1 (Cloned from Profile 2) -> Port 9222
 * - Instance 2 (Cloned from Profile 3) -> Port 9223
 *
 * Runs completely isolated from your main Edge browser so you never need to close Edge.
 */

import { exec, execSync } from 'child_process';
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
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  return 'msedge';
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch {
        // ignore locked files
      }
    }
  }
}

function syncExtensionData(sourceProfileDir, targetDataDir) {
  const targetDefault = path.join(targetDataDir, 'Default');
  fs.mkdirSync(targetDefault, { recursive: true });

  const itemsToCopy = [
    'Local Extension Settings',
    'Extension State',
    'Sync Extension Settings',
    'IndexedDB',
  ];

  for (const item of itemsToCopy) {
    const src = path.join(sourceProfileDir, item);
    const dest = path.join(targetDefault, item);
    if (fs.existsSync(src)) {
      try {
        copyDirRecursive(src, dest);
      } catch (err) {
        // ignore copy errors for locked files
      }
    }
  }
}

async function main() {
  const edgePath = findEdgePath();
  console.log(`[Dual Launcher] Using Edge at: ${edgePath}`);

  // 1. Build Chrome/Edge MV3 extension first if needed
  if (!fs.existsSync(extensionPath)) {
    console.log('[Dual Launcher] Extension build not found, building dist/chrome-mv3...');
    execSync('npm run build:chrome', { cwd: projectRoot, stdio: 'inherit' });
  }

  const portA = process.env.EDGE_PORT_A || '9222';
  const portB = process.env.EDGE_PORT_B || '9223';

  const edgeUserData = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  const sourceProfile2 = path.join(edgeUserData, 'Profile 1'); // Edge folder 'Profile 1' is UI 'Profile 2'
  const sourceProfile3 = path.join(edgeUserData, 'Profile 2'); // Edge folder 'Profile 2' is UI 'Profile 3'

  const dataDirA = path.join(process.env.USERPROFILE || 'C:\\temp', '.hangtime-edge-profile2');
  const dataDirB = path.join(process.env.USERPROFILE || 'C:\\temp', '.hangtime-edge-profile3');

  // Sync extension storage on initial setup or if requested
  console.log('[Dual Launcher] Initializing isolated test profile data directories...');
  syncExtensionData(sourceProfile2, dataDirA);
  syncExtensionData(sourceProfile3, dataDirB);

  console.log(`\n========================================================`);
  console.log(`  Hang Time Dual Browser Test Environment (MS Edge)`);
  console.log(`========================================================`);
  console.log(`  • Instance 1: Profile 2 -> Debug Port http://127.0.0.1:${portA}`);
  console.log(`  • Instance 2: Profile 3 -> Debug Port http://127.0.0.1:${portB}`);
  console.log(`  • Extension : ${extensionPath}`);
  console.log(`========================================================\n`);

  const argsA = [
    `--remote-debugging-port=${portA}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${dataDirA}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];

  const argsB = [
    `--remote-debugging-port=${portB}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${dataDirB}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];

  function launchInstance(args) {
    const fullCmd = `start "" "${edgePath}" ${args.map((a) => `"${a}"`).join(' ')}`;
    return new Promise((resolve, reject) => {
      exec(fullCmd, (err) => {
        if (err) {
          console.error('[Dual Launcher] Launch error:', err.message);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  console.log(`[Dual Launcher] Spawning Instance 1 (Port ${portA})...`);
  await launchInstance(argsA);

  // Wait 1.5s before spawning instance 2 to prevent startup race condition
  await new Promise((resolve) => setTimeout(resolve, 1500));

  console.log(`[Dual Launcher] Spawning Instance 2 (Port ${portB})...`);
  await launchInstance(argsB);

  console.log(`\n[Dual Launcher] Waiting for debug endpoints to be ready...`);

  async function checkPortReady(port, maxAttempts = 15) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return true;
      } catch {
        // wait and retry
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  const readyA = await checkPortReady(portA);
  const readyB = await checkPortReady(portB);

  if (readyA && readyB) {
    console.log(`\n✅ Both Edge test instances are ready and listening on ports ${portA} & ${portB}!`);
  } else {
    console.log(`\n⚠️ Readiness status: Port ${portA}: ${readyA ? 'OK' : 'Waiting'}, Port ${portB}: ${readyB ? 'OK' : 'Waiting'}`);
  }
  console.log(`To inspect live logs or state, run: npm run debug:inspect\n`);
}

main().catch((err) => {
  console.error('[Dual Launcher] Error launching browsers:', err);
  process.exit(1);
});
