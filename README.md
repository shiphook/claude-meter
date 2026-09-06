# Shiphook Claude Meter

Free Chrome **MV3** extension — on-page Claude.ai **context %** + **session/weekly usage** meter. Local only. MIT.

**Org:** [shiphook](https://github.com/shiphook) · **UI:** Redline · **Eng:** Always-On · **PRD:** [docs/PRD.md](docs/PRD.md)

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (`claude-meter`)
4. Open [claude.ai](https://claude.ai) and chat — overlay mounts bottom-right

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
└── service worker: src/background.js
      storage helpers only · no network
```

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
