/**
 * input-inject.js — translates DataChannel control messages into real
 * mouse/keyboard events on macOS via nut.js (needs Accessibility permission).
 *
 * Coordinate convention: the iPhone viewer sends NORMALIZED coordinates
 * (0..1 range, relative to the video frame) so the Agent can map them onto
 * whatever the actual screen resolution is, regardless of the viewer's
 * viewport size.
 *
 * Multi-monitor support: normalized coordinates are relative to whichever
 * display is currently being captured (see renderer.js). `displayBounds`
 * (passed in from main.js's `activeDisplayBounds`, sourced from Electron's
 * screen.getAllDisplays()) carries that display's {x, y, width, height} IN
 * DIP — the same logical-point coordinate space nut.js's mouse/screen APIs
 * use (verified empirically: nut.js screen.width()/height() matches
 * Electron's display.size exactly, not display.size * scaleFactor). The
 * x/y offset is what makes clicking actually land on a non-primary
 * display: nut.js has no concept of "which screen" — mouse.setPosition()
 * takes one absolute coordinate in the shared virtual-desktop space that
 * spans all monitors, so a display sitting to the right of/above the
 * primary one needs its positive/negative offset added before converting
 * the 0..1 normalized coordinate.
 */

const { mouse, keyboard, screen, Point, Button, Key } = require('@nut-tree-fork/nut-js');
const { execFile } = require('child_process');

// Keep input fast — no artificial delay between simulated key presses.
keyboard.config.autoDelayMs = 0;
mouse.config.autoDelayMs = 0;

const BUTTON_MAP = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

// Minimal mapping from the DOM KeyboardEvent.key values the web viewer
// sends, to nut.js Key enum. Extend as needed for more keys.
const KEY_MAP = {
  Enter: Key.Enter,
  Backspace: Key.Backspace,
  Delete: Key.Delete,
  Tab: Key.Tab,
  Escape: Key.Escape,
  ArrowUp: Key.Up,
  ArrowDown: Key.Down,
  ArrowLeft: Key.Left,
  ArrowRight: Key.Right,
  ' ': Key.Space,
  Shift: Key.LeftShift,
  Control: Key.LeftControl,
  Alt: Key.LeftAlt,
  Meta: Key.LeftCmd,
};

// Fallback for when no display has been explicitly selected (single-monitor
// setups, or before the renderer's first get-displays/set-active-display
// round-trip) — behaves exactly as before multi-monitor support existed.
let primaryScreenSize = null;
async function getPrimaryScreenSize() {
  if (!primaryScreenSize) {
    primaryScreenSize = await screen.width().then(w => screen.height().then(h => ({ w, h })));
  }
  return primaryScreenSize;
}

/**
 * @param {number} xNorm 0..1, relative to the captured display's width
 * @param {number} yNorm 0..1, relative to the captured display's height
 * @param {{x:number,y:number,width:number,height:number}|null} displayBounds
 *   The captured display's bounds in DIP (from Electron's
 *   screen.getAllDisplays()); null falls back to the primary display at
 *   offset (0,0), matching pre-multi-monitor behavior.
 */
async function toAbsolute(xNorm, yNorm, displayBounds) {
  if (displayBounds) {
    return new Point(
      Math.round(displayBounds.x + xNorm * displayBounds.width),
      Math.round(displayBounds.y + yNorm * displayBounds.height)
    );
  }
  const { w, h } = await getPrimaryScreenSize();
  return new Point(Math.round(xNorm * w), Math.round(yNorm * h));
}

// Run an AppleScript "key code ... using ... down" via System Events.
//
// WHY NOT nut.js HERE: verified empirically (see plan.md) that
// keyboard.pressKey(Key.LeftControl, Key.Right) via nut.js does NOT
// trigger a Spaces/desktop switch, even though it correctly presses
// Control+Right for ordinary app shortcuts. nut.js/CGEventPost injects
// at a layer macOS's window server respects for most apps, but Spaces
// switching is handled by a system-level gesture/shortcut recognizer
// that only responds to events coming through the Accessibility API
// path — which is exactly what AppleScript's "tell application System
// Events to key code ... using ... down" goes through. Confirmed working
// via manual osascript test before wiring this in.
function runAppleScriptKeyCode(keyCode, modifierDown) {
  return new Promise((resolve, reject) => {
    const script = `tell application "System Events" to key code ${keyCode} using ${modifierDown} down`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// macOS key codes for the arrow keys (stable, hardware-layout-independent —
// these are physical scan codes, not character codes).
const KEY_CODE_LEFT = 123;
const KEY_CODE_RIGHT = 124;

/**
 * @param {object} data parsed JSON message from the DataChannel
 * @param {{x:number,y:number,width:number,height:number}|null} displayBounds
 *   Bounds (DIP) of the display currently being captured — see the module
 *   doc comment above. Passed through from main.js's activeDisplayBounds.
 */
async function injectEvent(data, displayBounds = null) {
  switch (data.type) {
    case 'mousemove': {
      const pt = await toAbsolute(data.x, data.y, displayBounds);
      await mouse.setPosition(pt);
      break;
    }
    case 'mousedown': {
      await mouse.pressButton(BUTTON_MAP[data.button] || Button.LEFT);
      break;
    }
    case 'mouseup': {
      await mouse.releaseButton(BUTTON_MAP[data.button] || Button.LEFT);
      break;
    }
    case 'click': {
      // Convenience event: viewer can send a single "click" for simple taps
      // instead of separate down/up — reduces chattiness over the DataChannel.
      if (data.x !== undefined && data.y !== undefined) {
        const pt = await toAbsolute(data.x, data.y, displayBounds);
        await mouse.setPosition(pt);
      }
      await mouse.leftClick();
      break;
    }
    case 'scroll': {
      if (data.deltaY) await mouse.scrollDown(Math.round(data.deltaY));
      if (data.deltaX) await mouse.scrollRight(Math.round(data.deltaX));
      break;
    }
    case 'keydown': {
      const key = KEY_MAP[data.key];
      if (key) await keyboard.pressKey(key);
      break;
    }
    case 'keyup': {
      const key = KEY_MAP[data.key];
      if (key) await keyboard.releaseKey(key);
      break;
    }
    case 'text': {
      // Bulk text input from the on-screen keyboard — much faster than
      // simulating individual keydown/keyup pairs for every character.
      await keyboard.type(data.value);
      break;
    }
    case 'switch-desktop': {
      // Three-finger-swipe-equivalent desktop/Space switching.
      //
      // nut.js (and the underlying native accessibility APIs it wraps) can
      // only synthesize mouse/keyboard events — there is no API to inject
      // a genuine multi-touch trackpad gesture, so we can't literally
      // replay "three fingers swiping" on the Mac. macOS does, however,
      // expose an exactly-equivalent keyboard shortcut for the same
      // action: Control+Left/Right switches between full-screen
      // Spaces/desktops. data.direction is 'left' or 'right', matching
      // the direction the user swiped on the phone.
      //
      // IMPORTANT: this must go through AppleScript/System Events (see
      // runAppleScriptKeyCode above), NOT keyboard.pressKey() — verified
      // that nut.js's CGEventPost-based key injection does not trigger
      // the Spaces switch even though the same combo works fine for
      // regular in-app shortcuts.
      const keyCode = data.direction === 'left' ? KEY_CODE_LEFT : KEY_CODE_RIGHT;
      await runAppleScriptKeyCode(keyCode, 'control');
      break;
    }
    default:
      // Unknown message type — ignore rather than throw, keeps the
      // connection resilient to viewer/agent version mismatches.
      break;
  }
}

module.exports = { injectEvent };
