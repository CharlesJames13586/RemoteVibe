/**
 * vnc-bridge.js — lock-screen control channel (plan.md M5, "dual-track").
 *
 * Bridges the Mac's local VNC server (macOS's own screensharingd, which
 * only answers on 127.0.0.1:5900 — never exposed to the network directly)
 * to the cloud signaling server's /vnc-relay WebSocket endpoint, using the
 * same "Mac always dials out, never listens for inbound connections from
 * the internet" pattern as the main WebRTC flow in renderer.js.
 *
 * Why this needs to exist at all: screensharingd is a privileged system
 * service that macOS itself restricts to localhost-only connections (no
 * `listen on 0.0.0.0` option) — this is by design, so nothing on the LAN
 * can hit it directly. We bridge it out over our own authenticated
 * (relay-code) WebSocket tunnel instead of trying to fight that restriction.
 *
 * Deliberately NOT using nut.js or Electron's desktopCapturer here — this
 * whole channel exists specifically because those are blocked by macOS at
 * the lock screen (see plan.md M5 background). screensharingd runs at a
 * higher privilege tier that isn't subject to that restriction, so we
 * just need a dumb byte pipe, not screen capture / input injection code.
 */

const net = require('net');
const WebSocket = require('ws');

const VNC_HOST = '127.0.0.1';
// Overridable for two reasons: (1) automated testing of the "local VNC
// failed" path by pointing at a dead port, and (2) users running their own
// VNC server on a non-standard port instead of macOS's stock screensharingd.
const VNC_PORT = Number(process.env.VNC_BRIDGE_PORT || 5900);

class VncBridge {
  /**
   * @param {string} signalUrl ws(s)://host[:port] of the signaling server
   *   (same one the main WebRTC flow already uses — see main.js getSignalUrl)
   */
  constructor(signalUrl) {
    this.signalUrl = signalUrl.replace(/\/+$/, '') + '/vnc-relay';
    this.relayWs = null;
    this.tcpSocket = null;
    this.relayCode = null;
    this.onStatusChange = null; // (status, detail) => void, set by caller
    this.viewerAttached = false;       // true once the server says a viewer attached
    this._suppressRelayClosedEmit = false; // set when WE tear down the relay (see _connectLocalVnc)
    this._stopped = true;
  }

  _emit(status, detail) {
    console.log(`[vnc-bridge] ${status}${detail ? ': ' + detail : ''}`);
    if (this.onStatusChange) this.onStatusChange(status, detail);
  }

  /**
   * Opens the outbound WebSocket to the signaling server and registers a
   * fresh one-time relay code. Resolves with the code once the server
   * confirms registration — the caller (renderer.js) is responsible for
   * surfacing this code/link to the user (e.g. in the Agent UI).
   * @returns {Promise<string>} the relay code
   */
  start() {
    this._stopped = false;
    this.viewerAttached = false;
    this._suppressRelayClosedEmit = false;
    return new Promise((resolve, reject) => {
      this.relayWs = new WebSocket(this.signalUrl);

      this.relayWs.on('open', () => {
        this._emit('connecting-relay');
        this.relayWs.send(JSON.stringify({ type: 'mac-register' }));
      });

      this.relayWs.on('message', (raw) => {
        // Before a viewer attaches, every message is JSON control; once
        // attached, _wireRelayToTcp() takes over the 'message' listener
        // entirely (see below), so this handler only ever sees the
        // handshake messages below.
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // shouldn't happen pre-attach, but don't crash on it
        }

        switch (msg.type) {
          case 'relay-registered':
            this.relayCode = msg.code;
            this._emit('waiting-for-viewer', `code expires in ${Math.floor(msg.expiresInMs / 1000)}s`);
            resolve(msg.code);
            break;

          case 'viewer-attached':
            this.viewerAttached = true;
            this._connectLocalVnc();
            break;

          case 'peer-left':
            this.viewerAttached = false;
            this._emit('viewer-disconnected');
            this._teardownTcp();
            break;

          case 'error':
            this._emit('relay-error', msg.message);
            reject(new Error(msg.message));
            break;
        }
      });

      this.relayWs.on('close', () => {
        if (!this._suppressRelayClosedEmit) this._emit('relay-closed');
        this._suppressRelayClosedEmit = false;
        this.viewerAttached = false;
        this._teardownTcp();
      });

      this.relayWs.on('error', (err) => {
        this._emit('relay-error', err.message);
        reject(err);
      });
    });
  }

  /**
   * Once the viewer has attached on the relay, open the local TCP
   * connection to screensharingd and start piping bytes both ways.
   */
  _connectLocalVnc() {
    this._emit('connecting-local-vnc');
    this.tcpSocket = net.createConnection({ host: VNC_HOST, port: VNC_PORT }, () => {
      this._emit('bridging');
    });

    this.tcpSocket.on('data', (chunk) => {
      if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
        this.relayWs.send(chunk);
      }
    });

    // The local VNC endpoint can vanish at any point after the viewer has
    // attached: Screen Sharing disabled between registering the code and now,
    // screensharingd restarted, macOS re-authorizing, etc. When a viewer IS
    // attached, the relay has nothing left to bridge — closing our WS makes
    // the signaling server notify the viewer ('peer-left') instead of
    // leaving the phone hanging forever on "Connecting…" with no data
    // flowing. (If no viewer is attached yet, keep the relay alive so a
    // fresh viewer-attach can still retry the connection.)
    this.tcpSocket.on('error', (err) => {
      this._emit('local-vnc-error', err.message +
        ' — is Screen Sharing enabled in System Settings > General > Sharing?');
      if (this.viewerAttached && this.relayWs) {
        this._suppressRelayClosedEmit = true;
        this.relayWs.close();
      }
      this._teardownTcp();
    });

    this.tcpSocket.on('close', () => {
      // Same reasoning as 'error' above, but for screensharingd dropping an
      // established connection mid-session (server restart, lock weirdness).
      if (this.viewerAttached && this.relayWs) {
        this._emit('local-vnc-closed');
        this._suppressRelayClosedEmit = true;
        this.relayWs.close();
      }
    });

    // Replace the relay socket's message handler: once the local TCP
    // connection exists, every subsequent WS message is raw RFB bytes
    // from the viewer, not JSON — pipe it straight into the TCP socket.
    this.relayWs.removeAllListeners('message');
    this.relayWs.on('message', (data) => {
      if (this.tcpSocket && !this.tcpSocket.destroyed) {
        this.tcpSocket.write(data);
      }
    });
  }

  _teardownTcp() {
    if (this.tcpSocket) {
      this.tcpSocket.destroy();
      this.tcpSocket = null;
    }
  }

  stop() {
    this._stopped = true;
    this._teardownTcp();
    if (this.relayWs) {
      this.relayWs.close();
      this.relayWs = null;
    }
    this.relayCode = null;
  }

  get isRunning() {
    return !this._stopped;
  }
}

module.exports = { VncBridge };
