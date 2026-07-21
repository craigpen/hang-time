#!/usr/bin/env node

/**
 * Hang Time - esbuild Pipeline
 * Compiles TypeScript to JavaScript for Chrome and Firefox extensions
 */

import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// ============================================================================
// CONFIGURATION
// ============================================================================

const TARGETS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['chrome', 'firefox'];

const BUILD_CONFIG = {
  platform: 'browser',
  target: ['es2020'],
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const ENTRYPOINTS = {
  background: 'entrypoints/background.ts',
  popup: 'src/ui/popup.ts',
  settings: 'src/ui/settings.ts',
  'oauth-handler': 'entrypoints/oauth-handler.ts',
  'video-sync': 'entrypoints/video-sync.ts',
};

const STATIC_FILES = [
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'src/popup.html', dest: 'popup.html' },
  { src: 'src/settings.html', dest: 'settings.html' },
  { src: 'src/oauth-handler.html', dest: 'oauth-handler.html' },
  { src: 'src/styles', dest: 'styles' },
];

// ============================================================================
// BUILD FUNCTIONS
// ============================================================================

/**
 * Build TypeScript files using esbuild
 */
async function buildTypeScript(target, outdir) {
  console.log(`\n[${target}] Compiling TypeScript...`);

  const entrypointResults = [];

  for (const [name, entrypoint] of Object.entries(ENTRYPOINTS)) {
    const entrypointPath = path.join(projectRoot, entrypoint);

    if (!fs.existsSync(entrypointPath)) {
      console.warn(`  ⚠ Skipping ${name}: ${entrypoint} not found`);
      continue;
    }

    try {
      await esbuild.build({
        ...BUILD_CONFIG,
        entryPoints: [entrypointPath],
        outfile: path.join(outdir, `${name}.js`),
      });

      entrypointResults.push(name);
      console.log(`  ✓ Built ${name}.js`);
    } catch (error) {
      console.error(`  ✗ Failed to build ${name}:`, error.message);
      throw error;
    }
  }

  return entrypointResults.length;
}

/**
 * Copy static files
 */
function copyStaticFiles(target, outdir) {
  console.log(`[${target}] Copying static files...`);

  for (const fileConfig of STATIC_FILES) {
    const srcPath = path.join(projectRoot, fileConfig.src);
    const destPath = path.join(outdir, fileConfig.dest);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  ⚠ Skipping ${fileConfig.src}: not found`);
      continue;
    }

    try {
      if (fs.statSync(srcPath).isDirectory()) {
        // Copy directory recursively
        copyDir(srcPath, destPath);
      } else {
        // Copy single file
        fs.copyFileSync(srcPath, destPath);
      }
      console.log(`  ✓ Copied ${fileConfig.dest}`);
    } catch (error) {
      console.error(`  ✗ Failed to copy ${fileConfig.src}:`, error.message);
      throw error;
    }
  }
}

/**
 * Recursively copy directory
 */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const files = fs.readdirSync(src);
  for (const file of files) {
    const srcFile = path.join(src, file);
    const destFile = path.join(dest, file);

    if (fs.statSync(srcFile).isDirectory()) {
      copyDir(srcFile, destFile);
    } else {
      fs.copyFileSync(srcFile, destFile);
    }
  }
}

/**
 * Ensure output directory exists
 */
function ensureOutdir(outdir) {
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }
}

/**
 * Build for a single target
 */
async function buildTarget(target) {
  const outdir = path.join(projectRoot, 'dist', `${target}-mv3`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Building for ${target.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // Create output directory
    ensureOutdir(outdir);

    // Compile TypeScript
    const fileCount = await buildTypeScript(target, outdir);
    if (fileCount === 0) {
      throw new Error('No TypeScript files were compiled');
    }

    // Copy static files
    copyStaticFiles(target, outdir);

    console.log(`\n✅ Build successful for ${target}`);
    console.log(`   Output: ${outdir}`);

    return true;
  } catch (error) {
    console.error(`\n❌ Build failed for ${target}`);
    console.error(`   Error: ${error.message}`);
    return false;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`\nHang Time Extension Build Pipeline`);
  console.log(`Targets: ${TARGETS.join(', ')}`);

  const results = {};

  for (const target of TARGETS) {
    results[target] = await buildTarget(target);
  }

  // Summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Build Summary');
  console.log(`${'═'.repeat(60)}`);

  let allSuccess = true;
  for (const [target, success] of Object.entries(results)) {
    const status = success ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${status} - ${target}`);
    if (!success) allSuccess = false;
  }

  if (allSuccess) {
    console.log(`\n✨ All builds completed successfully!`);
    process.exit(0);
  } else {
    console.log(`\n💥 Some builds failed. See errors above.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
