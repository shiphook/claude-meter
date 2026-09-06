# Shiphook Claude Meter

Free **Chromium + Firefox/Zen** MV3 extension — on-page Claude.ai **context %** + **session/weekly usage** meter. Local only. MIT.

**Org:** [shiphook](https://github.com/shiphook) · **UI:** Redline · **Eng:** Always-On · **PRD:** [docs/PRD.md](docs/PRD.md)

## Install

### Chromium (Chrome, Brave, Edge)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (`claude-meter`)
4. Open [claude.ai](https://claude.ai) and chat — overlay mounts bottom-right

### Firefox / Zen Browser

1. Open `about:debugging#/runtime/this-firefox`
2. Click **This Firefox** (left sidebar)
3. Click **Load Temporary Add-on…**
4. Navigate to the `claude-meter` folder and select **`manifest.firefox.json`**
5. Open [claude.ai](https://claude.ai) and chat — overlay mounts bottom-right

**Note:** Temporary add-ons unload when you close the browser. For persistent installation, the extension would need to be signed by Mozilla.

## Preview (UI only)

Open `preview/mock.html` after serving the folder (or inject CSS via `__SHIPHOOK_METER_CSS__`). See `src/ui/README.md`.

## Architecture

```
claude.ai page
├── MAIN world: src/page/fetch-hook.js
│     wraps window.fetch · tees SSE · postMessage(source: shiphook-claude-meter)
├── ISOLATED: src/content/content.js
│     injects hook · polls /api/organizations/{org}/usage (via page)
│     trunk-walks conversation JSON · merges MeterState
│     prefs: chrome.storage.local enabled / showCache
│     calls window.__SHIPHOOK_METER__.setState(state)
├── ISOLATED: src/ui/overlay.js (+ overlay.css)  ← Redline
│     Shadow DOM on #shiphook-claude-meter
└── background: src/background.js
      service worker (Chrome) / event page (Firefox)
      storage helpers only · no network
```

**Cross-browser:** Dual manifests for compatibility. `manifest.json` (Chromium) uses `service_worker`; `manifest.firefox.json` (Firefox/Zen) uses `scripts`. The `chrome.*` APIs (storage, runtime) work identically on both platforms.

| Signal | Source |
|--------|--------|
| Context % + breakdown | Conversation tree trunk (`current_leaf_message_uuid` → `parent_message_uuid`); ~4 chars/token; model-aware limit 200k / 500k / 1M |
| Session / weekly | `GET /api/organizations/{org}/usage` + SSE `message_limit` (versioned adapters in `src/lib/usage.js`) |
| Org id | Cookie / storage `lastActiveOrg` (best-effort) |
| Cache timer | Soft ~5 min heuristic; only shown when `showCache` (popup toggle) |

**Critical:** extension-origin fetch does **not** get `sessionKey` cookies → MAIN-world fetch wrap required.

## Privacy

- Local only — no telemetry, no backend, no accounts
- Only talks to `claude.ai` with your existing session
- Never sends meter data off-device

## Accuracy caveats

- Token counts are **approximate** (~4 chars/token; o200k would be better)
- `/usage` and `message_limit` field names are **undocumented / unstable** — adapters may need bumps
- Free plan REST usage may be `null` until after a reply — UI fails soft (`waiting`)
- Context denominator is **model-aware** (200k / 500k / 1M), not hardcoded to 200k alone

## MeterState (contract)

```
updatedAt, model?,
context{ tokensApprox, limit, percent },
breakdown{ tool_call, web_search, other → { count, tokensApprox? } },
session{ utilization, percent, resetsAt?, resetsInSec? },
weekly{ … same },
cache?, status: ok|waiting|error, error?
```

## Popup prefs

`chrome.storage.local`:

- `enabled` (default `true`) — when false, overlay is not shown
- `showCache` (default `false`) — when true, cache timer fields are passed to UI

## License

MIT © 2026 Shiphook — see [LICENSE](LICENSE)
