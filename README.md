# Shiphook Claude Meter

Free **Chromium + Firefox/Zen** MV3 extension — on-page Claude.ai **context %** + **session/weekly usage** meter. Local only. MIT.

**Org:** [shiphook](https://github.com/shiphook) · **UI:** Redline · **Eng:** Always-On · **PRD:** [docs/PRD.md](docs/PRD.md)

## Install

### Chromium (Chrome, Brave, Edge)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this repo folder (`claude-meter`) — uses root `manifest.json`
4. Open [claude.ai](https://claude.ai) and chat — overlay mounts bottom-right

### Firefox / Zen Browser

Firefox `about:debugging` **Load Temporary Add-on** always loads **`manifest.json` in the folder you pick**, not a differently named file. Do **not** select the repo root (that loads Chromium `service_worker` and fails).

1. Open `about:debugging#/runtime/this-firefox`
2. Click **This Firefox** (left sidebar)
3. Click **Load Temporary Add-on…**
4. Open the **`firefox/`** folder and select **`firefox/manifest.json`** (or any file inside `firefox/`)
5. Open [claude.ai](https://claude.ai) and chat — overlay mounts bottom-right

**Note:** Temporary add-ons unload when you close Zen/Firefox. Persistent install needs Mozilla signing (AMO) later.

## Preview (UI only)

Open `preview/mock.html` after serving the folder (or inject CSS via `__SHIPHOOK_METER_CSS__`). See `src/ui/README.md`.

## Architecture

```
claude.ai page
├── MAIN world: src/page/fetch-hook.js
├── ISOLATED: src/content/content.js + src/ui/overlay.js
└── background: src/background.js
      Chromium root manifest.json → service_worker
      Zen/Firefox firefox/manifest.json → background.scripts
```

**Packaging:** Root = Chromium. `firefox/` = self-contained Gecko pack (same `src/` copy) so temporary load finds a Gecko `manifest.json`.

## Privacy

- Local only — no telemetry, no backend, no accounts
- Only talks to `claude.ai` with your existing session
- Never sends meter data off-device

## License

MIT © 2026 Shiphook — see [LICENSE](LICENSE)
