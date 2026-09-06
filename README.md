# Shiphook Claude Meter

**Free browser extension for tracking Claude.ai context and usage — local only, no data ever leaves your device.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.12-green.svg)](https://github.com/shiphook/claude-meter)

Built by [Redline](https://github.com/shiphook) (UI) and Always-On (Engineering) · MIT Licensed

---

## Features

- **Context Breakdown** — See your conversation context percentage split across tools, web searches, and other content
- **Usage Tracking** — Monitor session and weekly usage with visual progress bars
- **Collapsed View** — Minimal pill showing just session and weekly bars when you need more screen space
- **Privacy First** — All tracking happens locally in your browser; no telemetry, no backend, no accounts
- **Clean Integration** — Unobtrusive overlay near the composer that adapts to Claude.ai's interface

**Note:** Currently supports Claude.ai only (ChatGPT and other platforms planned for future versions).

---

## Screenshots

### Expanded View
Shows full context breakdown with tool/web/other counts, approximate tokens, and usage percentages.

![Expanded Meter](docs/screenshots/live-01-expanded.jpg)

### Collapsed View
Compact pill with session and weekly usage bars only.

![Collapsed Meter](docs/screenshots/live-02-collapsed.jpg)

---

## Installation

### Chromium (Chrome, Brave, Edge, Arc)

1. Download or clone this repository:
   ```bash
   git clone https://github.com/shiphook/claude-meter.git
   ```
2. Open your browser's extensions page:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `claude-meter` folder (the root directory with `manifest.json`)
6. Open [claude.ai](https://claude.ai) and start a conversation — the meter will appear in the bottom-right

### Firefox / Zen Browser

**⚠️ Important:** Firefox's "Load Temporary Add-on" always loads the `manifest.json` in the folder you select. The root `manifest.json` is configured for Chromium's `service_worker` background script, which Firefox doesn't support. You **must** load from the `firefox/` subdirectory to avoid startup errors.

1. Download or clone this repository:
   ```bash
   git clone https://github.com/shiphook/claude-meter.git
   ```
2. Open Firefox/Zen's debugging page: `about:debugging#/runtime/this-firefox`
3. Click **This Firefox** in the left sidebar (if not already selected)
4. Click **Load Temporary Add-on…**
5. Navigate into the **`firefox/`** subfolder
6. Select **any file** inside `firefox/` (e.g., `manifest.json` or `LICENSE`)
7. Open [claude.ai](https://claude.ai) and start a conversation — the meter will appear in the bottom-right

**Note:** Temporary add-ons are unloaded when you close Firefox/Zen. Persistent installation requires Mozilla AMO signing (planned for future release).

---

## Usage

Once installed and enabled:

1. Visit [claude.ai](https://claude.ai) and log in
2. Start or continue a conversation
3. The meter overlay will mount automatically in the bottom-right corner (near the composer when visible)
4. Click the meter to toggle between expanded and collapsed views
5. Open the extension popup (click the extension icon in your toolbar) to:
   - Toggle the meter on/off
   - Show/hide cache information (when available)
   - Access privacy info and the GitHub repository

If you see "usage unavailable — send a message", the meter hasn't received usage data yet. Send a message to Claude and the meter will update.

---

## How It Works

The extension uses a lightweight architecture optimized for privacy and performance:

```
claude.ai page
├── MAIN world: src/page/fetch-hook.js
│   └── Intercepts Claude API responses to extract usage data
├── ISOLATED world: src/content/content.js + src/ui/overlay.js
│   └── Renders the Shadow DOM overlay UI
└── Background: src/background.js (service_worker in Chromium, background.scripts in Firefox)
    └── Manages local storage for preferences and usage state
```

**Privacy guarantee:** The extension only interacts with `claude.ai` using your existing session. No usage data, conversation content, or telemetry is ever transmitted off your device.

---

## Development

### Preview UI (No Extension Required)

Open `preview/mock.html` in a browser (after serving the folder, or by injecting CSS via `__SHIPHOOK_METER_CSS__` global). See [`src/ui/README.md`](src/ui/README.md) for details.

### Repository Structure

```
claude-meter/
├── manifest.json              # Chromium MV3 manifest (service_worker)
├── src/
│   ├── background.js          # Storage helpers (MV3 service worker)
│   ├── page/
│   │   └── fetch-hook.js      # MAIN world: intercept Claude API
│   ├── content/
│   │   └── content.js         # ISOLATED: bridge + state management
│   ├── ui/
│   │   ├── overlay.js         # Shadow DOM UI + rendering
│   │   └── overlay.css        # Styles
│   └── popup/
│       ├── popup.html         # Extension popup
│       ├── popup.js
│       └── popup.css
├── firefox/                   # Self-contained Firefox/Zen package
│   ├── manifest.json          # Gecko-compatible manifest (background.scripts)
│   └── src/                   # Copy of src/ for Gecko compatibility
├── icons/                     # Extension icons (16/32/48/128px)
├── preview/                   # Standalone UI preview
└── docs/
    ├── PRD.md                 # Product requirements
    └── screenshots/           # Documentation images
```

The `firefox/` folder contains a complete, self-contained copy of the extension configured for Firefox/Zen Browser. This allows Firefox's "Load Temporary Add-on" feature to find a Gecko-compatible `manifest.json` without accidentally loading Chromium's `service_worker`.

### Contributing

Contributions are welcome! This extension is MIT licensed and developed in the open.

- **Report bugs** or request features via [GitHub Issues](https://github.com/shiphook/claude-meter/issues)
- **Submit pull requests** for fixes or enhancements
- **Read the UI docs** at [`src/ui/README.md`](src/ui/README.md) for implementation details

---

## Privacy Policy

**Local only. No network. No telemetry.**

- The extension has permission to access `https://claude.ai/*` only
- It reads Claude's existing API responses to extract usage data
- All data is stored locally using your browser's `chrome.storage.local` API
- No analytics, tracking, or external network requests are made
- No user data, conversation content, or usage information ever leaves your device

The only external link is the GitHub repository (opened when you click "GitHub" in the popup).

---

## Known Limitations

- **Claude.ai only** — ChatGPT, Grok, and other LLM platforms are not yet supported (planned for v2+)
- **Usage approximation** — Session and weekly percentages are derived from Claude's SSE stream and API responses; exact values depend on Claude's rate limit headers
- **Temporary add-ons on Firefox** — You'll need to reload the extension each time you restart Firefox/Zen until AMO signing is available

---

## License

MIT License — see [LICENSE](LICENSE) file for details.

Copyright © 2026 [Shiphook](https://github.com/shiphook)

---

## Version History

**0.1.12** (Current)
- Fix: Normalize util 0-100 vs 0-1 scale for usage percentages
- Fix: Restore content.js for Firefox compatibility
- Added: Extension icons (16/32/48/128px)

**0.1.11**
- Fix: Persist session/weekly usage across model switches and page remounts
- Added: Self-contained `firefox/` package for Zen/Firefox Load Temporary Add-on

**0.1.10**
- Feature: Persist & hydrate session/weekly usage across navigation/refresh

**0.1.8**
- Feature: Compact collapsed pill with session+weekly bars only

---

**Built with ❤️ for the Claude.ai community**

[Report an Issue](https://github.com/shiphook/claude-meter/issues) · [View Source](https://github.com/shiphook/claude-meter)
