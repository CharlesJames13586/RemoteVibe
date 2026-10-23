/**
 * Web Viewer — runs in iPhone Safari, no app install required.
 *
 * Flow: enter PIN -> signaling server pairs with Mac Agent -> Agent sends
 * WebRTC offer -> we answer -> video track renders in <video> -> touch and
 * keyboard events are sent back over the DataChannel the Agent created.
 */

(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────
  // Same-origin by default (viewer is served by the signaling server's HTTPS
  // host in production); override via ?signal=wss://... for local dev against
  // a signaling server running on a different port.
  const params = new URLSearchParams(location.search);
  const SIGNAL_URL = params.get('signal') ||
    (location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.hostname}:8080`);

  const RTC_CONFIG_STUN_ONLY = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // TURN relay credentials, fetched fresh (1h TTL) right before each new
  // RTCPeerConnection — see signaling-server/index.js `/turn-credentials`.
  // httpBase mirrors SIGNAL_URL's host so this works both same-origin
  // (production) and when ?signal= points at a different dev port.
  async function buildRtcConfig() {
    try {
      const httpBase = SIGNAL_URL.replace(/^ws/, 'http');
      const res = await fetch(`${httpBase}/turn-credentials?label=viewer`);
      const { turnServer } = await res.json();
      if (!turnServer) {
        console.log('[webrtc] TURN not configured on this deployment — STUN-only');
        return RTC_CONFIG_STUN_ONLY;
      }
      console.log('[webrtc] TURN credentials acquired, expires in', turnServer.ttl, 's');
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, turnServer] };
    } catch (e) {
      console.warn('[webrtc] failed to fetch TURN credentials, falling back to STUN-only:', e.message);
      return RTC_CONFIG_STUN_ONLY;
    }
  }

  // ── DOM refs ─────────────────────────────────────────────────────────────
  const pairScreen   = document.getElementById('pairScreen');
  const viewerScreen = document.getElementById('viewerScreen');
  const pinInput     = document.getElementById('pinInput');
  const joinBtn      = document.getElementById('joinBtn');
  const pairError    = document.getElementById('pairError');
  const pairHint      = document.getElementById('pairHint');
  const remoteVideo  = document.getElementById('remoteVideo');
  const connDot      = document.getElementById('connDot');
  const connText     = document.getElementById('connText');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const keyboardToggle = document.getElementById('keyboardToggle');
  const hiddenInput  = document.getElementById('hiddenInput');
  const screenToggle = document.getElementById('screenToggle');
  const screenSheetBackdrop = document.getElementById('screenSheetBackdrop');
  const screenOptionsEl = document.getElementById('screenOptions');

  let ws = null;
  let pc = null;
  let dataChannel = null;
  let sessionToken = null;

  // ── Trusted-device auto-reconnect (plan.md §4) ─────────────────────────
  // A deviceToken issued after a prior PIN pairing lets us skip the PIN
  // screen entirely on return visits — this is the whole point of 方案 B.
  // Stored in localStorage: scoped to this origin, survives page reloads
  // and app restarts, cleared only by the user clearing browser data or
  // by the Mac revoking the device (which we detect via an 'invalid-token'
  // error and fall back to the PIN screen for).
  const DEVICE_TOKEN_KEY = 'remoteControlDeviceToken';

  function getSavedToken() {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  }
  function saveToken(token) {
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  }
  function clearSavedToken() {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  }

  // ── Pairing ──────────────────────────────────────────────────────────────
  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
    pairError.textContent = '';
  });

  joinBtn.addEventListener('click', () => join());
  pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  function join() {
    const pin = pinInput.value.trim();
    if (pin.length !== 6) {
      pairError.textContent = 'Enter the full 6-digit PIN';
      return;
    }
    joinBtn.disabled = true;
    pairError.textContent = '';
    connectSignalingWithPin(pin);
  }

  function connectSignalingWithPin(pin) {
    ws = new WebSocket(SIGNAL_URL);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', pin }));
    });
    wireCommonSocketHandlers();
  }

  // Attempt a passwordless reconnect using a previously-saved deviceToken.
  // Called automatically on page load if a token exists; silently falls
  // back to showing the PIN screen on any failure (expired/revoked token,
  // no Agent currently online, etc.) rather than surfacing an error for
  // what is, from the user's perspective, just "first time connecting".
  function tryAutoReconnect(token) {
    pairHint.textContent = 'Reconnecting…';
    joinBtn.disabled = true;
    ws = new WebSocket(SIGNAL_URL);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join-with-token', deviceToken: token }));
    });
    wireCommonSocketHandlers();
  }

  function wireCommonSocketHandlers() {
    ws.addEventListener('error', () => {
      pairError.textContent = 'Could not reach the server. Check your connection.';
      joinBtn.disabled = false;
      pairHint.textContent = '';
    });

    ws.addEventListener('close', () => {
      if (viewerScreen.style.display === 'block') {
        setConnState('failed', 'Disconnected');
      }
    });

    ws.addEventListener('message', async (evt) => {
      const msg = JSON.parse(evt.data);

      switch (msg.type) {
        case 'error':
          // A rejected deviceToken (expired/revoked) must not be retried
          // silently forever — drop it and let the user re-pair via PIN.
          if (msg.code === 'invalid-token') {
            clearSavedToken();
            pairHint.textContent = '';
            pairError.textContent = 'Saved device expired — please re-enter the PIN';
          } else if (msg.code === 'agent-offline' && getSavedToken()) {
            pairHint.textContent = '';
            pairError.textContent = 'Mac is offline. Start the Agent, then enter the PIN once more.';
          } else {
            pairError.textContent = msg.message || 'Pairing failed';
          }
          joinBtn.disabled = false;
          break;

        case 'paired':
          sessionToken = msg.token;
          showViewer();
          await preparePeerConnection();
          break;

        // The Agent only sends this once, right after a fresh PIN pairing
        // (see renderer.js `case 'paired'`) — this is the one time the raw
        // token ever crosses the wire. Persist it for all future reconnects.
        case 'device-token-issued':
          saveToken(msg.deviceToken);
          console.log('[device-token] saved for future passwordless reconnects');
          break;

        case 'offer':
          await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
          break;

        case 'ice-candidate':
          if (msg.candidate) {
            try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); }
          }
          break;

        case 'peer-left':
          setConnState('failed', 'Mac disconnected');
          teardown();
          break;
      }
    });
  }

  function showViewer() {
    pairScreen.style.display = 'none';
    viewerScreen.style.display = 'block';
    // Initialize position/size to the current actual visible viewport
    // right away, rather than relying on the CSS 100dvh/100vw defaults —
    // keeps #viewerScreen's inline styles and visualViewport in sync from
    // the very first frame (matters if, e.g., the keyboard from a prior
    // PIN entry is still animating closed when this runs).
    adjustForKeyboard();
  }

  function setConnState(state, label) {
    connDot.className = state;
    connText.textContent = label;
  }

  // ── WebRTC peer connection (answering side) ────────────────────────────
  async function preparePeerConnection() {
    pc = new RTCPeerConnection(await buildRtcConfig());

    pc.addEventListener('track', (evt) => {
      remoteVideo.srcObject = evt.streams[0];
      const vt = evt.track;
      console.log('[webrtc] track received:', vt.kind, vt.readyState, vt.muted ? 'muted' : 'unmuted');
      vt.addEventListener('mute', () => console.warn('[webrtc] remote track muted (likely no frames incoming)'));
      vt.addEventListener('unmute', () => console.log('[webrtc] remote track unmuted — frames flowing'));

      // iOS Safari only allows autoplay for MUTED <video> elements (already
      // set via the `muted` attribute in index.html — do not remove it).
      // Even with that attribute, autoplay can still be silently blocked in
      // some cases (e.g. page was backgrounded right as the track arrived),
      // leaving srcObject correctly set but the element never actually
      // playing — which looks exactly like "connected but black screen".
      // An explicit .play() call recovers from that; the catch is required
      // because .play() rejects if the browser still refuses (rare, but
      // logging it beats silently failing again).
      remoteVideo.play().catch(err => {
        console.warn('[video] autoplay was blocked, retrying play():', err.message);
      });
    });

    pc.addEventListener('icecandidate', (evt) => {
      if (evt.candidate) {
        ws.send(JSON.stringify({ type: 'ice-candidate', candidate: evt.candidate }));
      }
    });

    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      if (state === 'connected') setConnState('connected', 'Connected');
      else if (state === 'failed' || state === 'disconnected') setConnState('failed', 'Connection lost');
      else setConnState('', 'Connecting…');
    });

    // Agent creates the DataChannel; we just listen for it.
    pc.addEventListener('datachannel', (evt) => {
      dataChannel = evt.channel;
      dataChannel.addEventListener('open', () => console.log('[datachannel] open'));
      // Mac pushes 'screen-list' right after open (and again after every
      // switch, including ones made from its own local dropdown) — see
      // renderer.js sendScreenListToViewer(). Everything else (keydown
      // acks etc.) the Agent might someday send over this channel is
      // intentionally ignored here; this viewer only ever sends control
      // messages, it doesn't expect replies for those.
      dataChannel.addEventListener('message', (msgEvt) => {
        try {
          const data = JSON.parse(msgEvt.data);
          if (data.type === 'screen-list') renderScreenOptions(data.screens, data.activeId);
        } catch (e) {
          console.warn('[datachannel] bad message from Agent', e);
        }
      });
    });
  }

  function sendControl(msg) {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify(msg));
    }
  }

  // ── Multi-monitor screen switching ──────────────────────────────────────
  // screenToggle/the sheet it opens are only ever shown when the Mac
  // reports 2+ screens (renderScreenOptions below) — a single-monitor Mac
  // never surfaces this, matching the symmetric behavior on the Agent's
  // own screen-picker dropdown (mac-agent/renderer/index.html), which is
  // also hidden for single-monitor setups.
  function renderScreenOptions(screens, activeId) {
    screenToggle.style.display = screens.length > 1 ? 'block' : 'none';
    screenOptionsEl.innerHTML = '';
    screens.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'screen-option' + (s.id === activeId ? ' active' : '');
      btn.textContent = s.name;
      btn.addEventListener('click', () => {
        sendControl({ type: 'switch-screen', sourceId: s.id });
        closeScreenSheet();
      });
      screenOptionsEl.appendChild(btn);
    });
  }

  function openScreenSheet() {
    screenSheetBackdrop.style.display = 'block';
  }
  function closeScreenSheet() {
    screenSheetBackdrop.style.display = 'none';
  }

  screenToggle.addEventListener('click', openScreenSheet);
  // Tapping the dimmed backdrop (but not the sheet itself) dismisses it —
  // standard bottom-sheet behavior. The sheet's own click doesn't bubble
  // to the backdrop handler because screen-option buttons call
  // closeScreenSheet() explicitly and stopPropagation isn't needed since
  // #screenSheet itself has no click handler to conflict with.
  screenSheetBackdrop.addEventListener('click', (e) => {
    if (e.target === screenSheetBackdrop) closeScreenSheet();
  });

  // ── Keyboard-aware layout (avoid the video area overlapping the iOS
  // on-screen keyboard) ───────────────────────────────────────────────────
  // #viewerScreen is normally 100dvh/100vw (full screen). On iPhone, 100dvh
  // is the LARGE viewport size and does NOT shrink when the on-screen
  // keyboard opens in Safari — the video element keeps rendering at full
  // size underneath the keyboard overlay. The bottom portion of the Mac
  // screen ends up hidden behind the keyboard, so taps anywhere near/under
  // the keyboard land on video content that's no longer visible.
  //
  // window.visualViewport.{width,height,offsetLeft,offsetTop} DO update
  // live when the keyboard opens (this is the whole reason the API
  // exists). Crucially, offsetLeft/offsetTop are NOT always zero while the
  // keyboard is open — Safari sometimes scrolls the page to bring the
  // focused input into view, shifting the visible viewport's origin
  // sideways/up relative to the document. If we only resize #viewerScreen
  // (fixed at top:0/left:0) without also repositioning it to that shifted
  // origin, the element stays glued to the document's top-left while the
  // user's actual visible window has moved elsewhere — which is exactly
  // the "half the screen is off to the left" symptom. Setting all four
  // values keeps #viewerScreen glued to whatever is ACTUALLY visible.
  //
  // The video's object-fit:contain + getDisplayedVideoRect() then
  // naturally re-letterbox within that repositioned/resized area — no
  // further changes needed beyond keeping #viewerScreen in sync here.
  function adjustForKeyboard() {
    if (!window.visualViewport) return; // very old Safari — no-op, keep 100dvh/100vw
    const vv = window.visualViewport;
    viewerScreen.style.top = `${vv.offsetTop}px`;
    viewerScreen.style.left = `${vv.offsetLeft}px`;
    viewerScreen.style.width = `${vv.width}px`;
    viewerScreen.style.height = `${vv.height}px`;
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    // Also handle the keyboard opening/closing changing the viewport
    // offset (iOS sometimes scrolls the page instead of/in addition to
    // resizing when a focused input is near the bottom).
    window.visualViewport.addEventListener('scroll', adjustForKeyboard);
  }

  // ── Touch gesture handling: click / pan / pinch-zoom / double-tap-reset ──
  // Coordinates sent to the Agent are normalized (0..1) relative to the
  // ACTUAL RENDERED VIDEO FRAME, so the Agent can map them onto the real
  // screen resolution.
  //
  // IMPORTANT: #remoteVideo uses `object-fit: contain` (see index.html) and
  // is sized to fill its container (width/height: 100%). When the video's
  // native aspect ratio doesn't exactly match the container's (near-certain
  // whenever the Mac's screen isn't the same aspect ratio as the phone
  // viewport, or the remote desktop isn't truly fullscreen-shaped), `contain`
  // adds letterbox/pillarbox bars — black padding — on two sides. Naively
  // using getBoundingClientRect() (the full element box, bars included) to
  // compute the click ratio means taps inside the bars get linearly mapped
  // into the real screen area, and every other tap is off by the bar size —
  // this is the "click doesn't track" bug. We must first compute the actual
  // displayed video rect (excluding bars) using the video's native
  // videoWidth/videoHeight, then map clicks against THAT rect only.
  //
  // Pinch-to-zoom / pan is implemented with a CSS transform (translate+scale)
  // applied directly to #remoteVideo with transform-origin:0 0. Because
  // getBoundingClientRect() returns the element's RENDERED (post-transform)
  // box, the letterbox math below automatically stays correct at any
  // zoom/pan state without any changes — zooming/panning the video is
  // transparent to click-coordinate mapping.
  function getDisplayedVideoRect() {
    const rect = remoteVideo.getBoundingClientRect();
    const vw = remoteVideo.videoWidth;
    const vh = remoteVideo.videoHeight;

    // Before the first frame arrives, videoWidth/videoHeight are 0 — fall
    // back to the full element box rather than dividing by zero.
    if (!vw || !vh) return rect;

    const elementAspect = rect.width / rect.height;
    const videoAspect = vw / vh;

    if (videoAspect > elementAspect) {
      // Video is relatively wider than the element → letterboxed top/bottom
      // (black bars above and below); full width is used.
      const displayedHeight = rect.width / videoAspect;
      const barHeight = (rect.height - displayedHeight) / 2;
      return {
        left: rect.left,
        top: rect.top + barHeight,
        width: rect.width,
        height: displayedHeight,
      };
    } else {
      // Video is relatively taller than the element → pillarboxed left/right
      // (black bars on the sides); full height is used.
      const displayedWidth = rect.height * videoAspect;
      const barWidth = (rect.width - displayedWidth) / 2;
      return {
        left: rect.left + barWidth,
        top: rect.top,
        width: displayedWidth,
        height: rect.height,
      };
    }
  }

  function videoRelativeCoords(clientX, clientY) {
    const rect = getDisplayedVideoRect();
    const x = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 1);
    return { x, y };
  }

  // ── Zoom/pan state ───────────────────────────────────────────────────────
  // scale/translateX/translateY describe a CSS transform applied to
  // #remoteVideo itself. transform-origin is pinned to the top-left (0 0)
  // so the math below (anchor-preserving pinch zoom, pan-bounds clamping)
  // doesn't have to account for a shifting origin.
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 3;

  remoteVideo.style.transformOrigin = '0 0';

  function applyTransform() {
    remoteVideo.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  // Keep the panned/zoomed video from drifting entirely off-screen: clamp
  // translateX/Y so the (scaled) video box always still overlaps the
  // container. Container = #viewerScreen's own box, which is NOT itself
  // transformed (only #remoteVideo is), so its rect is a stable reference.
  function clampTranslate() {
    const rect = viewerScreen.getBoundingClientRect();
    const minTx = rect.width * (1 - scale);  // <= 0 since scale >= 1
    const minTy = rect.height * (1 - scale);
    translateX = Math.min(Math.max(translateX, minTx), 0);
    translateY = Math.min(Math.max(translateY, minTy), 0);
  }

  function resetZoom() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    // Animate the snap-back so it reads as an intentional "reset" rather
    // than an abrupt jump; the transition is removed right after so it
    // doesn't fight with the per-frame pinch/pan updates on the next gesture.
    remoteVideo.style.transition = 'transform 0.2s ease-out';
    applyTransform();
    setTimeout(() => { remoteVideo.style.transition = ''; }, 220);
  }

  function touchDistance(t0, t1) {
    return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
  }
  function touchMidpoint(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }

  // Double-tap-to-reset is only ever considered while zoomed in (scale>1).
  // This is deliberate: at scale===1 there's nothing to "reset", and more
  // importantly, intercepting double-tap there would break the ability to
  // send a genuine double-click to the Mac (e.g. to open a file) — two
  // quick taps at scale 1 must keep forwarding as two independent 'click'
  // messages, exactly as before this feature was added.
  const DOUBLE_TAP_MS = 350;
  const DOUBLE_TAP_DIST_PX = 30;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  function isDoubleTap(x, y, now) {
    return (now - lastTapTime) < DOUBLE_TAP_MS &&
      Math.hypot(x - lastTapX, y - lastTapY) < DOUBLE_TAP_DIST_PX;
  }

  // ── Throttle high-frequency pointer-move events ─────────────────────────
  // (touchmove fires at up to ~60Hz on iOS). Without this, a burst of
  // mousemove messages can arrive at the Agent faster than nut.js can
  // process them, and — combined with the DataChannel's unordered delivery
  // under load — a stale position can overwrite a newer one, making the
  // cursor appear to "get stuck"/lag behind or jump backwards. 50ms
  // (~20Hz) is smooth enough for cursor tracking while giving the Agent
  // breathing room to keep up. Only used by the scale===1 "click-drag"
  // path below (mouse-control mode) — panning while zoomed never sends
  // mouse messages at all, per the explicit design decision that zoomed
  // single-finger drags move the VIEW, not the remote cursor.
  const MOVE_THROTTLE_MS = 50;
  let lastMoveSentAt = 0;
  let lastTouch = null;
  function sendMouseMoveThrottled(coords) {
    const now = Date.now();
    if (now - lastMoveSentAt < MOVE_THROTTLE_MS) return;
    lastMoveSentAt = now;
    sendControl({ type: 'mousemove', ...coords });
  }

  // ── Unified multi-touch gesture state machine ───────────────────────────
  // activeTouchMode:
  //   'click-drag'  — scale===1: original behavior. Every touchmove sends a
  //                   live mousemove (dragging the remote cursor); touchend
  //                   sends a click if the gesture was short (<300ms).
  //   'pan-or-tap'  — scale>1: a short tap (little/no movement) still sends
  //                   a click (mapped through the current zoom/pan
  //                   transform, so it lands on the right spot); a sustained
  //                   drag instead PANS THE VIEW and sends no mouse
  //                   messages at all — per the explicit design decision
  //                   that there is no "drag the remote mouse while zoomed"
  //                   gesture on phones.
  //   'pinch'       — two fingers down: resolved on first movement into
  //                   either live pinch-to-zoom (anchored so the content
  //                   under the fingers' midpoint stays fixed) or a wheel
  //                   scroll of the remote Mac window.
  let activeTouchMode = null;
  let gestureTouchStartTime = 0;
  let gestureStartClientX = 0;
  let gestureStartClientY = 0;
  let gestureMoved = false;
  let panStartTranslateX = 0;
  let panStartTranslateY = 0;
  let pinchLastDistance = 0;

  // Two-finger drag → wheel scroll on the Mac. The Agent has always known
  // how to inject 'scroll' (input-inject.js), but nothing ever sent it, so
  // scrollable Mac windows could not be scrolled from the phone at all.
  // Two fingers are shared with pinch-to-zoom, hence the one-shot intent
  // latch below: whichever interpretation the first ~10px of movement
  // supports wins for the rest of the gesture.
  const TWO_FINGER_DISTANCE_THRESHOLD_PX = 12; // finger spread change ⇒ pinch
  const TWO_FINGER_MID_THRESHOLD_PX = 10; // midpoint travel ⇒ scroll
  // nut.js takes wheel "steps" (roughly one line ≈ 40px of content), not
  // pixels, so finger travel is scaled down hard. Tune between 0.03 and 0.1
  // if scrolling feels too slow or too fast on a real phone.
  const SCROLL_GAIN = 0.05;
  let twoFingerIntent = null; // null | 'pinch' | 'scroll'
  let twoFingerStartDistance = 0;
  let twoFingerStartMid = { x: 0, y: 0 };
  let twoFingerLastMid = { x: 0, y: 0 };
  let scrollAxis = 'y'; // locked on the first decisive move
  let scrollAccumX = 0;
  let scrollAccumY = 0;
  const TAP_MOVE_THRESHOLD_PX = 10;

  // Three-finger swipe → macOS desktop/Space switching (plan.md follow-up:
  // the Mac side has no API to literally replay a multi-touch trackpad
  // gesture, so this maps to the Control+Left/Right keyboard shortcut,
  // which macOS treats as exactly equivalent to a three-finger swipe —
  // see input-inject.js 'switch-desktop'). This is a DISCRETE gesture
  // (fires once per swipe, like the Mac's own three-finger swipe), not a
  // continuous/tracked one, so we only look at total displacement once
  // the swipe is released rather than streaming anything mid-gesture.
  const THREE_FINGER_SWIPE_THRESHOLD_PX = 60;
  let threeFingerStartX = 0;
  let threeFingerFired = false; // guards against re-firing if a 4th finger touches down mid-gesture

  function averageTouchX(touchList) {
    let sum = 0;
    for (let i = 0; i < touchList.length; i++) sum += touchList[i].clientX;
    return sum / touchList.length;
  }

  function beginSingleTouchMode(t) {
    gestureTouchStartTime = Date.now();
    gestureStartClientX = t.clientX;
    gestureStartClientY = t.clientY;
    gestureMoved = false;

    if (scale > 1) {
      activeTouchMode = 'pan-or-tap';
      panStartTranslateX = translateX;
      panStartTranslateY = translateY;
    } else {
      activeTouchMode = 'click-drag';
      lastTouch = videoRelativeCoords(t.clientX, t.clientY);
      lastMoveSentAt = 0; // bypass throttle so the initial position lands immediately
      sendMouseMoveThrottled(lastTouch);
    }
  }

  remoteVideo.addEventListener('touchstart', (e) => {
    e.preventDefault();

    if (e.touches.length === 3) {
      activeTouchMode = 'three-finger-swipe';
      threeFingerStartX = averageTouchX(e.touches);
      threeFingerFired = false;
      return;
    }
    if (e.touches.length === 2) {
      activeTouchMode = 'pinch';
      pinchLastDistance = touchDistance(e.touches[0], e.touches[1]);
      twoFingerIntent = null;
      twoFingerStartDistance = pinchLastDistance;
      twoFingerStartMid = touchMidpoint(e.touches[0], e.touches[1]);
      twoFingerLastMid = twoFingerStartMid;
      scrollAxis = 'y';
      scrollAccumX = 0;
      scrollAccumY = 0;
      return;
    }
    if (e.touches.length === 1) {
      beginSingleTouchMode(e.touches[0]);
    }
    // 4+ simultaneous touches: ignored (no-op beyond preventDefault above).
  }, { passive: false });

  remoteVideo.addEventListener('touchmove', (e) => {
    e.preventDefault();

    if (e.touches.length === 3 && activeTouchMode === 'three-finger-swipe') {
      if (threeFingerFired) return; // already dispatched for this gesture
      const dx = averageTouchX(e.touches) - threeFingerStartX;
      if (Math.abs(dx) > THREE_FINGER_SWIPE_THRESHOLD_PX) {
        // Swiping fingers LEFT (dx<0) moves to the space on the right in
        // macOS's model, matching the native three-finger-swipe convention.
        sendControl({ type: 'switch-desktop', direction: dx < 0 ? 'right' : 'left' });
        threeFingerFired = true;
      }
      return;
    }

    if (e.touches.length === 2 && activeTouchMode === 'pinch') {
      const [t0, t1] = e.touches;
      const newDistance = touchDistance(t0, t1);
      const mid = touchMidpoint(t0, t1);
      const factor = newDistance / pinchLastDistance;
      pinchLastDistance = newDistance;

      // A two-finger gesture is ambiguous until the fingers actually move:
      // spreading them apart means zoom, sliding them together means
      // scroll. Latch once — switching interpretation mid-gesture feels
      // broken — and only latch after enough movement to be deliberate, so
      // a slow pinch isn't misread as a scroll.
      if (twoFingerIntent === null) {
        const distanceDelta = Math.abs(newDistance - twoFingerStartDistance);
        const midTravel = Math.hypot(
          mid.x - twoFingerStartMid.x,
          mid.y - twoFingerStartMid.y
        );
        if (distanceDelta > TWO_FINGER_DISTANCE_THRESHOLD_PX) {
          twoFingerIntent = 'pinch';
        } else if (midTravel > TWO_FINGER_MID_THRESHOLD_PX) {
          twoFingerIntent = 'scroll';
          scrollAxis =
            Math.abs(mid.x - twoFingerStartMid.x) > Math.abs(mid.y - twoFingerStartMid.y)
              ? 'x'
              : 'y';
        }
        if (twoFingerIntent === null) {
          // Still inside the dead zone: send nothing yet, but keep the last
          // midpoint fresh so the first scroll step isn't a jump.
          twoFingerLastMid = mid;
          return;
        }
      }

      if (twoFingerIntent === 'scroll') {
        // Locked to the axis of the first decisive move so a slightly
        // diagonal swipe doesn't jitter both directions. The sign is
        // inverted: dragging fingers up scrolls the content up, which is a
        // positive (downward) wheel delta on the Mac.
        if (scrollAxis === 'y') scrollAccumY -= mid.y - twoFingerLastMid.y;
        else scrollAccumX -= mid.x - twoFingerLastMid.x;
        twoFingerLastMid = mid;

        // Only whole wheel steps are worth sending — the Agent rounds them
        // anyway, and sub-step traffic would just spam the DataChannel.
        const stepX = Math.round(scrollAccumX * SCROLL_GAIN);
        const stepY = Math.round(scrollAccumY * SCROLL_GAIN);
        if (stepX !== 0 || stepY !== 0) {
          sendControl({ type: 'scroll', deltaX: stepX, deltaY: stepY });
          scrollAccumX -= stepX / SCROLL_GAIN;
          scrollAccumY -= stepY / SCROLL_GAIN;
        }
        return;
      }

      const rect = viewerScreen.getBoundingClientRect();
      // Anchor-preserving zoom: find where the pinch midpoint currently
      // sits in the video's own (untransformed) local coordinate space,
      // then solve for the translate that keeps that same local point
      // under the (possibly also moving) midpoint after the scale change.
      const localX = (mid.x - rect.left - translateX) / scale;
      const localY = (mid.y - rect.top - translateY) / scale;

      scale = Math.min(Math.max(scale * factor, MIN_SCALE), MAX_SCALE);
      translateX = mid.x - rect.left - scale * localX;
      translateY = mid.y - rect.top - scale * localY;
      clampTranslate();
      applyTransform();
      return;
    }

    if (e.touches.length === 1 && (activeTouchMode === 'pan-or-tap' || activeTouchMode === 'click-drag')) {
      const t = e.touches[0];
      const dx = t.clientX - gestureStartClientX;
      const dy = t.clientY - gestureStartClientY;
      if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD_PX) gestureMoved = true;

      if (activeTouchMode === 'pan-or-tap') {
        if (gestureMoved) {
          translateX = panStartTranslateX + dx;
          translateY = panStartTranslateY + dy;
          clampTranslate();
          applyTransform();
        }
        // Below the tap-move threshold: wait to see if this resolves into
        // a tap (click) or a pan on touchend/further movement.
      } else {
        // 'click-drag' (scale===1): unchanged live cursor-drag behavior.
        lastTouch = videoRelativeCoords(t.clientX, t.clientY);
        sendMouseMoveThrottled(lastTouch);
      }
    }
  }, { passive: false });

  remoteVideo.addEventListener('touchend', (e) => {
    e.preventDefault();

    // Fingers lifted out of a three-finger swipe (whether it fired or
    // not): nothing to finalize on release — the swipe is purely
    // discrete and already handled (or not) during touchmove. Just clear
    // state once all fingers are up; a dropped-to-1-or-2-fingers mid
    // gesture is intentionally NOT re-baselined into pinch/click-drag —
    // the user is clearly mid-swipe, not starting a new gesture, so we
    // wait for a full release instead of risking a spurious click/zoom.
    if (activeTouchMode === 'three-finger-swipe') {
      if (e.touches.length === 0) activeTouchMode = null;
      return;
    }

    // One finger lifted out of a two-finger pinch: re-baseline the
    // remaining finger into single-touch mode so there's no jump/snap.
    // After a scroll, though, re-baselining would fling the remote cursor
    // to the leftover finger and could fire a click on release — so the
    // remainder of that gesture is swallowed instead.
    if (e.touches.length === 1 && activeTouchMode === 'pinch') {
      if (twoFingerIntent === 'scroll') activeTouchMode = 'scroll-done';
      else beginSingleTouchMode(e.touches[0]);
      return;
    }

    if (activeTouchMode === 'scroll-done') {
      if (e.touches.length === 0) activeTouchMode = null;
      return;
    }

    if (e.touches.length !== 0) return; // more fingers still down; nothing to finalize yet

    if (activeTouchMode === 'pinch') {
      activeTouchMode = null; // both fingers lifted together — nothing more to do
      return;
    }

    const ct = e.changedTouches[0];

    if (activeTouchMode === 'click-drag') {
      const duration = Date.now() - gestureTouchStartTime;
      // Short tap = click; long press reserved for future right-click gesture (M4)
      if (duration < 300 && lastTouch) {
        sendControl({ type: 'click', ...lastTouch, button: 'left' });
      }
    } else if (activeTouchMode === 'pan-or-tap') {
      if (!gestureMoved && ct) {
        const coords = videoRelativeCoords(ct.clientX, ct.clientY);
        const now = Date.now();
        if (isDoubleTap(ct.clientX, ct.clientY, now)) {
          resetZoom();
          lastTapTime = 0; // consume — avoids a stray triple-tap re-triggering
        } else {
          sendControl({ type: 'click', ...coords, button: 'left' });
          lastTapTime = now;
          lastTapX = ct.clientX;
          lastTapY = ct.clientY;
        }
      }
      // else: gesture resolved as a pan — view stays wherever it was
      // dragged to; no click is sent.
    }

    activeTouchMode = null;
  }, { passive: false });

  remoteVideo.addEventListener('touchcancel', () => {
    // Safari fires this for interruptions (e.g. an incoming call). Just
    // drop whatever gesture was in progress — no mouse-button state is
    // held across touch gestures in this design, so there's nothing to
    // "release" on the Agent side.
    activeTouchMode = null;
    twoFingerIntent = null;
  });

  // ── Mouse event mapping (desktop browser testing / trackpad use) ────────
  // iPhone Safari only ever fires touch* events, but when this page is
  // opened in a regular desktop browser (e.g. for local testing without a
  // phone) only mouse* events fire. Without this block, clicking with a
  // mouse does nothing — the DataChannel never receives a message because
  // only touchstart/touchmove/touchend were wired up.
  let mouseIsDown = false;

  remoteVideo.addEventListener('mousedown', (e) => {
    mouseIsDown = true;
    lastTouch = videoRelativeCoords(e.clientX, e.clientY);
    lastMoveSentAt = 0; // bypass throttle so the down-position lands exactly
    sendMouseMoveThrottled(lastTouch);
    sendControl({ type: 'mousedown', button: e.button === 2 ? 'right' : 'left' });
  });

  remoteVideo.addEventListener('mousemove', (e) => {
    if (!mouseIsDown) return;
    lastTouch = videoRelativeCoords(e.clientX, e.clientY);
    sendMouseMoveThrottled(lastTouch);
  });

  window.addEventListener('mouseup', (e) => {
    if (!mouseIsDown) return;
    mouseIsDown = false;
    sendControl({ type: 'mouseup', button: e.button === 2 ? 'right' : 'left' });
  });

  remoteVideo.addEventListener('click', (e) => {
    const coords = videoRelativeCoords(e.clientX, e.clientY);
    sendControl({ type: 'click', ...coords, button: 'left' });
  });

  remoteVideo.addEventListener('contextmenu', (e) => {
    // Right-click — prevent the browser's native context menu and send a
    // right-click to the Mac instead.
    e.preventDefault();
    const coords = videoRelativeCoords(e.clientX, e.clientY);
    sendControl({ type: 'mousemove', ...coords });
    sendControl({ type: 'click', ...coords, button: 'right' });
  });

  // ── On-screen keyboard ───────────────────────────────────────────────────
  keyboardToggle.addEventListener('click', () => {
    hiddenInput.value = '';
    hiddenInput.focus();
    // Focusing triggers the keyboard to open; give Safari a moment to
    // animate it in before measuring (see adjustForKeyboard above), then
    // again shortly after in case the first measurement caught it
    // mid-animation.
    setTimeout(adjustForKeyboard, 50);
    setTimeout(adjustForKeyboard, 350);
  });

  // Restore full-height video once the keyboard closes (losing focus on
  // the hidden input is the reliable signal for "keyboard dismissed" —
  // visualViewport's resize event alone can lag behind the dismiss
  // animation on some iOS versions).
  hiddenInput.addEventListener('blur', () => {
    setTimeout(adjustForKeyboard, 50);
    setTimeout(adjustForKeyboard, 350);
  });

  // IME composition tracking (plan.md M2 follow-up: Chinese/Japanese/Korean
  // input). While an IME composition is in progress (e.g. typing pinyin and
  // picking a candidate character), the browser fires 'input' events on
  // EVERY keystroke of the in-progress, not-yet-confirmed text — before the
  // 'compositionstart'/'compositionend' fix, each of those intermediate
  // states (half-typed pinyin, not the chosen Chinese characters) was sent
  // to the Mac immediately, which is why input appeared to stream
  // continuously instead of only firing once the user actually confirmed a
  // word. We now only forward text once composition finishes.
  let isComposing = false;

  hiddenInput.addEventListener('compositionstart', () => {
    isComposing = true;
  });

  hiddenInput.addEventListener('compositionend', () => {
    isComposing = false;
    // The final composed text lands in the input's value right as
    // compositionend fires; flush it the same way the 'input' handler
    // below does for non-IME (e.g. English) typing.
    const val = hiddenInput.value;
    if (val) {
      sendControl({ type: 'text', value: val });
      hiddenInput.value = '';
    }
  });

  hiddenInput.addEventListener('input', () => {
    // Skip entirely while an IME composition is in progress — the
    // 'compositionend' handler above is solely responsible for flushing
    // IME-composed text once the user actually confirms a word/character.
    if (isComposing) return;
    const val = hiddenInput.value;
    if (val) {
      sendControl({ type: 'text', value: val });
      hiddenInput.value = '';
    }
  });

  hiddenInput.addEventListener('keydown', (e) => {
    // Handle non-text keys (Enter, Backspace) explicitly since 'input' event
    // on iOS doesn't reliably fire for these in all keyboard modes.
    //
    // Guard against isComposing/e.isComposing: during IME composition,
    // Enter is typically used to confirm the selected candidate word, not
    // to actually submit/send a literal Enter keypress. Without this
    // check, confirming a Chinese word with Enter would spuriously send an
    // extra Enter keystroke to the Mac on top of the composed text.
    if (isComposing || e.isComposing) return;
    if (['Enter', 'Backspace', 'Tab'].includes(e.key)) {
      sendControl({ type: 'keydown', key: e.key });
      sendControl({ type: 'keyup', key: e.key });
      if (e.key === 'Backspace') e.preventDefault();
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  // A manual disconnect does NOT clear the saved deviceToken — the whole
  // point of 方案 B is that closing/reopening the tab (or the phone
  // sleeping) doesn't force a re-pair. The token only gets cleared when
  // the server explicitly rejects it (expired/revoked) or the user clears
  // browser data.
  disconnectBtn.addEventListener('click', () => {
    if (ws) ws.send(JSON.stringify({ type: 'leave' }));
    teardown();
    location.reload();
  });

  function teardown() {
    if (dataChannel) { dataChannel.close(); dataChannel = null; }
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // If we already have a trusted-device token from a prior pairing, skip
  // straight to reconnecting — no PIN screen flash for the common case.
  const savedToken = getSavedToken();
  if (savedToken) {
    tryAutoReconnect(savedToken);
  }
})();
