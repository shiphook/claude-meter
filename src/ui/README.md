# Overlay UI (Redline) — PRD §6

- `overlay.js` / `overlay.css` — Shadow DOM `#shiphook-claude-meter`
- Anchors near composer when found (`[data-cds="ChatComposer"]`, `.rounded-composer`, …); else bottom-right
- Context % + tools|web|other (count · ~tokens · share) + session/weekly resets
- Empty/error: `usage unavailable — send a message`
- Optional cache row when `chrome.storage.local.showCache` + `state.cache`
- Popup: `src/popup/` — overlay on/off, cache toggle, privacy one-liner, GitHub

## Wire (Always-On)
```json
"action": { "default_popup": "src/popup/popup.html" },
"web_accessible_resources": [{
  "resources": ["src/ui/overlay.css"],
  "matches": ["https://claude.ai/*"]
}]
```
Prefs: `enabled` (bool, default true), `showCache` (bool, default false).
