/**
 * Remote Control Signaling Server
 *
 * Responsibilities (M1 scope):
 *  - Mac Agent connects and registers a room, server issues a 6-digit PIN
 *  - iPhone Viewer connects with a PIN, server pairs it with the matching Agent
 *  - Relay WebRTC SDP offer/answer and ICE candidates between the two peers
 *  - PIN expiry (5 min) + brute-force rate limiting (M3 will add stronger auth,
 *    this file already carries the hooks so M3 is additive, not a rewrite)
 *
 * NOT responsible for: media/data relay itself (that's P2P WebRTC, or TURN
 * when direct connection fails — see infra/coturn.conf).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.SIGNAL_PORT || 8080;
const WEB_VIEWER_DIR = process.env.WEB_VIEWER_DIR || path.join(__dirname, '..', 'web-viewer');
const PIN_TTL_MS = 5 * 60 * 1000;        // PIN valid for 5 minutes
const MAX_PIN_ATTEMPTS = 3;
const LOCKOUT_MS = 30 * 1000;            // lock an IP for 30s after 3 wrong PINs

// ─── TURN REST credentials (coturn use-auth-secret) ────────────────────────
// Both the Mac Agent and the Web Viewer need TURN relay candidates to reach
// each other when direct P2P fails (e.g. phone on 4G/5G behind carrier-grade
// NAT, or either side behind a symmetric/restrictive NAT). Rather than
// shipping coturn's long-lived static-auth-secret to every client (which
// would let anyone who inspects the page's JS spin up relay traffic
// forever), we mint short-lived (1h) credentials server-side per coturn's
// REST API spec: https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api
//   username = "<unix-expiry-timestamp>:<label>"
//   password = base64(HMAC-SHA1(staticAuthSecret, username))
// coturn itself re-derives the password from the secret + username at
// connect time, so nothing needs to be pre-registered — any username the
// server mints this way is automatically valid until its embedded expiry.
const TURN_SECRET = process.env.TURN_SECRET || null; // unset in pure-LAN/dev setups
const TURN_DOMAIN = process.env.TURN_DOMAIN || null; // e.g. remote.example.com
const TURN_CRED_TTL_S = 60 * 60; // 1 hour

function issueTurnCredentials(label = 'viewer') {
  if (!TURN_SECRET || !TURN_DOMAIN) return null; // TURN not configured — STUN-only fallback

  const expiryTs = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S;
  const username = `${expiryTs}:${label}`;
  const password = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  return {
    urls: [
      `turn:${TURN_DOMAIN}:3478?transport=udp`,
      `turn:${TURN_DOMAIN}:3478?transport=tcp`,
      `turns:${TURN_DOMAIN}:5349?transport=tcp`,
    ],
    username,
    credential: password,
    ttl: TURN_CRED_TTL_S,
  };
}

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} pin -> room */
const rooms = new Map();

/** @type {Map<string, { count: number, lockedUntil: number }>} ip -> attempt tracker */
const attemptTracker = new Map();

// ─── VNC relay (plan.md M5, "lock-screen control" dual-track) ─────────────
// A completely separate, minimal pairing table from `rooms` above — this
// relay is a DUMB byte pipe between the Mac's local vnc-bridge.js (which
// dials out to us, same "Mac always makes the outbound connection, never
// exposes a port" pattern as the main WebRTC room flow) and the phone's
// noVNC client. We deliberately do NOT reuse the PIN/deviceToken system:
// this channel exists specifically for when the Mac is locked and the
// user is relying on the OS's own screensharingd + VNC password for auth
// (see rfb.js's ARD security type on the phone side) — layering our PIN
// system on top would just be a second, redundant gate that adds
// complexity without adding real security (the VNC password is already
// the system's own account password).
//
// Pairing code is short-lived (5 min, like the main PIN) and single-use:
// once both sides have attached, the code is deleted so it can't be
// replayed, and all subsequent traffic is raw binary relay — nothing on
// this path is parsed as JSON.
const VNC_RELAY_CODE_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { macWs: import('ws').WebSocket|null, viewerWs: import('ws').WebSocket|null, expiryTimer: NodeJS.Timeout }>} */
const vncRelays = new Map();

function genRelayCode() {
  return crypto.randomBytes(16).toString('hex'); // not a human-typed PIN — the Mac Agent hands this to the viewer via its own UI/QR, so it can be long and unguessable
}

/**
 * @typedef {Object} Room
 * @property {string} pin
 * @property {string} roomId
 * @property {import('ws').WebSocket} agentWs
 * @property {import('ws').WebSocket|null} viewerWs
 * @property {string|null} token       session token once paired
 * @property {number} createdAt
 * @property {NodeJS.Timeout} expiryTimer
 */

function genPin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function send(ws, msg) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(msg));
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function isLocked(ip) {
  const t = attemptTracker.get(ip);
  return !!(t && t.lockedUntil > Date.now());
}

function recordFailedAttempt(ip) {
  const t = attemptTracker.get(ip) || { count: 0, lockedUntil: 0 };
  t.count += 1;
  if (t.count >= MAX_PIN_ATTEMPTS) {
    t.lockedUntil = Date.now() + LOCKOUT_MS;
    t.count = 0;
  }
  attemptTracker.set(ip, t);
}

function resetAttempts(ip) {
  attemptTracker.delete(ip);
}

function destroyRoom(room) {
  clearTimeout(room.expiryTimer);
  rooms.delete(room.pin);
}

/**
 * Viewer disconnected (e.g. page refresh/reload) but the Agent is still
 * running — rotate the room onto a fresh PIN WITHOUT destroying/recreating
 * it. This matters because destroy+re-register requires a network round
 * trip to the Agent before the room exists again, and during that gap a
 * near-simultaneous `join-with-token` reconnect attempt (very common on
 * page refresh, where the browser tears down the old socket and opens a
 * new one almost instantly) finds no room at all and falls back to asking
 * for a PIN — this is the race condition behind "works once, then asks
 * for PIN again on every refresh after that". Rotating in-place keeps the
 * SAME room object (and thus the same agentWs) continuously valid, so
 * `join-with-token`'s "find a pending room" lookup never has a gap.
 */
function rotateRoomPin(room) {
  rooms.delete(room.pin);
  room.pin = genPin();
  room.viewerWs = null;
  room.token = null;
  room.createdAt = Date.now();
  clearTimeout(room.expiryTimer);
  room.expiryTimer = setTimeout(() => {
    if (!room.viewerWs) {
      send(room.agentWs, { type: 'pin-expired', pin: room.pin });
      destroyRoom(room);
    }
  }, PIN_TTL_MS);
  rooms.set(room.pin, room);
  return room;
}

// ─── HTTP (health check only; everything else is WS) ───────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  // Short-lived TURN relay credentials for WebRTC clients (plan.md §4 TURN
  // auth). Both mac-agent and web-viewer call this right before building
  // their RTCPeerConnection so relay candidates are available if direct
  // P2P fails. Returns `null` turnServer field (not an error) when TURN
  // isn't configured on this deployment — callers fall back to STUN-only.
  if (req.url?.startsWith('/turn-credentials')) {
    const label = new URL(req.url, 'http://x').searchParams.get('label') || 'client';
    const turnServer = issueTurnCredentials(label);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ turnServer }));
    return;
  }

  // Serve the web-viewer static files from the same origin/port so the
  // iPhone browser and the WebSocket signaling connection share one host —
  // avoids CORS/mixed-content issues under wss:// in production.
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(WEB_VIEWER_DIR, urlPath);

  if (!filePath.startsWith(WEB_VIEWER_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── WebSocket ──────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const urlPath = (req.url || '').split('?')[0];

  // ── VNC relay connections take a completely separate path, never
  // touching the `rooms` map or PIN logic above. See the vncRelays
  // comment near the top of this file for why this is intentionally
  // a separate, simpler system.
  if (urlPath === '/vnc-relay') {
    handleVncRelayConnection(ws, req);
    return;
  }

  ws._role = null;   // 'agent' | 'viewer'
  ws._room = null;   // Room reference once bound

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }

    switch (msg.type) {
      // ── Mac Agent registers a new room ──────────────────────────────
      case 'register': {
        const pin = genPin();
        const roomId = crypto.randomUUID();
        const room = {
          pin,
          roomId,
          agentWs: ws,
          viewerWs: null,
          token: null,
          createdAt: Date.now(),
          expiryTimer: null,
        };
        room.expiryTimer = setTimeout(() => {
          if (!room.viewerWs) {
            send(room.agentWs, { type: 'pin-expired', pin });
            destroyRoom(room);
          }
        }, PIN_TTL_MS);

        rooms.set(pin, room);
        ws._role = 'agent';
        ws._room = room;

        send(ws, { type: 'registered', pin, roomId, expiresInMs: PIN_TTL_MS });
        break;
      }

      // ── iPhone Viewer attempts to join with a PIN ───────────────────
      case 'join': {
        if (isLocked(ip)) {
          send(ws, { type: 'error', code: 'locked', message: 'Too many attempts. Try again shortly.' });
          return;
        }

        const room = rooms.get(msg.pin);
        if (!room) {
          recordFailedAttempt(ip);
          send(ws, { type: 'error', code: 'invalid-pin', message: 'Invalid or expired PIN' });
          return;
        }
        if (room.viewerWs) {
          send(ws, { type: 'error', code: 'room-full', message: 'This Mac is already connected to another viewer' });
          return;
        }

        resetAttempts(ip);

        const token = genToken();
        room.viewerWs = ws;
        room.token = token;
        clearTimeout(room.expiryTimer); // PIN consumed, no longer needs to expire

        ws._role = 'viewer';
        ws._room = room;

        // Both sides get notified pairing succeeded; Mac agent can now
        // (in M3) show a confirmation prompt before actually starting WebRTC.
        send(room.agentWs, { type: 'paired', token });
        send(ws, { type: 'paired', token });
        break;
      }

      // ── iPhone Viewer attempts to reconnect with a previously-issued
      // deviceToken, skipping the PIN entirely (plan.md §4, device
      // auto-reconnect). The signaling server does NOT validate the token
      // itself — it has no access to the Agent's local devices.json — it
      // just relays the token to the Agent and waits for a verdict. This
      // requires the Agent to already be online with an open (unpaired)
      // room; if not, the viewer falls back to the PIN flow in its UI.
      case 'join-with-token': {
        if (isLocked(ip)) {
          send(ws, { type: 'error', code: 'locked', message: 'Too many attempts. Try again shortly.' });
          return;
        }
        if (!msg.deviceToken) {
          send(ws, { type: 'error', code: 'invalid-token', message: 'Missing device token' });
          return;
        }

        // Device tokens aren't tied to a specific PIN/room — any currently
        // registered (not-yet-paired) room's Agent can attempt validation.
        // In practice there's normally exactly one Agent per deployment.
        const pendingRoom = [...rooms.values()].find(r => !r.viewerWs);
        if (!pendingRoom) {
          send(ws, { type: 'error', code: 'agent-offline', message: 'No Mac Agent is currently online' });
          return;
        }

        // Stash state on the VIEWER's own ws (not the room) so concurrent
        // token-verification attempts from different viewers can never
        // clobber each other — each ws only ever tracks its own request.
        const verifyId = crypto.randomUUID();
        ws._pendingVerifyId = verifyId;
        ws._pendingVerifyRoom = pendingRoom;

        send(pendingRoom.agentWs, { type: 'verify-token', deviceToken: msg.deviceToken, verifyId });
        break;
      }

      // ── Agent's verdict on a 'verify-token' request ──────────────────
      // The Agent echoes back the same verifyId it was given, so we look
      // up the exact waiting viewer ws instead of guessing "the" pending
      // room's lone viewer.
      case 'token-verified': {
        const pendingRoom = [...rooms.values()].find(r => r.agentWs === ws);
        if (!pendingRoom) break;

        const viewerWs = [...wss.clients].find(
          c => c._pendingVerifyRoom === pendingRoom && c._pendingVerifyId === msg.verifyId
        );
        if (!viewerWs) break; // viewer already disconnected while we waited

        viewerWs._pendingVerifyId = null;
        viewerWs._pendingVerifyRoom = null;

        if (!msg.valid) {
          send(viewerWs, { type: 'error', code: 'invalid-token', message: 'Device not recognized — please re-pair with PIN' });
          break;
        }

        resetAttempts(ip);
        const token = genToken();
        pendingRoom.viewerWs = viewerWs;
        pendingRoom.token = token;
        clearTimeout(pendingRoom.expiryTimer);

        viewerWs._role = 'viewer';
        viewerWs._room = pendingRoom;

        send(pendingRoom.agentWs, { type: 'paired', token, viaDeviceToken: true, deviceLabel: msg.deviceLabel });
        send(viewerWs, { type: 'paired', token });
        break;
      }

      // ── WebRTC signaling relay (offer / answer / ICE candidates / the
      // one-time device-token handoff after a fresh PIN pairing) ────────
      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'device-token-issued': {
        const room = ws._room;
        if (!room) {
          send(ws, { type: 'error', message: 'not paired yet' });
          return;
        }
        const target = ws._role === 'agent' ? room.viewerWs : room.agentWs;
        send(target, { ...msg, from: ws._role });
        break;
      }

      // ── Explicit leave / teardown ────────────────────────────────────
      case 'leave': {
        const room = ws._room;
        if (room) {
          const other = ws._role === 'agent' ? room.viewerWs : room.agentWs;
          send(other, { type: 'peer-left' });
          if (ws._role === 'agent') {
            destroyRoom(room);
          } else {
            // Viewer leaving on purpose (Disconnect button) — rotate, not
            // destroy, for the same race-condition reason as the on-close
            // handler below: an immediate reconnect attempt (token or PIN)
            // must always find a live room for this Agent.
            const pin = rotateRoomPin(room).pin;
            send(room.agentWs, { type: 'registered', pin, roomId: room.roomId, expiresInMs: PIN_TTL_MS });
          }
        }
        break;
      }

      default:
        send(ws, { type: 'error', message: `unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    const room = ws._room;
    if (!room) return;

    if (ws._role === 'agent') {
      // Agent gone — tear down the whole room
      send(room.viewerWs, { type: 'peer-left', reason: 'agent-disconnected' });
      destroyRoom(room);
    } else if (ws._role === 'viewer') {
      // Viewer gone (tab closed, page refreshed, phone locked, network
      // drop, etc.) — the Agent is still running, so rotate the SAME room
      // onto a fresh PIN instead of destroying it. Destroying+recreating
      // required a round trip to the Agent (re-register) before the room
      // existed again; a near-simultaneous reconnect (extremely common on
      // page refresh) could land in that gap and find no room at all,
      // wrongly falling back to the PIN screen even with a valid device
      // token. Rotating in-place closes that gap entirely.
      send(room.agentWs, { type: 'peer-left', reason: 'viewer-disconnected' });
      const pin = rotateRoomPin(room).pin;
      send(room.agentWs, { type: 'registered', pin, roomId: room.roomId, expiresInMs: PIN_TTL_MS });
    }
  });
});

// ─── VNC relay handlers (plan.md M5) ───────────────────────────────────────
// Separate from the main room/PIN machinery above. Messages here are a tiny
// JSON control handshake ({type:'mac-register'}, {type:'viewer-attach',
// code}) followed by raw binary RFB bytes once both sides are attached —
// the server never parses VNC protocol content, it just pipes whichever
// side's 'message' event fires to the other side's 'send()'.
function handleVncRelayConnection(ws, req) {
  const ip = clientIp(req);
  ws._vncRole = null;  // 'mac' | 'viewer'
  ws._vncRelay = null; // relay entry reference once attached

  ws.on('message', (data, isBinary) => {
    // Once attached, EVERY message (binary or not) is raw VNC traffic to
    // be relayed verbatim — this check must come before any JSON.parse
    // attempt, since RFB framebuffer bytes are not valid JSON and would
    // otherwise spam 'invalid JSON' errors back over the pipe.
    const relay = ws._vncRelay;
    if (relay && relay.macWs && relay.viewerWs) {
      const other = ws._vncRole === 'mac' ? relay.viewerWs : relay.macWs;
      console.log(`[DEBUG-TEMP] vnc-relay ${ws._vncRole}→${ws._vncRole === 'mac' ? 'viewer' : 'mac'}: ${data.length} bytes, otherReadyState=${other.readyState}`);
      if (other.readyState === 1 /* OPEN */) {
        other.send(data, { binary: isBinary });
      }
      return;
    }

    // Not attached yet — this must be the one-time JSON control handshake.
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: 'invalid JSON' });
      return;
    }

    switch (msg.type) {
      // ── Mac's vnc-bridge.js dials out and registers a fresh one-time
      // relay code. The Agent's own UI hands this code to the viewer
      // (e.g. embedded in the vnc.html link it shows/QR-codes) — it is
      // NOT the 6-digit PIN used by the main WebRTC flow.
      case 'mac-register': {
        const code = genRelayCode();
        const entry = {
          macWs: ws,
          viewerWs: null,
          expiryTimer: setTimeout(() => {
            if (!entry.viewerWs) vncRelays.delete(code);
          }, VNC_RELAY_CODE_TTL_MS),
        };
        vncRelays.set(code, entry);
        ws._vncRole = 'mac';
        ws._vncRelay = entry;
        send(ws, { type: 'relay-registered', code, expiresInMs: VNC_RELAY_CODE_TTL_MS });
        break;
      }

      // ── Phone's vnc.js attaches using the code it was given. Once both
      // sides are present the handshake is over — everything from here
      // on is relayed as opaque bytes (see the top of this handler).
      case 'viewer-attach': {
        if (isLocked(ip)) {
          send(ws, { type: 'error', code: 'locked', message: 'Too many attempts. Try again shortly.' });
          return;
        }
        const entry = vncRelays.get(msg.code);
        if (!entry || entry.viewerWs) {
          recordFailedAttempt(ip);
          send(ws, { type: 'error', code: 'invalid-code', message: 'Invalid or expired relay code' });
          return;
        }
        resetAttempts(ip);
        clearTimeout(entry.expiryTimer);
        entry.viewerWs = ws;
        ws._vncRole = 'viewer';
        ws._vncRelay = entry;
        console.log(`[DEBUG-TEMP] viewer attached from ${ip}, code=${msg.code.slice(0,8)}…`);
        send(entry.macWs, { type: 'viewer-attached' });
        send(ws, { type: 'attached' });
        break;
      }

      default:
        send(ws, { type: 'error', message: `unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    const relay = ws._vncRelay;
    console.log(`[DEBUG-TEMP] vnc-relay ws closed, role=${ws._vncRole}, hadRelay=${!!relay}`);
    if (!relay) return;

    if (ws._vncRole === 'mac') {
      // Mac's bridge dropped — kill the whole relay, nothing useful can
      // flow without the TCP-side endpoint. Find+delete by value since
      // we only stored the code as the map key, not on the entry itself.
      if (relay.viewerWs) send(relay.viewerWs, { type: 'peer-left', reason: 'mac-disconnected' });
      for (const [code, e] of vncRelays) {
        if (e === relay) { vncRelays.delete(code); break; }
      }
    } else if (ws._vncRole === 'viewer') {
      // Viewer dropped (locked phone, closed tab, network blip) — let the
      // Mac side know; the relay code was already single-use/consumed so
      // there's nothing to rotate here, the Agent must mint a fresh code
      // for any new reconnect attempt (mirrors the main flow needing a
      // fresh PIN after a room is fully torn down).
      send(relay.macWs, { type: 'peer-left', reason: 'viewer-disconnected' });
      for (const [code, e] of vncRelays) {
        if (e === relay) { vncRelays.delete(code); break; }
      }
    }
  });
}

// ─── Periodic sweep for orphaned rooms (safety net) ────────────────────────

setInterval(() => {
  const cutoff = Date.now() - PIN_TTL_MS * 2;
  for (const room of rooms.values()) {
    if (room.createdAt < cutoff && !room.viewerWs) {
      destroyRoom(room);
    }
  }
}, 60_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅  Signaling server running on :${PORT}`);
  console.log(`   WebSocket:   ws://0.0.0.0:${PORT}`);
  console.log(`   Health check: http://0.0.0.0:${PORT}/healthz\n`);
});
