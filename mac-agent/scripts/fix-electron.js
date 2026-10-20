#!/usr/bin/env node
/**
 * fix-electron.js — postinstall repair script for environments where npm's
 * bundled electron installer (via the `extract-zip` package) silently
 * under-extracts the Electron.app bundle, and/or macOS Gatekeeper rejects
 * the resulting ad-hoc signature after the files were touched by iCloud
 * Drive sync.
 *
 * Symptoms this fixes:
 *   1. `Error: Electron failed to install correctly` on `npm start`
 *      (because node_modules/electron/dist/Electron.app ends up only a
 *      few hundred KB instead of ~240MB — extract-zip bug on some
 *      Node versions)
 *   2. "未能打开 Electron，因其包含恶意软件" / SIGKILL on launch
 *      (because the ad-hoc signature became invalid after iCloud's
 *      background sync touched the bundle's extended attributes)
 *
 * What it does, idempotently, after every `npm install`:
 *   1. Locate the cached Electron zip (@electron/get already downloaded it)
 *   2. Re-extract it with the system `unzip` binary (far more reliable than
 *      the extract-zip npm package in this environment)
 *   3. Strip extended attributes and re-sign the app bundle ad-hoc
 *
 * Safe to run multiple times; it always re-does the extraction + signing
 * step rather than trying to detect "is it already fine" (cheap enough,
 * and avoids subtle false-negatives).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ELECTRON_DIR = path.join(__dirname, '..', 'node_modules', 'electron');
const DIST_DIR = path.join(ELECTRON_DIR, 'dist');
const APP_PATH = path.join(DIST_DIR, 'Electron.app');
const PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');

function log(msg) {
  console.log(`[fix-electron] ${msg}`);
}

function findCachedZip(version) {
  // @electron/get caches downloads under ~/Library/Caches/electron/<hash>/electron-vX.Y.Z-darwin-<arch>.zip
  const cacheRoot = process.env.electron_config_cache || path.join(os.homedir(), 'Library', 'Caches', 'electron');
  if (!fs.existsSync(cacheRoot)) return null;

  const arch = process.arch; // 'arm64' | 'x64'
  const target = `electron-v${version}-darwin-${arch}.zip`;

  for (const hashDir of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, hashDir, target);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  if (process.platform !== 'darwin') {
    log('not macOS, nothing to fix — skipping');
    return;
  }

  if (!fs.existsSync(ELECTRON_DIR)) {
    log('node_modules/electron not found — skipping (is electron installed?)');
    return;
  }

  const { version } = require(path.join(ELECTRON_DIR, 'package.json'));

  // ── Check if the existing extraction already looks healthy ──────────────
  // A healthy Electron.app is >100MB; the buggy extract-zip output is only
  // a few hundred KB. Skip the (slow) re-extract if it's already fine, but
  // always re-check/re-apply the code signature since that can go stale
  // independently (e.g. after iCloud touches the files).
  let needsExtract = true;
  if (fs.existsSync(APP_PATH)) {
    const size = dirSize(APP_PATH);
    if (size > 100 * 1024 * 1024) {
      needsExtract = false;
      log(`Electron.app already looks complete (${(size / 1024 / 1024).toFixed(0)}MB) — skipping re-extract`);
    } else {
      log(`Electron.app looks truncated (${(size / 1024).toFixed(0)}KB) — will re-extract`);
    }
  }

  if (needsExtract) {
    const zipPath = findCachedZip(version);
    if (!zipPath) {
      log(`WARNING: could not find cached Electron zip for v${version} — run "npm start" once to trigger the download, then "npm run postinstall" again`);
      return;
    }
    log(`re-extracting from ${zipPath} using system unzip...`);

    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });
    execFileSync('unzip', ['-q', zipPath, '-d', DIST_DIR]);

    fs.writeFileSync(PATH_TXT, 'Electron.app/Contents/MacOS/Electron');
    fs.writeFileSync(path.join(DIST_DIR, 'version'), `v${version}`);

    log(`extracted, size now ${(dirSize(APP_PATH) / 1024 / 1024).toFixed(0)}MB`);
  }

  // ── Always strip quarantine/extended attrs + re-sign ad-hoc ─────────────
  // This is cheap and fixes the "contains malware" Gatekeeper rejection that
  // can recur any time iCloud Drive re-syncs the bundle in the background.
  log('clearing extended attributes and re-signing (ad-hoc)...');
  try {
    execFileSync('codesign', ['--remove-signature', APP_PATH], { stdio: 'ignore' });
  } catch {
    // no existing signature to remove — fine
  }

  cleanAppleDouble(APP_PATH);
  execFileSync('xattr', ['-cr', APP_PATH]);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP_PATH]);
  } catch (err) {
    // codesign refuses to sign if any "resource fork / Finder information /
    // similar detritus" (i.e. leftover AppleDouble ._* files or Finder
    // extended attrs) is still present anywhere inside the bundle — this
    // happens when iCloud Drive re-syncs the folder *during* our cleanup
    // above and re-creates a stray ._* file in between cleanAppleDouble()
    // and xattr -cr running. Retry once after a second, more thorough pass.
    log('codesign failed (likely leftover iCloud AppleDouble files) — retrying cleanup once...');
    cleanAppleDouble(APP_PATH);
    execFileSync('xattr', ['-cr', APP_PATH]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP_PATH]);
  }

  log('done — Electron should now launch correctly with `npm start`');
}

/**
 * Remove AppleDouble files (._*) and Finder extended attributes that iCloud
 * Drive's background sync leaves behind inside the bundle. `codesign`
 * refuses to sign anything containing these ("resource fork, Finder
 * information, or similar detritus not allowed"), so this must run right
 * before every signing attempt.
 */
function cleanAppleDouble(appPath) {
  // `dot_clean -m` merges/removes AppleDouble files for everything under
  // the given directory; it's the macOS-native tool for exactly this.
  try {
    execFileSync('dot_clean', ['-m', appPath], { stdio: 'ignore' });
  } catch {
    // dot_clean missing or failed — fall back to a manual sweep below anyway
  }

  // Belt-and-suspenders manual sweep: `find` + delete any remaining ._* files
  // and macOS's own .DS_Store droppings, since dot_clean can occasionally
  // miss files that iCloud re-creates mid-sync.
  try {
    execFileSync('find', [appPath, '(', '-name', '._*', '-o', '-name', '.DS_Store', ')', '-delete']);
  } catch {
    // nothing to delete — fine
  }
}

function dirSize(dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else {
      total += stat.size;
    }
  }
  return total;
}

main();
