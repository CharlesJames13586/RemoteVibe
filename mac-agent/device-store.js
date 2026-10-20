/**
 * device-store.js — persists "trusted device" tokens on the Mac so a
 * paired iPhone can reconnect without re-entering the PIN every time.
 *
 * Design (see plan.md §4 Security):
 *  - PIN is only ever used for the FIRST pairing of a device.
 *  - On successful pairing, we mint a 256-bit random deviceToken, send the
 *    raw token to the phone once (it stores it in localStorage), and
 *    persist only a SHA-256 HASH of it here — never the raw token. If this
 *    file ever leaks, the hash alone cannot be replayed to authenticate.
 *  - Tokens expire after 24h; expired/revoked devices must re-pair via PIN.
 *  - Revocation is immediate and local-only (no need to contact the cloud
 *    signaling server — it just forwards whatever this module decides).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STORE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'remote-control-agent');
const STORE_FILE = path.join(STORE_DIR, 'devices.json');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function ensureStoreDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * @typedef {Object} DeviceRecord
 * @property {string} id            stable id for UI list keys / revocation target
 * @property {string} tokenHash     sha256(rawToken) — never store the raw token
 * @property {string} deviceLabel   human-readable label (e.g. "iPhone — first paired Oct 20")
 * @property {number} createdAt
 * @property {number} lastSeenAt
 * @property {number} expiresAt
 */

/** @returns {DeviceRecord[]} */
function loadDevices() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.devices) ? data.devices : [];
  } catch {
    return [];
  }
}

function saveDevices(devices) {
  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify({ devices }, null, 2));
}

/**
 * Remove expired device records. Called opportunistically on every
 * read/write so the list never needs a separate cron/timer.
 */
function pruneExpired(devices) {
  const now = Date.now();
  return devices.filter(d => d.expiresAt > now);
}

/**
 * Mint a new trusted-device token after a successful PIN pairing.
 * @returns {{ rawToken: string, record: DeviceRecord }} rawToken is sent to
 *   the phone ONCE over the signaling channel and never persisted here.
 */
function issueToken(deviceLabel) {
  const rawToken = crypto.randomBytes(32).toString('hex'); // 256 bits
  const now = Date.now();

  const record = {
    id: crypto.randomUUID(),
    tokenHash: sha256(rawToken),
    deviceLabel: deviceLabel || `iPhone — paired ${new Date(now).toLocaleString()}`,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };

  const devices = pruneExpired(loadDevices());
  devices.push(record);
  saveDevices(devices);

  return { rawToken, record };
}

/**
 * Validate a raw token presented by a reconnecting viewer.
 * On success, bumps lastSeenAt (but does NOT extend expiresAt — a device
 * must still re-pair every 24h even if used continuously, per the design
 * decision to cap trust duration rather than have it renew indefinitely).
 *
 * @param {string} rawToken
 * @returns {DeviceRecord|null} the matching record, or null if invalid/expired/revoked
 */
function validateToken(rawToken) {
  if (!rawToken) return null;

  const hash = sha256(rawToken);
  const devices = pruneExpired(loadDevices());
  const match = devices.find(d => d.tokenHash === hash);

  if (!match) {
    // Still persist the pruned list even on a miss, so expired entries
    // don't accumulate forever just because nobody successfully reconnects.
    saveDevices(devices);
    return null;
  }

  match.lastSeenAt = Date.now();
  saveDevices(devices);
  return match;
}

/** @returns {DeviceRecord[]} current non-expired devices, for the UI list */
function listDevices() {
  const devices = pruneExpired(loadDevices());
  saveDevices(devices); // persist pruning side-effect
  return devices;
}

/**
 * Revoke a single device by id. Idempotent — revoking an already-gone id
 * is a no-op, not an error (the UI list may be stale by a few hundred ms).
 */
function revokeDevice(id) {
  const devices = loadDevices().filter(d => d.id !== id);
  saveDevices(devices);
}

/** Revoke everything — the "something's wrong, lock it all down" button. */
function revokeAll() {
  saveDevices([]);
}

module.exports = {
  issueToken,
  validateToken,
  listDevices,
  revokeDevice,
  revokeAll,
  TOKEN_TTL_MS,
};
