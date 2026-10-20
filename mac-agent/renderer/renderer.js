/**
 * Mac Agent renderer — runs in the Electron renderer process (has access to
 * navigator.mediaDevices.getUserMedia + RTCPeerConnection, i.e. full
 * Chromium WebRTC stack). Talks to main process via the `agentApi` bridge
 * for anything that needs Node/native access (permissions, nut.js input).
 */

(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const pinValueEl   = document.getElementById('pinValue');
  const pinExpiryEl  = document.getElementById('pinExpiry');
  const dotScreen    = document.getElementById('dotScreen');
  const dotAccess    = document.getElementById('dotAccess');
  const dotSignal    = document.getElementById('dotSignal');
  const connStateEl  = document.getElementById('connState');
  const localPreview = document.getElementById('localPreview');
  const screenPickerSection = document.getElementById('screenPickerSection');
  const screenPickerEl = document.getElementById('screenPicker');
  const signalUrlInput = document.getElementById('signalUrlInput');
  const signalUrlSave = document.getElementById('signalUrlSave');
  const signalUrlHint = document.getElementById('signalUrlHint');
  const vncSwitchEl = document.getElementById('vncSwitch');
  const vncStatusEl = document.getElementById('vncStatus');
  const vncLinkBoxEl = document.getElementById('vncLinkBox');
  const vncLinkTextEl = document.getElementById('vncLinkText');
  const vncCopyBtnEl = document.getElementById('vncCopyBtn');

  // ── Lock-screen control mode (plan.md M5) ───────────────────────────
  // Separate channel from the WebRTC flow above — see vnc-bridge.js for
  // why. Toggling this on asks the main process to dial out to the
  // signaling server's /vnc-relay endpoint and mint a one-time relay code;
  // we render that as a link to vnc.html for the user to open on their
  // phone (or scan/share however they like — it's just a URL).
  let vncBridgeRunning = false;
  let unsubscribeVncStatus = null;
  let currentVncLink = null;

  // Copy-to-clipboard with a fallback for contexts where
  // navigator.clipboard isn't available (Electron file:// pages are a secure
  // context so it usually is, but the legacy path costs nothing to keep).
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
  }

  vncCopyBtnEl.addEventListener('click', async () => {
    if (!currentVncLink) return;
    if (await copyText(currentVncLink)) {
      vncCopyBtnEl.textContent = 'Copied ✓';
      setTimeout(() => { vncCopyBtnEl.textContent = 'Copy Link'; }, 1500);
    } else {
      vncCopyBtnEl.textContent = 'Copy failed — select the link manually';
    }
  });

  function vncStatusText(status, detail) {
    switch (status) {
      case 'connecting-relay': return 'Connecting to relay server…';
      case 'waiting-for-viewer': return `Waiting for phone to connect… (${detail || ''})`;
      case 'connecting-local-vnc': return 'Phone attached — connecting to local Screen Sharing…';
      case 'bridging': return 'Bridging — phone can now see and control this Mac, even while locked.';
      case 'viewer-disconnected': return 'Phone disconnected. Toggle off/on to generate a new link.';
      case 'local-vnc-error': return `Error: ${detail}`;
      case 'relay-error': return `Relay error: ${detail}`;
      case 'relay-closed': return 'Relay connection closed.';
      case 'local-vnc-closed': return 'Local Screen Sharing connection closed.';
      default: return status;
    }
  }

  async function startVncBridge() {
    vncSwitchEl.classList.add('on');
    vncStatusEl.textContent = 'Starting…';
    vncLinkBoxEl.style.display = 'none';

    if (unsubscribeVncStatus) unsubscribeVncStatus();
    unsubscribeVncStatus = window.agentApi.onVncBridgeStatus(({ status, detail }) => {
      vncStatusEl.textContent = vncStatusText(status, detail);
    });

    const result = await window.agentApi.vncBridgeStart();
    if (!result.ok) {
      vncStatusEl.textContent = `Failed to start: ${result.error}`;
      vncSwitchEl.classList.remove('on');
      vncBridgeRunning = false;
      return;
    }

    vncBridgeRunning = true;
    const signalUrl = await window.agentApi.getSignalUrl();
    const httpBase = signalUrl.replace(/^ws/, 'http');
    const link = `${httpBase}/vnc.html?code=${result.code}`;
    currentVncLink = link;
    vncLinkTextEl.textContent = link;
    vncCopyBtnEl.textContent = 'Copy Link';
    vncLinkBoxEl.style.display = 'block';
  }

  async function stopVncBridge() {
    vncSwitchEl.classList.remove('on');
    vncBridgeRunning = false;
    currentVncLink = null;
    vncLinkBoxEl.style.display = 'none';
    vncStatusEl.textContent = "Off — uses macOS's own Screen Sharing, works even when the Mac is locked. Requires Screen Sharing enabled in System Settings > General > Sharing.";
    if (unsubscribeVncStatus) { unsubscribeVncStatus(); unsubscribeVncStatus = null; }
    await window.agentApi.vncBridgeStop();
  }

  vncSwitchEl.addEventListener('click', () => {
    if (vncBridgeRunning) stopVncBridge();
    else startVncBridge();
  });

  // ── Multi-monitor screen selection ──────────────────────────────────────
  // Previously hardcoded to sources[0] (always the primary display), which
  // meant a Mac with an external/extended monitor could only ever share
  // (and only ever receive correctly-mapped clicks on) whichever screen
  // happened to be "first" — usually the built-in display, not whatever
  // the user actually wanted to control remotely. `selectedSourceId`
  // drives which desktopCapturer source getUserMedia() captures;
  // `selectedDisplayId` drives both the capture resolution request (via
  // get-screen-size) and the main process's mouse-coordinate offset (via
  // set-active-display) — they're kept in lockstep via displayId on each
  // DesktopCapturerSource (Electron links the two).
  let selectedSourceId = null;
  let selectedDisplayId = null;

  // ── Signal URL config ──────────────────────────────────────────────────
  // In a packaged .app there's no shell to export SIGNAL_URL into, so the
  // URL is persisted to userData/config.json instead (main.js get/set-config
  // IPC) and edited from this input. Saving reconnects immediately.
  async function initSignalUrl() {
    const { signalUrl } = await window.agentApi.getConfig();
    signalUrlInput.value = signalUrl;
  }

  function normalizeSignalUrl(raw) {
    const v = raw.trim();
    if (!v) return null;
    // Accept a bare host (e.g. remote.example.com) and infer wss:// for
    // anything that isn't obviously local — a phone-facing deployment is
    // always TLS, and localhost is always plain ws.
    if (/^wss?:\/\//i.test(v)) return v.replace(/\/+$/, '');
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(v);
    return `${isLocal ? 'ws' : 'wss'}://${v}`.replace(/\/+$/, '');
  }

  signalUrlSave.addEventListener('click', async () => {
    const normalized = normalizeSignalUrl(signalUrlInput.value);
    if (!normalized) {
      signalUrlHint.textContent = 'Please enter a URL.';
      return;
    }
    signalUrlInput.value = normalized;
    await window.agentApi.setConfig({ signalUrl: normalized });
    signalUrlHint.textContent = `Saved → ${normalized} — reconnecting…`;
    restartSignaling();
  });

  signalUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signalUrlSave.click();
  });

  async function populateScreenPicker() {
    const [sources, displays] = await Promise.all([
      window.agentApi.getScreenSources(),
      window.agentApi.getDisplays(),
    ]);

    screenPickerEl.innerHTML = '';
    sources.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.dataset.displayId = s.displayId;
      const display = displays.find(d => String(d.id) === String(s.displayId));
      const primaryTag = display && display.isPrimary ? ' (Primary)' : '';
      opt.textContent = `${s.name}${primaryTag}`;
      screenPickerEl.appendChild(opt);
    });

    // Only show the picker at all when there's an actual choice to make —
    // a single-monitor Mac should look exactly like it did before this
    // feature existed.
    screenPickerSection.style.display = sources.length > 1 ? 'block' : 'none';

    if (sources.length > 0) {
      // Preserve the previous selection across re-populates (e.g. a
      // monitor was connected/disconnected) if it's still available;
      // otherwise default to the primary display's source.
      const stillValid = sources.find(s => s.id === selectedSourceId);
      const primarySource = sources.find(s => {
        const d = displays.find(dd => String(dd.id) === String(s.displayId));
        return d && d.isPrimary;
      });
      const chosen = stillValid || primarySource || sources[0];
      selectedSourceId = chosen.id;
      selectedDisplayId = chosen.displayId;
      screenPickerEl.value = selectedSourceId;
    }
  }

  screenPickerEl.addEventListener('change', async () => {
    const opt = screenPickerEl.selectedOptions[0];
    if (!opt) return;
    await switchToScreenSource(opt.value, opt.dataset.displayId);
  });

  // Shared by the local dropdown (above) and the DataChannel 'switch-screen'
  // message (see dataChannel.addEventListener('message') below) — the
  // iPhone viewer has its own screen-picker UI (plan.md follow-up) that
  // drives this same switch remotely, so both paths need to end up at
  // exactly the same place: update the selection state, hot-swap the
  // capture if already connected, and tell the viewer about the new list
  // (covers the edge case where displays changed between pairing and now).
  async function switchToScreenSource(sourceId, displayId) {
    selectedSourceId = sourceId;
    selectedDisplayId = displayId;
    screenPickerEl.value = sourceId;
    // If a viewer is already connected, re-capture and renegotiate against
    // the newly chosen screen immediately rather than waiting for the next
    // pairing — switching monitors mid-session should take effect right away.
    if (pc && pc.connectionState === 'connected') {
      await startScreenShareAndOffer();
    }
    sendScreenListToViewer();
  }

  // Pushes the current screen list + which one is active down the
  // DataChannel so the iPhone viewer can render its own screen-picker UI.
  // Sent once when the DataChannel first opens (viewer needs the initial
  // list) and again after every switch (keeps the viewer's "currently
  // selected" highlight in sync, including switches made from the Mac's
  // own dropdown — not just ones the phone itself requested).
  async function sendScreenListToViewer() {
    if (!dataChannel || dataChannel.readyState !== 'open') return;
    const sources = await window.agentApi.getScreenSources();
    dataChannel.send(JSON.stringify({
      type: 'screen-list',
      screens: sources.map(s => ({ id: s.id, name: s.name })),
      activeId: selectedSourceId,
    }));
  }

  // ── WebRTC config ────────────────────────────────────────────────────────
  // STUN is always available; TURN relay credentials are fetched fresh
  // from the signaling server's /turn-credentials endpoint right before
  // each new RTCPeerConnection (see buildRtcConfig below) so they stay
  // within their 1h TTL and this deployment doesn't need a long-lived
  // secret baked into client-side JS.
  const STUN_ONLY_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  async function buildRtcConfig() {
    try {
      const signalUrl = await window.agentApi.getSignalUrl();
      // Signaling URL is ws(s)://host[:port] — swap scheme for http(s) to
      // hit the same server's plain HTTP credential endpoint.
      const httpBase = signalUrl.replace(/^ws/, 'http');
      const res = await fetch(`${httpBase}/turn-credentials?label=mac-agent`);
      const { turnServer } = await res.json();
      if (!turnServer) {
        console.log('[webrtc] TURN not configured on this deployment — STUN-only');
        return STUN_ONLY_CONFIG;
      }
      console.log('[webrtc] TURN credentials acquired, expires in', turnServer.ttl, 's');
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, turnServer] };
    } catch (e) {
      console.warn('[webrtc] failed to fetch TURN credentials, falling back to STUN-only:', e.message);
      return STUN_ONLY_CONFIG;
    }
  }

  let ws = null;
  let pc = null;
  let dataChannel = null;
  let localStream = null;
  let videoSender = null; // RTCRtpSender for the screen-share video track — kept around so switching monitors can replaceTrack() instead of renegotiating
  let currentRoom = { pin: null, token: null };

  // Monotonically increasing generation counter — bumped every time the
  // user saves a new Signal URL (via restartSignaling). The WS close
  // handler's setTimeout callback captures the generation at creation
  // time; if it's stale by the time it fires, it silently no-ops instead
  // of opening a second parallel connection.
  let signalingGeneration = 0;

  function restartSignaling() {
    signalingGeneration += 1;
    if (ws) {
      // Suppress the automatic reconnect built into the 'close' handler
      // so only the explicit fresh call below reconnects.
      ws._manualClose = true;
      ws.close();
      ws = null;
    }
    teardownConnection();
    pinValueEl.textContent = '------';
    clearInterval(countdownTimer);
    pinExpiryEl.textContent = '';
    connStateEl.textContent = 'Reconnecting…';
    connStateEl.classList.remove('connected');
    connectSignaling();
  }

  // ── Permission UI ────────────────────────────────────────────────────────
  async function refreshPermissions() {
    const { screen: screenStatus, accessibility } = await window.agentApi.checkPermissions();

    dotScreen.className = 'dot ' + (screenStatus === 'granted' ? 'ok' : 'bad');
    dotAccess.className = 'dot ' + (accessibility ? 'ok' : 'bad');
  }

  document.getElementById('fixScreen').addEventListener('click', () => {
    window.agentApi.openScreenRecordingSettings();
  });
  document.getElementById('fixAccess').addEventListener('click', async () => {
    await window.agentApi.requestAccessibility();
    window.agentApi.openAccessibilitySettings();
  });

  // ── Signaling connection ─────────────────────────────────────────────────
  async function connectSignaling() {
    const url = await window.agentApi.getSignalUrl();
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      dotSignal.className = 'dot ok';
      ws.send(JSON.stringify({ type: 'register' }));
    });

    ws.addEventListener('close', () => {
      dotSignal.className = 'dot bad';
      pinValueEl.textContent = '------';
      if (ws && ws._manualClose) return; // restartSignaling() handles reconnect
      // Simple backoff reconnect — guard with the generation captured NOW
      // so a later restartSignaling() call that bumps the counter will
      // make this timer a no-op rather than opening a second WS.
      const gen = signalingGeneration;
      setTimeout(() => {
        if (gen === signalingGeneration) connectSignaling();
      }, 3000);
    });

    ws.addEventListener('error', () => ws.close());

    ws.addEventListener('message', async (evt) => {
      const msg = JSON.parse(evt.data);

      switch (msg.type) {
        case 'registered':
          currentRoom.pin = msg.pin;
          pinValueEl.textContent = msg.pin;
          startPinCountdown(msg.expiresInMs);
          console.log(`PIN registered: ${msg.pin} (expires in ${Math.floor(msg.expiresInMs / 1000)}s)`);
          break;

        case 'pin-expired':
          pinValueEl.textContent = '------';
          pinExpiryEl.textContent = 'PIN expired — requesting a new one…';
          ws.send(JSON.stringify({ type: 'register' }));
          break;

        case 'paired':
          currentRoom.token = msg.token;
          connStateEl.textContent = 'Viewer paired — starting screen share…';
          // Only mint a brand-new trusted-device token for PIN-based
          // pairings. If this pairing happened via an existing device
          // token (viaDeviceToken), the viewer already has a valid token
          // and re-issuing one here would just orphan the old one.
          if (!msg.viaDeviceToken) {
            const { rawToken } = await window.agentApi.issueDeviceToken();
            ws.send(JSON.stringify({ type: 'device-token-issued', deviceToken: rawToken }));
          }
          refreshDeviceList();
          await startScreenShareAndOffer();
          break;

        // ── A viewer is attempting a passwordless reconnect with a
        // previously-issued deviceToken. The signaling server has no way
        // to validate it itself (devices.json lives only on this Mac), so
        // it relays the token here for us to check.
        case 'verify-token': {
          const record = await window.agentApi.validateDeviceToken(msg.deviceToken);
          ws.send(JSON.stringify({
            type: 'token-verified',
            verifyId: msg.verifyId,
            valid: !!record,
            deviceLabel: record ? record.deviceLabel : undefined,
          }));
          if (record) refreshDeviceList();
          break;
        }

        case 'answer':
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          break;

        case 'ice-candidate':
          if (msg.candidate) {
            try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); }
          }
          break;

        case 'peer-left':
          connStateEl.textContent = 'Viewer disconnected. Waiting for new PIN…';
          connStateEl.classList.remove('connected');
          teardownConnection();
          // The signaling server now rotates this same room onto a fresh
          // PIN in-place (see signaling-server/index.js `rotateRoomPin`)
          // and pushes a new 'registered' message on its own — no need to
          // (and must NOT) send our own 'register' here, which would
          // create a second, orphaned room for this same connection and
          // break the "find my room" lookup that passwordless reconnects
          // depend on.
          pinValueEl.textContent = '------';
          clearInterval(countdownTimer);
          pinExpiryEl.textContent = '';
          break;

        case 'error':
          console.error('[signal] error:', msg.message);
          break;
      }
    });
  }

  let countdownTimer = null;
  function startPinCountdown(ms) {
    clearInterval(countdownTimer);
    let remaining = Math.floor(ms / 1000);
    const tick = () => {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      pinExpiryEl.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
      remaining -= 1;
      if (remaining < 0) clearInterval(countdownTimer);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ── Screen capture + WebRTC offer ───────────────────────────────────────
  // Captures the currently-selected screen (selectedSourceId/selectedDisplayId,
  // see the screen picker above) and either starts a brand-new WebRTC
  // session (no pc yet) or hot-swaps the video track on an existing one
  // (pc already connected — e.g. user switched monitors mid-session).
  // sender.replaceTrack() does NOT require renegotiation (no new
  // offer/answer round-trip) since the transceiver itself doesn't change,
  // only the track's content — this keeps a live monitor switch fast and
  // avoids the complexity/fragility of re-doing SDP negotiation.
  async function captureSelectedScreen() {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    const sources = await window.agentApi.getScreenSources();
    if (sources.length === 0) {
      connStateEl.textContent = 'No screen source available (check Screen Recording permission)';
      return null;
    }
    // Fall back to whatever populateScreenPicker() last resolved; guards
    // against captureSelectedScreen() being called before that initial
    // population finishes (shouldn't happen in practice since boot calls
    // populateScreenPicker() first, but keeps this function self-contained).
    const source = sources.find(s => s.id === selectedSourceId) || sources[0];

    // Tell the main process which display's mouse-coordinate bounds to use
    // for this capture — see main.js `set-active-display` and
    // input-inject.js's displayBounds parameter. Must happen before/with
    // every capture so mouse clicks always target the currently-shared
    // monitor, not whichever one was selected last time.
    if (source.displayId) {
      await window.agentApi.setActiveDisplay(Number(source.displayId));
    }

    // Query the real screen resolution so we can request full-resolution
    // capture below instead of letting Chromium pick a default (which is
    // often a downsampled size well below actual screen res).
    const { width: screenWidth, height: screenHeight } =
      await window.agentApi.getScreenSize(source.displayId ? Number(source.displayId) : undefined);

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          // Without explicit min/max width/height, Chromium's WebRTC stack
          // aggressively downsamples desktop-capture tracks to save
          // bandwidth (often well below the actual screen resolution).
          // Pin both min and max to the real screen size so we always
          // request full-resolution capture; the far end's video element
          // still scales to fit its viewport, so this only affects
          // sharpness/bandwidth, not layout.
          minWidth: screenWidth,
          maxWidth: screenWidth,
          minHeight: screenHeight,
          maxHeight: screenHeight,
          maxFrameRate: 30,
        },
      },
    });

    localPreview.srcObject = localStream;

    const videoTrackForLog = localStream.getVideoTracks()[0];
    console.log('[capture] video track:', videoTrackForLog.label, videoTrackForLog.getSettings());
    videoTrackForLog.addEventListener('ended', () => console.warn('[capture] video track ended unexpectedly'));
    videoTrackForLog.addEventListener('mute', () => console.warn('[capture] video track muted'));
    videoTrackForLog.addEventListener('unmute', () => console.log('[capture] video track unmuted'));

    return localStream.getVideoTracks()[0];
  }

  async function startScreenShareAndOffer() {
    // Mid-session screen switch: an existing, live connection just needs
    // its track swapped — no new PeerConnection, no renegotiation.
    if (pc && pc.connectionState === 'connected' && videoSender) {
      const newTrack = await captureSelectedScreen();
      if (newTrack) await videoSender.replaceTrack(newTrack);
      return;
    }

    const videoTrack = await captureSelectedScreen();
    if (!videoTrack) return;

    pc = new RTCPeerConnection(await buildRtcConfig());
    videoSender = pc.addTrack(videoTrack, localStream);

    // Chromium's default bitrate cap for WebRTC video is tuned for webcam
    // resolutions (~720p) and will heavily compress a full-resolution
    // desktop capture, making text/UI blurry even though we requested a
    // high-res track above. Raise the cap so detail is preserved — desktop
    // screen content compresses well, so even at 1080p+ this stays
    // reasonable on a typical broadband/4G connection.
    try {
      const params = videoSender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      params.encodings[0].maxBitrate = 8_000_000; // 8 Mbps
      await videoSender.setParameters(params);
    } catch (e) {
      console.warn('[webrtc] could not raise sender bitrate cap:', e);
    }

    // DataChannel for receiving mouse/keyboard input from the viewer, and
    // for pushing/receiving screen-list control messages (multi-monitor
    // switching from the phone — see sendScreenListToViewer below and the
    // 'switch-screen' case in the message handler).
    dataChannel = pc.createDataChannel('control');
    dataChannel.addEventListener('open', () => {
      console.log('[datachannel] opened, readyState=' + dataChannel.readyState);
      sendScreenListToViewer();
    });
    dataChannel.addEventListener('message', async (evt) => {
      console.log('[datachannel] message received:', evt.data);
      try {
        const data = JSON.parse(evt.data);
        // Control-plane messages handled here, not forwarded to nut.js —
        // everything else (mousemove/click/keydown/text/etc.) goes to the
        // Mac's actual mouse/keyboard via the main process as before.
        if (data.type === 'switch-screen') {
          const sources = await window.agentApi.getScreenSources();
          const source = sources.find(s => s.id === data.sourceId);
          if (source) await switchToScreenSource(source.id, source.displayId);
          return;
        }
        window.agentApi.injectInput(data);
      } catch (e) {
        console.warn('[datachannel] bad message', e);
      }
    });

    pc.addEventListener('icecandidate', (evt) => {
      if (evt.candidate) {
        ws.send(JSON.stringify({ type: 'ice-candidate', candidate: evt.candidate }));
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      connStateEl.textContent = `Connection: ${pc.connectionState}`;
      connStateEl.classList.toggle('connected', pc.connectionState === 'connected');
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
  }

  function teardownConnection() {
    if (dataChannel) { dataChannel.close(); dataChannel = null; }
    if (pc) { pc.close(); pc = null; }
    videoSender = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    currentRoom.token = null;
  }

  // ── Trusted device list (plan.md §4 "device auto-reconnect") ───────────
  // Lets the user see which iPhones currently have a 24h passwordless
  // reconnect token, and revoke them individually or all at once — the
  // only way to invalidate a token early (e.g. phone lost/stolen), since
  // tokens otherwise just sit valid until their 24h expiry.
  const deviceListEl = document.getElementById('deviceList');
  const revokeAllBtn = document.getElementById('revokeAll');

  function formatRemaining(expiresAt) {
    const ms = expiresAt - Date.now();
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
  }

  async function refreshDeviceList() {
    const devices = await window.agentApi.listDevices();
    deviceListEl.innerHTML = '';

    if (devices.length === 0) {
      deviceListEl.innerHTML = '<div class="device-empty">No trusted devices yet</div>';
      revokeAllBtn.style.display = 'none';
      return;
    }

    revokeAllBtn.style.display = 'block';
    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'device-row';
      row.innerHTML = `
        <div class="device-info">
          <div class="device-label">${d.deviceLabel}</div>
          <div class="device-meta">Last seen ${new Date(d.lastSeenAt).toLocaleTimeString()} · ${formatRemaining(d.expiresAt)}</div>
        </div>
        <button class="fix-btn device-revoke" data-id="${d.id}">Revoke</button>
      `;
      deviceListEl.appendChild(row);
    }

    deviceListEl.querySelectorAll('.device-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.agentApi.revokeDevice(btn.dataset.id);
        refreshDeviceList();
      });
    });
  }

  revokeAllBtn.addEventListener('click', async () => {
    await window.agentApi.revokeAllDevices();
    refreshDeviceList();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  initSignalUrl();
  refreshPermissions();
  setInterval(refreshPermissions, 5000);
  refreshDeviceList();
  setInterval(refreshDeviceList, 30_000); // keep "Xh Ym left" countdowns fresh
  populateScreenPicker();
  connectSignaling();
})();
