# Overlay UI (Redline)

- `src/ui/overlay.js` — Shadow DOM mount on `#shiphook-claude-meter`, bottom-right
- `src/ui/overlay.css` — dark Cursor-like; load via `chrome.runtime.getURL("src/ui/overlay.css")` (add to `web_accessible_resources`)
- Updates: `host.dispatchEvent(new CustomEvent("shiphook-meter:update", { detail: state }))` or `window.__SHIPHOOK_METER__.setState(state)`
- Collapse chip for low clutter
- Preview: open `preview/mock.html` after serving the folder (or inject CSS via `__SHIPHOOK_METER_CSS__`)

Manifest needs:
```json
"web_accessible_resources": [{
  "resources": ["src/ui/overlay.css"],
  "matches": ["https://claude.ai/*"]
}]
```
Content script should import/execute overlay.js after creating host (or overlay self-mounts).
