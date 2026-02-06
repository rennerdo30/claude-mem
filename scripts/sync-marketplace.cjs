#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 *
 * Cross-platform: uses Node.js fs operations instead of rsync.
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync, cpSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

/**
 * Sync a directory from src to dest, deleting files in dest that aren't in src.
 * Excludes specified names from both deletion and copying.
 * Cross-platform replacement for: rsync -av --delete --exclude=<names> src/ dest/
 */
function syncDir(src, dest, excludes = []) {
  const excludeSet = new Set(excludes);

  // Ensure destination exists
  mkdirSync(dest, { recursive: true });

  // Phase 1: Delete files in dest that aren't in src (--delete behavior)
  cleanDestination(src, dest, excludeSet);

  // Phase 2: Copy files from src to dest
  copyDir(src, dest, excludeSet);
}

function cleanDestination(src, dest, excludeSet) {
  if (!existsSync(dest)) return;

  for (const entry of readdirSync(dest)) {
    if (excludeSet.has(entry)) continue;

    const destPath = path.join(dest, entry);
    const srcPath = path.join(src, entry);

    if (!existsSync(srcPath)) {
      // File/dir exists in dest but not in src — remove it
      rmSync(destPath, { recursive: true, force: true });
      continue;
    }

    // If both are directories, recurse
    if (statSync(destPath).isDirectory() && statSync(srcPath).isDirectory()) {
      cleanDestination(srcPath, destPath, excludeSet);
    }
  }
}

function copyDir(src, dest, excludeSet) {
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = path.basename(source);
      // Allow the root source directory itself
      if (source === src) return true;
      return !excludeSet.has(name);
    }
  });
}

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Syncing would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force sync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

// Get version from plugin.json
function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

// Sync for main branch or fresh install
console.log('Syncing to marketplace...');
try {
  const srcDir = path.resolve(__dirname, '..');
  syncDir(srcDir, INSTALLED_PATH, ['.git', '.mcp.json']);

  console.log('Running npm install in marketplace...');
  execSync('npm install', {
    cwd: INSTALLED_PATH,
    stdio: 'inherit'
  });

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  const pluginDir = path.join(srcDir, 'plugin');
  console.log(`Syncing to cache folder (version ${version})...`);
  syncDir(pluginDir, CACHE_VERSION_PATH, ['.git']);

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync
  console.log('\nTriggering worker restart...');
  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', 'Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'Worker restart timed out');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
