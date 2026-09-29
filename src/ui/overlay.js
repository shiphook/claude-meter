/**
 * Shiphook Claude Meter — inject UI (Shadow DOM)
 * PRD: near composer, context % primary, tools|web|other, session+weekly+resets,
 * optional cache, high contrast, empty/error: "usage unavailable — send a message"
 *
 * Mount: #shiphook-claude-meter (fixed, bottom-right; .panel positions itself)
 * Updates: CustomEvent "shiphook-meter:update" | window.__SHIPHOOK_METER__.setState(state)
 * Prefs (chrome.storage.local): enabled (bool), showCache (bool)
 * No network from UI.
 */
(function () {
  const HOST_ID = "shiphook-claude-meter";
  const GITHUB = "https://github.com/shiphook/claude-meter";
  const ERR_COPY = "usage unavailable — send a message";
  const STYLE_URL =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("src/ui/overlay.css")
      : null;

  // Countdowns (resets, cache) re-render at this rate while the tab is visible.
  const TICK_MS = 30_000;

  function clampPct(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Math.max(0, Math.min(100, Number(n)));
  }

  function fmtPct(n) {
    const p = clampPct(n);
    return p == null ? "—" : `${Math.round(p)}%`;
  }

  function fmtCount(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    return String(n);
  }

  function fmtTokens(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  function fmtDuration(s) {
    if (s < 60) return `resets ${s}s`;
    if (s < 3600) return `resets ${Math.round(s / 60)}m`;
    if (s < 86400) return `resets ${(s / 3600).toFixed(1)}h`;
    return `resets ${(s / 86400).toFixed(1)}d`;
  }

  // Prefer the absolute resetsAt so the countdown moves between updates;
  // resetsInSec is a snapshot and only a fallback.
  function fmtReset(part) {
    if (!part) return "";
    if (part.resetsAt) {
      const ts = typeof part.resetsAt === "number"
        ? part.resetsAt
        : Date.parse(String(part.resetsAt));
      if (!Number.isNaN(ts)) {
        const ms = ts - Date.now();
        return ms > 0 ? fmtDuration(Math.round(ms / 1000)) : "";
      }
    }
    if (part.resetsInSec != null && !Number.isNaN(Number(part.resetsInSec))) {
      return fmtDuration(Math.max(0, Number(part.resetsInSec)));
    }
    return "";
  }

  function fmtCache(cache) {
    if (!cache) return "";
    let s = null;
    if (cache.expiresAt) {
      const ts = typeof cache.expiresAt === "number"
        ? cache.expiresAt
        : Date.parse(String(cache.expiresAt));
      if (!Number.isNaN(ts)) s = Math.round((ts - Date.now()) / 1000);
    }
    if (s == null && cache.ttlSecRemaining != null && !Number.isNaN(Number(cache.ttlSecRemaining))) {
      s = Number(cache.ttlSecRemaining);
    }
    if (s == null && cache.remainingMs != null && !Number.isNaN(Number(cache.remainingMs))) {
      s = Math.round(Number(cache.remainingMs) / 1000);
    }
    if (s == null || s <= 0) return "";
    return s < 60 ? `${s}s` : `${Math.ceil(s / 60)}m`;
  }

  function ensureHost() {
    // Reuse a detached host: re-appending keeps its shadow root, so no rebuild.
    let host = document.getElementById(HOST_ID) || (api && api.host);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("role", "region");
      host.setAttribute("aria-label", "Claude usage meter");
    }
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    // Set once. .panel is position:fixed itself, so the host needs no layout
    // work after this.
    if (!host.dataset.styled) {
      host.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;";
      host.dataset.styled = "1";
    }
    return host;
  }

  // Only touch the DOM when a value changes; unchanged writes still dirty style.
  function setText(el, v) {
    if (el && el.textContent !== v) el.textContent = v;
  }

  function setWidth(el, pct) {
    const v = pct == null ? "0%" : `${Math.round(pct * 100) / 100}%`;
    if (el && el.style.width !== v) el.style.width = v;
  }

  function createUi(shadow) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.collapsed = "false";
    panel.style.pointerEvents = "auto";
    panel.tabIndex = 0;

    panel.innerHTML = `
      <div class="chip" aria-hidden="true">
        <div class="chip-session">
          <div class="chip-row">
            <span class="chip-label">Session</span>
            <span class="chip-pct" data-k="chip-session-pct">—</span>
          </div>
          <div class="chip-bar"><i data-k="chip-session-fill"></i></div>
        </div>
        <div class="chip-weekly">
          <div class="chip-row">
            <span class="chip-label">Weekly</span>
            <span class="chip-pct" data-k="chip-weekly-pct">—</span>
          </div>
          <div class="chip-bar"><i data-k="chip-weekly-fill"></i></div>
        </div>
      </div>
      <div class="body">
        <div class="row">
          <span class="title">Context</span>
          <span class="meta model"></span>
        </div>
        <div class="pct" data-k="context-pct">—</div>
        <div class="meta context-detail" data-k="context-detail"></div>
        <div class="bar" aria-hidden="true"><i data-k="context-fill"></i></div>
        <div class="seg" aria-hidden="true">
          <i class="t" data-k="seg-t"></i>
          <i class="w" data-k="seg-w"></i>
          <i class="o" data-k="seg-o"></i>
        </div>
        <div class="legend">
          <span><span class="dot t"></span>tools <b data-k="tools">—</b></span>
          <span><span class="dot w"></span>web <b data-k="web">—</b></span>
          <span><span class="dot o"></span>other <b data-k="other">—</b></span>
        </div>
        <div class="section">
          <div class="row">
            <span class="label">Session</span>
            <span class="val" data-k="session-pct">—</span>
          </div>
          <div class="bar" aria-hidden="true"><i data-k="session-fill"></i></div>
          <div class="meta" data-k="session-reset" style="margin-top:4px"></div>
        </div>
        <div class="section">
          <div class="row">
            <span class="label">Weekly</span>
            <span class="val" data-k="weekly-pct">—</span>
          </div>
          <div class="bar" aria-hidden="true"><i data-k="weekly-fill"></i></div>
          <div class="meta" data-k="weekly-reset" style="margin-top:4px"></div>
        </div>
        <div class="section cache" data-k="cache-row" hidden>
          <div class="row">
            <span class="label">Cache</span>
            <span class="val" data-k="cache-ttl">—</span>
          </div>
        </div>
        <div class="empty" data-k="empty" hidden>${ERR_COPY}</div>
        <div class="foot">
          <span class="status" data-k="status" data-s="waiting">waiting</span>
          <button type="button" class="btn" data-k="collapse" aria-label="Collapse meter">Collapse</button>
        </div>
      </div>
    `;
    shadow.appendChild(panel);

    const $ = (k) => panel.querySelector(`[data-k="${k}"]`);
    const refs = {
      panel,
      chipSessionPct: $("chip-session-pct"),
      chipSessionFill: $("chip-session-fill"),
      chipWeeklyPct: $("chip-weekly-pct"),
      chipWeeklyFill: $("chip-weekly-fill"),
      model: panel.querySelector(".model"),
      contextPct: $("context-pct"),
      contextDetail: $("context-detail"),
      contextFill: $("context-fill"),
      segT: $("seg-t"),
      segW: $("seg-w"),
      segO: $("seg-o"),
      tools: $("tools"),
      web: $("web"),
      other: $("other"),
      sessionPct: $("session-pct"),
      sessionFill: $("session-fill"),
      sessionReset: $("session-reset"),
      weeklyPct: $("weekly-pct"),
      weeklyFill: $("weekly-fill"),
      weeklyReset: $("weekly-reset"),
      cacheRow: $("cache-row"),
      cacheTtl: $("cache-ttl"),
      empty: $("empty"),
      status: $("status"),
      collapse: $("collapse"),
      body: panel.querySelector(".body"),
    };

    function setCollapsed(v) {
      panel.dataset.collapsed = v ? "true" : "false";
      refs.collapse.textContent = v ? "Expand" : "Collapse";
      refs.collapse.setAttribute("aria-label", v ? "Expand meter" : "Collapse meter");
    }

    refs.collapse.addEventListener("click", (e) => {
      e.stopPropagation();
      setCollapsed(panel.dataset.collapsed !== "true");
    });
    panel.addEventListener("click", () => {
      if (panel.dataset.collapsed === "true") setCollapsed(false);
    });

    return { refs, setCollapsed };
  }

  function breakdownShares(bd) {
    if (!bd) return { t: 0, w: 0, o: 0 };
    const t = Number(bd.tool_call?.tokensApprox) || 0;
    const w = Number(bd.web_search?.tokensApprox) || 0;
    const o = Number(bd.other?.tokensApprox) || 0;
    const sum = t + w + o;
    if (sum > 0) return { t: (t / sum) * 100, w: (w / sum) * 100, o: (o / sum) * 100 };
    const ct = Number(bd.tool_call?.count) || 0;
    const cw = Number(bd.web_search?.count) || 0;
    const co = Number(bd.other?.count) || 0;
    const csum = ct + cw + co;
    if (csum <= 0) return { t: 0, w: 0, o: 0 };
    return { t: (ct / csum) * 100, w: (cw / csum) * 100, o: (co / csum) * 100 };
  }

  function breakdownLabel(bucket, sharePct) {
    if (!bucket) return "—";
    const count = fmtCount(bucket.count);
    const tok = bucket.tokensApprox != null ? fmtTokens(bucket.tokensApprox) : null;
    const share = sharePct > 0 ? `${Math.round(sharePct)}%` : null;
    if (tok && share) return `${count} · ~${tok} (${share})`;
    if (tok) return `${count} · ~${tok}`;
    if (share) return `${count} (${share})`;
    return count;
  }

  function render(refs, state, prefs) {
    const s = state || {};
    const showCache = !!(prefs && prefs.showCache);

    // Free REST null / pre-reply: eng sends status=waiting with zeroed buckets
    const unavailable =
      s.status === "error" ||
      (s.status === "waiting" &&
        !(Number(s.context?.tokensApprox) > 0) &&
        !(Number(s.session?.percent) > 0) &&
        !(Number(s.weekly?.percent) > 0));

    if (refs.empty) {
      if (refs.empty.hidden !== !unavailable) refs.empty.hidden = !unavailable;
      if (unavailable) setText(refs.empty, s.error || ERR_COPY);
    }

    const ctxPct = clampPct(s.context?.percent);
    setText(refs.contextPct, fmtPct(ctxPct));
    setWidth(refs.contextFill, ctxPct);
    setText(refs.model, s.model ? s.model.replace(/^claude-/, "") : "");

    // Collapsed chip: session + weekly mini-bars (prefer chip.* overrides from eng)
    const chipSessionPct = clampPct(
      s.chip?.sessionPercent != null ? s.chip.sessionPercent : s.session?.percent
    );
    const chipWeeklyPct = clampPct(
      s.chip?.weeklyPercent != null ? s.chip.weeklyPercent : s.weekly?.percent
    );
    setText(refs.chipSessionPct, fmtPct(chipSessionPct));
    setWidth(refs.chipSessionFill, chipSessionPct);
    setText(refs.chipWeeklyPct, fmtPct(chipWeeklyPct));
    setWidth(refs.chipWeeklyFill, chipWeeklyPct);

    // model-aware limit from eng — never hardcode 200k in UI
    if (refs.contextDetail) {
      const used = s.context?.tokensApprox;
      const limit = s.context?.limit;
      if (used != null || limit != null) {
        setText(refs.contextDetail, `${fmtTokens(used)} / ${fmtTokens(limit)}`);
      } else {
        setText(refs.contextDetail, "");
      }
    }

    const shares = breakdownShares(s.breakdown);
    setWidth(refs.segT, shares.t);
    setWidth(refs.segW, shares.w);
    setWidth(refs.segO, shares.o);
    const bd = s.breakdown || {};
    setText(refs.tools, breakdownLabel(bd.tool_call, shares.t));
    setText(refs.web, breakdownLabel(bd.web_search, shares.w));
    setText(refs.other, breakdownLabel(bd.other, shares.o));

    const sp = clampPct(s.session?.percent);
    setText(refs.sessionPct, fmtPct(sp));
    setWidth(refs.sessionFill, sp);
    setText(refs.sessionReset, fmtReset(s.session));

    const wp = clampPct(s.weekly?.percent);
    setText(refs.weeklyPct, fmtPct(wp));
    setWidth(refs.weeklyFill, wp);
    setText(refs.weeklyReset, fmtReset(s.weekly));

    const cacheTxt = fmtCache(s.cache);
    if (refs.cacheRow) {
      const show = showCache && !!cacheTxt;
      if (refs.cacheRow.hidden !== !show) refs.cacheRow.hidden = !show;
      if (show) setText(refs.cacheTtl, cacheTxt);
    }

    const st = s.status || "waiting";
    if (refs.status.dataset.s !== st) refs.status.dataset.s = st;
    if (st === "error") setText(refs.status, "error");
    else if (st === "waiting") setText(refs.status, "waiting");
    else setText(refs.status, "live");

    const ctxAria = ctxPct == null ? "Context unknown" : `Context ${Math.round(ctxPct)} percent`;
    const aria = `Claude usage meter. ${ctxAria}.`;
    if (refs.panel.getAttribute("aria-label") !== aria) refs.panel.setAttribute("aria-label", aria);
  }

  function readPrefs(cb) {
    const defaults = { enabled: true, showCache: false };
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      cb(defaults);
      return;
    }
    chrome.storage.local.get(defaults, (p) => cb({ ...defaults, ...p }));
  }

  let api = null;
  let prefs = { enabled: true, showCache: false };

  function applyVisibility(host) {
    const v = prefs.enabled === false ? "none" : "";
    if (host.style.display !== v) host.style.display = v;
  }

  function mount() {
    const host = ensureHost();
    if (api && api.host === host && host.shadowRoot) return api;

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.replaceChildren();

    if (STYLE_URL) {
      // Hide until the sheet loads so the unstyled panel never flashes.
      host.style.visibility = "hidden";
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = STYLE_URL;
      const show = () => host.style.removeProperty("visibility");
      link.addEventListener("load", show, { once: true });
      link.addEventListener("error", show, { once: true });
      shadow.appendChild(link);
    } else if (globalThis.__SHIPHOOK_METER_CSS__) {
      const style = document.createElement("style");
      style.textContent = globalThis.__SHIPHOOK_METER_CSS__;
      shadow.appendChild(style);
    } else {
      const style = document.createElement("style");
      style.textContent =
        `.panel{position:fixed;right:14px;bottom:14px;width:248px;background:#0f0f0f;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:10px;padding:10px 12px;font:12px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5)}.bar{height:6px;background:#1f1f1f;border-radius:99px;overflow:hidden}.bar>i{display:block;height:100%;background:#a894ff}.pct{font-size:22px;font-weight:650;margin:6px 0 8px;color:#fff}.meta,.label,.status{color:#a3a3a3;font-size:10px}.empty{margin-top:8px;font-size:11px;color:#f0b429}.panel[data-collapsed=true] .body{display:none}.chip{display:none}.panel[data-collapsed=true] .chip{display:flex;font-weight:600}`;
      shadow.appendChild(style);
    }

    const { refs, setCollapsed } = createUi(shadow);
    let state = (api && api.getState()) || { status: "waiting", updatedAt: Date.now() };

    function paint() {
      render(refs, state, prefs);
      applyVisibility(host);
    }

    function setState(next) {
      state = next && typeof next === "object" ? next : state;
      paint();
    }

    host.addEventListener("shiphook-meter:update", (ev) => {
      if (ev?.detail) setState(ev.detail);
    });

    api = {
      setState,
      getState: () => state,
      setCollapsed,
      host,
      paint,
    };
    host.__shiphookMeter = api;
    window.__SHIPHOOK_METER__ = api;
    paint();
    return api;
  }

  readPrefs((p) => {
    prefs = p;
    api?.paint();
  });

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(changes.enabled || changes.showCache)) return;
      if (changes.enabled) prefs.enabled = changes.enabled.newValue;
      if (changes.showCache) prefs.showCache = changes.showCache.newValue;
      api?.paint();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount(), { once: true });
  } else {
    mount();
  }

  // The host is a direct child of <html>, so watching <html>'s own children is
  // enough to notice removal. No subtree observer: Claude mutates the DOM on
  // every streamed token.
  new MutationObserver(() => {
    if (api && !api.host.isConnected) mount();
  }).observe(document.documentElement, { childList: true });

  setInterval(() => {
    if (api && !document.hidden && prefs.enabled !== false) api.paint();
  }, TICK_MS);

  globalThis.__SHIPHOOK_METER_MOUNT__ = mount;
})();
