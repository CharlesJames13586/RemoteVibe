/**
 * vnc.js — lock-screen control viewer (plan.md M5, "dual-track").
 *
 * Separate page from viewer.js's WebRTC flow entirely. Flow:
 *   1. Read the one-time relay `code` from the URL (Mac's UI hands out a
 *      link like /vnc.html?code=... — see mac-agent/renderer/renderer.js)
 *   2. Open a WebSocket to the signaling server's /vnc-relay endpoint and
 *      send {type:'viewer-attach', code}
 *   3. Once the server confirms {type:'attached'}, hand the SAME, already
 *      open WebSocket to noVNC's RFB class — from this point on, every
 *      byte over the socket is raw RFB protocol (screensharingd's output),
 *      not our JSON control messages.
 */

import RFB from './vendor/novnc/core/rfb.js';

(function () {
  'use strict';

  // TEMP-DEBUG: records key lifecycle events so they can be inspected via
  // devtools/automation without relying on console capture. Remove once
  // the "stuck after entering password" issue is diagnosed.
  window.__vncDebug = [];
  const debugLogEl = document.getElementById('debugLog');
  function dbg(line) {
    window.__vncDebug.push(line);
    if (debugLogEl) debugLogEl.textContent = window.__vncDebug.join('\n');
  }
  window.addEventListener('error', (e) => dbg('window error: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => dbg('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)));

  const params = new URLSearchParams(location.search);
  const CODE = params.get('code');
  const SIGNAL_URL = params.get('signal') ||
    (location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.hostname}:8080`);
  const RELAY_URL = SIGNAL_URL.replace(/\/+$/, '') + '/vnc-relay';

  const statusScreen = document.getElementById('statusScreen');
  const statusText   = document.getElementById('statusText');
  const statusError  = document.getElementById('statusError');
  const spinner      = document.getElementById('spinner');
  const retryBtn      = document.getElementById('retryBtn');
  const vncScreen     = document.getElementById('vncScreen');
  const vncContainer  = document.getElementById('vncContainer');
  const disconnectBtn = document.getElementById('vncDisconnectBtn');

  let ws = null;
  let rfb = null;
  // Set after the WS has been handed to noVNC — the signaling server can
  // still push one final JSON control frame ('peer-left') when the Mac's
  // bridge drops (local Screen Sharing failed/ended). It arrives as a TEXT
  // frame, so it's distinguishable from the binary RFB stream; we record
  // the reason so the 'disconnect' handler below can show something
  // specific instead of the generic "Connection lost."
  let sessionEndReason = null;

  function showError(message) {
    spinner.style.display = 'none';
    statusText.textContent = 'Could not connect';
    statusError.textContent = message;
    statusError.style.display = 'block';
    retryBtn.style.display = 'block';
  }

  function showStatus(text) {
    statusScreen.style.display = 'flex';
    vncScreen.classList.remove('active');
    spinner.style.display = 'block';
    statusError.style.display = 'none';
    retryBtn.style.display = 'none';
    statusText.textContent = text;
  }

  retryBtn.addEventListener('click', () => connect());

  function connect() {
    if (!CODE) {
      showError('No relay code in URL. Open the link shown on the Mac again.');
      return;
    }

    showStatus('Connecting to relay…');

    ws = new WebSocket(RELAY_URL);
    ws.binaryType = 'arraybuffer';

    const onOpen = () => {
      ws.send(JSON.stringify({ type: 'viewer-attach', code: CODE }));
    };

    const onMessage = (evt) => {
      // Pre-handoff, every message must be our JSON control protocol —
      // RFB bytes only start flowing after we've attached RFB below, by
      // which point this listener has been removed.
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return; // shouldn't happen pre-attach
      }

      switch (msg.type) {
        case 'attached':
          showStatus('Attached — starting screen session…');
          attachRfb();
          break;
        case 'error':
          showError(msg.message || 'Relay rejected the connection code.');
          break;
        case 'peer-left':
          showError('The Mac disconnected. Generate a new link from the Agent.');
          break;
      }
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', () => showError('Could not reach the relay server.'));
    ws.addEventListener('close', () => {
      if (!rfb) showError('Connection closed before attaching.');
    });

    // Stash removers so attachRfb() can detach our control-handshake
    // listeners before handing the socket to noVNC.
    ws._removeControlListeners = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onMessage);
    };
  }

  function attachRfb() {
    ws._removeControlListeners();

    // Keep a lightweight listener alive alongside noVNC's own message
    // handling. It only reacts to TEXT frames that parse as our JSON control
    // protocol (binary RFB bytes are never valid JSON and are ignored, so it
    // can't interfere with the video stream). See sessionEndReason above.
    ws.addEventListener('message', (evt) => {
      if (typeof evt.data !== 'string') return; // binary RFB bytes — leave to noVNC
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'peer-left') {
          sessionEndReason = msg.reason === 'mac-disconnected'
            ? 'The Mac ended the session — make sure Screen Sharing is enabled on the Mac (System Settings › General › Sharing), then generate a new link from the Agent.'
            : 'The Mac ended the session. Generate a new link from the Agent.';
        }
      } catch {
        // Not our JSON — ignore.
      }
    });

    // The Mac's own account password (same one used to log in / unlock
    // the screen) — screensharingd authenticates against it via the ARD
    // security type. noVNC's RFB handles that negotiation; we just need
    // to supply credentials when it asks via 'credentialsrequired'.
    rfb = new RFB(vncContainer, ws, { credentials: {} });

    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.background = '#000';

    rfb.addEventListener('credentialsrequired', () => {
      dbg('credentialsrequired fired, types=' + (rfb._rfbCredentials ? 'has-obj' : 'no-obj'));
      const password = window.prompt("Enter this Mac's login password to unlock:");
      dbg('prompt returned: ' + (password == null ? 'null/cancelled' : 'got-' + password.length + '-chars'));
      if (password == null) {
        showError('Password required to continue.');
        return;
      }
      try {
        rfb.sendCredentials({ username: '', password });
        dbg('sendCredentials called OK');
      } catch (e) {
        dbg('sendCredentials THREW: ' + e.message);
      }
    });

    rfb.addEventListener('connect', () => {
      dbg('connect fired');
      statusScreen.style.display = 'none';
      vncScreen.classList.add('active');
    });

    rfb.addEventListener('disconnect', (evt) => {
      dbg('disconnect fired, clean=' + evt.detail.clean + ', reason=' + (evt.detail.reason || ''));
      vncScreen.classList.remove('active');
      if (!evt.detail.clean) {
        showError(sessionEndReason || 'Connection lost.');
      } else {
        showStatus('Disconnected.');
        statusText.textContent = 'Disconnected.';
      }
    });

    rfb.addEventListener('securityfailure', (evt) => {
      dbg('securityfailure: ' + (evt.detail.reason || ''));
      showError(evt.detail.reason || 'Authentication failed — wrong password?');
    });
  }

  disconnectBtn.addEventListener('click', () => {
    if (rfb) { rfb.disconnect(); rfb = null; }
    if (ws) { ws.close(); ws = null; }
    showStatus('Disconnected.');
  });

  connect();
})();
