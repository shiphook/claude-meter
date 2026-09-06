# Overlay UI — Implementation Guide

This document describes the Shadow DOM overlay implementation for Shiphook Claude Meter (PRD §6).

---

## Architecture

The overlay UI consists of two main files:

- **`overlay.js`** — Creates and manages the Shadow DOM host, handles state updates, rendering, and user interactions
- **`overlay.css`** — Styles for the meter UI (loaded as a web-accessible resource)

### Shadow DOM Host

- **Mount point:** `#shiphook-claude-meter` (appended to `document.body`)
- **Shadow root:** Attached in `closed` mode to prevent external JS interference
- **Positioning:** Anchored near the composer when found (see selectors below), otherwise bottom-right fixed
- **State updates:** Via `CustomEvent "shiphook-meter:update"` or direct `window.__SHIPHOOK_METER__.setState(state)`

---

## UI States

### Expanded View

Shows full context and usage breakdown:

- **Context percentage** (primary metric, large text)
- **Breakdown:** tools | web | other
  - Count of each type (e.g., "3 tools")
  - Approximate tokens (e.g., "~2.4k")
  - Share percentage (e.g., "60%")
- **Session usage bar** with percentage and reset timer
- **Weekly usage bar** with percentage and reset timer
- **Cache row** (optional, when `chrome.storage.local.showCache` is `true` and `state.cache` exists)

### Collapsed View

Minimal pill showing:

- **Session usage bar** (thin horizontal bar)
- **Weekly usage bar** (thin horizontal bar below session)
- No text, counts, or percentages
- Click to expand

### Empty/Error State

When no usage data is available:

- Message: `"usage unavailable — send a message"`
- Displayed in place of context breakdown
- Prompts user to send a Claude message to populate data

---

## Composer Anchoring

The overlay attempts to anchor itself near Claude's composer using these selectors (checked in order):

```javascript
const COMPOSER_SELECTORS = [
  '[data-testid="chat-input"]',
  '[data-cds="ChatComposer"]',
  '.rounded-composer',
  'fieldset.rounded-composer',
  '[class*="ChatComposer"]',
  'form[class*=\'composer\']',
  'main form textarea',
];
```

If a composer is found and visible (non-zero height), the overlay positions itself relative to it. Otherwise, it defaults to `fixed` positioning at bottom-right.

---

## State Interface

The overlay expects a state object with this shape:

```javascript
{
  // Context breakdown
  context: {
    pct: 42,                    // 0-100 percentage (null/NaN renders as "—")
    tools: { count: 3, tokens: 2400, share: 60 },
    web: { count: 2, tokens: 800, share: 20 },
    other: { count: 5, tokens: 800, share: 20 }
  },
  
  // Session usage
  session: {
    pct: 15,                    // 0-100 percentage
    resetsInSec: 7200,          // Seconds until reset (or resetsAt timestamp)
  },
  
  // Weekly usage
  weekly: {
    pct: 58,                    // 0-100 percentage
    resetsInSec: 259200,        // Seconds until reset (or resetsAt timestamp)
  },
  
  // Cache (optional, shown when prefs.showCache is true)
  cache: {
    ttlSecRemaining: 120,       // Seconds until cache expires
    // or remainingMs / expiresAt
  }
}
```

**Note:** All percentage values are clamped to `0-100`. `null` or `NaN` renders as `"—"`.

---

## Preferences

Preferences are stored in `chrome.storage.local`:

- **`enabled`** (boolean, default `true`) — Show/hide the overlay
- **`showCache`** (boolean, default `false`) — Display cache row in expanded view

Managed via the extension popup (`src/popup/`).

---

## Rendering

### Formatting Helpers

- **`clampPct(n)`** — Clamps to 0-100, returns `null` for invalid input
- **`fmtPct(n)`** — Formats as `"42%"` or `"—"` if null/NaN
- **`fmtCount(n)`** — Formats count as string or `"—"`
- **`fmtTokens(n)`** — Formats tokens as `"2.4k"` (>1000) or `"240"` or `"—"`
- **`fmtReset(part)`** — Formats reset timer: `"resets 2.5h"`, `"resets 45m"`, `"resets 30s"`, etc.
- **`fmtCache(cache)`** — Formats cache TTL: `"2m"`, `"45s"`, etc.

### HTML Structure (Expanded)

```html
<div id="shiphook-claude-meter-container" class="shiphook-meter-expanded">
  <div class="shiphook-meter-header">
    <div class="shiphook-meter-context">
      <div class="shiphook-meter-context-value">42%</div>
      <div class="shiphook-meter-context-label">Context</div>
    </div>
    <button class="shiphook-meter-toggle" aria-label="Collapse">−</button>
  </div>
  
  <div class="shiphook-meter-breakdown">
    <div class="shiphook-meter-breakdown-row">
      <span class="shiphook-meter-breakdown-label">tools</span>
      <span class="shiphook-meter-breakdown-value">3 · ~2.4k · 60%</span>
    </div>
    <!-- web, other rows -->
  </div>
  
  <div class="shiphook-meter-usage">
    <div class="shiphook-meter-usage-row">
      <div class="shiphook-meter-usage-label">Session <span>15% · resets 2h</span></div>
      <div class="shiphook-meter-usage-bar">
        <div class="shiphook-meter-usage-fill" style="width: 15%"></div>
      </div>
    </div>
    <!-- weekly row -->
  </div>
  
  <!-- Optional cache row -->
  <div class="shiphook-meter-cache">...</div>
  
  <div class="shiphook-meter-footer">
    <a href="https://github.com/shiphook/claude-meter" target="_blank">shiphook/claude-meter</a>
  </div>
</div>
```

### HTML Structure (Collapsed)

```html
<div id="shiphook-claude-meter-container" class="shiphook-meter-collapsed">
  <div class="shiphook-meter-pill" aria-label="Expand meter">
    <div class="shiphook-meter-bar" style="width: 15%"></div>  <!-- session -->
    <div class="shiphook-meter-bar" style="width: 58%"></div>  <!-- weekly -->
  </div>
</div>
```

---

## CSS Loading

The CSS is loaded as a web-accessible resource:

```json
"web_accessible_resources": [{
  "resources": ["src/ui/overlay.css"],
  "matches": ["https://claude.ai/*"]
}]
```

In `overlay.js`:

```javascript
const STYLE_URL = chrome.runtime.getURL("src/ui/overlay.css");
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = STYLE_URL;
shadowRoot.appendChild(link);
```

For **preview mode** (no extension), inject CSS manually via a global:

```javascript
if (window.__SHIPHOOK_METER_CSS__) {
  const style = document.createElement("style");
  style.textContent = window.__SHIPHOOK_METER_CSS__;
  shadowRoot.appendChild(style);
}
```

See `preview/mock.html` for a standalone example.

---

## Event Handling

### Update State

Dispatch a custom event on `document`:

```javascript
document.dispatchEvent(new CustomEvent("shiphook-meter:update", {
  detail: { ...newState }
}));
```

Or call directly (if the global is exposed):

```javascript
window.__SHIPHOOK_METER__.setState({ ...newState });
```

### Toggle Collapsed/Expanded

Click handler on the meter toggles between views. State is managed internally in `overlay.js`.

---

## Popup Integration

The extension popup (`src/popup/popup.html`) provides:

- **Toggle overlay on/off** (sets `chrome.storage.local.enabled`)
- **Toggle cache display** (sets `chrome.storage.local.showCache`)
- **Privacy statement** (local-only, no telemetry)
- **GitHub link** to repository

---

## Testing

### With Extension Loaded

1. Load the extension (see root README for install instructions)
2. Open [claude.ai](https://claude.ai) and start a conversation
3. Overlay should mount automatically
4. Send messages to see usage update
5. Click to toggle collapsed/expanded
6. Use the extension popup to toggle on/off or show/hide cache

### Standalone Preview

1. Serve the repo folder locally (e.g., `python3 -m http.server 8000`)
2. Open `http://localhost:8000/preview/mock.html`
3. Interact with the mock UI (no live data, uses static mock state)

---

## Debugging

Enable verbose logging:

```javascript
// In content.js or overlay.js
const DEBUG = true;
if (DEBUG) console.log('[Meter]', ...args);
```

Inspect the Shadow DOM in DevTools:

1. Right-click the overlay → Inspect
2. In Elements tab, find `#shiphook-claude-meter`
3. Expand the `#shadow-root (closed)` node (DevTools allows this even for closed roots)

---

## Notes

- **High contrast:** UI uses strong contrast for readability across Claude's light/dark themes
- **No layout shift:** Overlay is positioned absolutely and does not affect page flow
- **No jQuery/React:** Pure vanilla JS + Shadow DOM for minimal footprint
- **No network:** All data comes from `content.js` via events or direct function calls

---

## Credits

- **UI Design:** Redline
- **Engineering:** Always-On
- **License:** MIT © 2026 Shiphook

For product requirements, see [`docs/PRD.md`](../../docs/PRD.md).  
For installation and usage, see the [root README](../../README.md).
