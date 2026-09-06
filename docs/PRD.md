# PRD: Shiphook — Claude.ai usage / context tracker (browser extension)

**Status:** Build approved (Shubham). PRD for parallel staffing — keep tight.
**Date:** 6 Sep 2026
**Org:** https://github.com/shiphook (empty product repo today; only `.github`)
**Staffing:** Always-On → eng lead · Redline → inject UI · B-Side → this PRD
**License intent:** Free OSS (MIT-compatible rewrite of she-llac/claude-counter ideas; clean-room preferred)

---

## 1. Problem

Claude.ai does not show a clear **Cursor-like context %** or a useful live breakdown of what is filling the window (tools vs web search vs text). Session / weekly usage is buried or rounded; after Claude’s **Aug 2026 UI redesign**, popular trackers (she-llac/claude-counter v0.4.2, last upstream push ~Mar 2026) **break** — anchors like `chat-menu-trigger` / `chat-input-grid-container` gone ([issues #47, #45, #27, #26](https://github.com/she-llac/claude-counter/issues)).

Shubham’s personal pain: needs a minimal on-page overlay while chatting — not a multi-provider SaaS widget.

---

## 2. Goals (v1) — Claude.ai only

| # | Must ship |
|---|---|
| 1 | **Context window bar** — % used vs model-aware denominator (do **not** hardcode 200k; paid Help cites 200k / 500k / 1M by model) |
| 2 | **Composition breakdown** — tool calls, web search, other/text: **counts + rough token share** (from conversation tree blocks, not `/usage`) |
| 3 | **Session + weekly usage bars** + reset timers — prefer `GET /api/organizations/{org}/usage` + SSE `message_limit` over DOM scrape |
| 4 | **Cache timer** — only if still useful; soft heuristic (last assistant + ~5 min) or hide; **do not block v1** |
| 5 | **Minimal overlay** on `claude.ai` near composer (Shadow DOM); resilient anchors |

**Privacy / trust:** local-only; no telemetry; only talk to `claude.ai` with the user’s existing session (page-context fetch). No accounts, no backend.

**Platform:** Chrome / Chromium **MV3**.

---

## 3. Non-goals

- Paid SaaS day one
- Multi-provider parity day one (ChatGPT / Grok = **v1.1+**, opt-in, estimate mode OK)
- Competing **Metrician** (or Claude Usage Monitor / ClaudeMeter) feature-for-feature — no skins marketplace, menubar apps, seven-bucket Max dashboards, spend/billing parity, CSV history products
- Settings-page DOM scrape as primary metrics path
- `declarativeNetRequest` body sniffing (cannot read responses; wrong tool)

---

## 4. Users / jobs

**Primary:** Shubham (and similar power users) on claude.ai web who want “how full is this chat?” and “am I near session/weekly limit?” without leaving the composer.

**JTBD**

1. While typing, see context fill like Cursor’s %.
2. See whether tools/web are eating the window.
3. See session + weekly burn and when they reset.
4. Trust that nothing leaves the machine.

---

## 5. Architecture (Always-On)

### 5.1 Metrics sources (prefer network over DOM)

| Signal | Source | Notes |
|---|---|---|
| Context % + breakdown | Conversation tree `GET .../chat_conversations/{id}?tree=...` — walk trunk from `current_leaf_message_uuid` via `parent_message_uuid`; serialize text + `tool_use` / `tool_result`; tokenize (vendored `o200k_base` or equivalent) | Token share is **approximate**. Web search = named tool_use blocks. |
| Session / weekly | `GET https://claude.ai/api/organizations/{org_uuid}/usage` + SSE completion events `type: message_limit` | **Undocumented / unstable.** Org id from `lastActiveOrg` and/or `/api/organizations`. SSE often more precise (unrounded). Free plan may return REST `null` until after a reply — handle gracefully. |
| Cache timer | Client heuristic: last assistant timestamp + 5m (upstream pattern); optional “pending” on POST `/completion` | Not a documented claude.ai TTL field. Optional. |

**Critical constraint:** Service-worker / extension-origin fetch **does not** get session cookies → **MAIN-world** `fetch` wrap (or bridge that runs `fetch` in page) required. `sessionKey` is HttpOnly.

### 5.2 Extension shape (MV3)

1. Content script (ISOLATED) → inject MAIN-world bridge (`world: "MAIN"` and/or `web_accessible_resources` script).
2. Bridge wraps `window.fetch` + `history.pushState`/`replaceState` for SPA; `response.clone()` / stream `.tee()` for SSE.
3. Bridge ↔ isolated via `postMessage` / CustomEvent with **origin lock + schema** (page can spoof).
4. Redline UI: Shadow DOM overlay; attach via resilient selectors / MutationObserver — **UI only**; metrics never depend on brittle class names.
5. `chrome.storage.local` for prefs (show/hide cache timer, bar position). No remote sync.

Treat `/usage` and `message_limit` field names as **versioned adapters** — spike in DevTools day 0.

### 5.3 Pre-build spikes (blockers to clarify, not design debates)

1. Live capture of `/usage` + `message_limit` JSON on Free vs Pro/Max.
2. Current composer anchors (`[data-cds="ChatComposer"]`, `.rounded-composer`, forks’ lists).
3. Model → context limit map (Help Center vs pricing table inconsistency).
4. Free-plan REST null behavior.

---

## 6. UI (Redline)

**v1 overlay (minimal):**

- Thin context % bar (Cursor-like) + numeric %.
- Collapsed row or popover: tools | web | other (count + ~token %).
- Session bar + time-to-reset; weekly bar + time-to-reset.
- Optional cache countdown (toggle in popup settings; off if unverifiable).
- Does not fight Claude’s composer; high contrast; no skins.

**Popup (extension icon):** on/off, optional cache timer, “metrics from network (local only)” one-liner, GitHub link.

**Ownership split:** Redline owns inject layout, visual hierarchy, motion, empty/error states (“usage unavailable — send a message”). Always-On owns bridge, parsers, tokenizer, adapters.

---

## 7. v1.1+ (explicitly later)

| Order | Scope |
|---|---|
| v1.1 | ChatGPT — estimate mode OK |
| v1.2 | Grok — opt-in; estimate OK |
| Later | Export, richer history — only if still personal-pain |

No day-1 parity across providers.

---

## 8. Success criteria

1. On current claude.ai UI (post–Aug 2026), overlay mounts near composer without console spam.
2. Context % updates after send within a few seconds; moves when tools/web run.
3. Breakdown sums roughly to context estimate (documented as approximate).
4. Session + weekly bars match Settings → Usage directionally; reset timers sane.
5. Network tab / extension: **zero** calls except `claude.ai` (+ extension chrome APIs).
6. Load unpacked works; README: install + architecture + adapter versioning.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Undocumented API rename | Adapter layer; fail soft; issue template for capture |
| DOM attach breakage | Metrics independent of DOM; Redline resilient anchors + quick patch cadence (Shubham accepts maintenance) |
| Tokenizer drift vs Claude | Label “approx”; prefer relative % over absolute |
| Upstream MIT reuse | Prefer clean-room under shiphook; if copying, preserve MIT attribution |
| Free plan null usage | Empty state + SSE after first reply |
| Competing with Metrician narrative | Marketing: Claude-only composer overlay + composition breakdown |

---

## 10. Repo / delivery

- New public repo under https://github.com/shiphook (name TBD: `shiphook` / `claude-context` — Always-On picks).
- MIT; README + CONTRIBUTING light.
- No Chrome Web Store push required for v1 personal use (load unpacked); CWS optional later.
- Do **not** post to X about it unless CoM/Shubham ask.

---

## 11. Source index (research 2026-09-06)

- https://github.com/she-llac/claude-counter (+ issues #47/#45/#27/#26, PR #34 unmerged)
- https://github.com/kr1shnasomani/claude-token-counter (architecture README)
- Community forks with DOM fixes: hey-naf, Rohx24
- https://github.com/shiphook
- https://metrician.io/ · https://claude-monitor.com/ · https://claude-meter.com/
- https://dev.to/anoop_kumar_63925e275ea06/how-i-built-a-chrome-extension-that-reads-claudes-internal-api-50cn (TokenPulse — treat schema as unstable)
- https://support.claude.com/en/articles/8606394-how-large-is-the-context-window-on-paid-claude-plans
- https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Internal notes from research pass (this turn)

---

## 12. Build note

Approved to build in parallel. Always-On leads eng; Redline owns inject UI. This PRD is the shared contract — spike undocumented shapes first, then overlay.
