/**
 * Shiphook Claude Meter — inject UI (Shadow DOM)
 * PRD: near composer, context % primary, tools|web|other, session+weekly+resets,
 * optional cache, high contrast, empty/error: "usage unavailable — send a message"
 *
 * Mount: #shiphook-claude-meter
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

  const COMPOSER_SELECTORS = [
    '[data-cds="ChatComposer"]',
    ".rounded-composer",
    "fieldset.rounded-composer",
    '[class*="ChatComposer"]',
    "form[class*='composer']",
    "main form textarea",
  ];

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

  function fmtReset(part) {
    if (!part) return "";
    if (part.resetsInSec != null && !Number.isNaN(Number(part.resetsInSec))) {
      const s = Math.max(0, Number(part.resetsInSec));
      if (s < 60) return `resets ${s}s`;
      if (s < 3600) return `resets ${Math.round(s / 60)}m`;
      if (s < 86400) return `resets ${(s / 3600).toFixed(1)}h`;
      return `resets ${(s / 86400).toFixed(1)}d`;
    }
    if (part.resetsAt) {
      const ms = Number(part.resetsAt) - Date.now();
      if (ms > 0) return fmtReset({ resetsInSec: Math.round(ms / 1000) });
    }
    return "";
  }

  function fmtCache(cache) {
    if (!cache) return "";
    if (cache.ttlSecRemaining != null && !Number.isNaN(Number(cache.ttlSecRemaining))) {
      const s = Math.max(0, Number(cache.ttlSecRemaining));
      return s < 60 ? `${s}s` : `${Math.ceil(s / 60)}m`;
    }
    if (cache.expiresAt) {
      const s = Math.max(0, Math.round((Number(cache.expiresAt) - Date.now()) / 1000));
      return s < 60 ? `${s}s` : `${Math.ceil(s / 60)}m`;
    }
    return "";
  }

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.getBoundingClientRect().height > 0) return el;
      } catch (_) {}
    }
    return null;
  }

  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("role", "region");
      host.setAttribute("aria-label", "Claude usage meter");
      (document.documentElement || document.body).appendChild(host);
    }
    return host;
  }

  function positionHost(host) {
    const composer = findComposer();
    host.style.cssText = "";
    host.style.position = "fixed";
    host.style.zIndex = "2147483646";
    host.style.pointerEvents = "none";
    if (composer) {
      const r = composer.getBoundingClientRect();
      // sit above-right of composer; keep on-screen
      const top = Math.max(8, r.top - 8);
      const right = Math.max(8, window.innerWidth - r.right);
      host.style.top = `${Math.min(top, window.innerHeight - 120)}px`;
      host.style.right = `${right}px`;
      host.style.bottom = "auto";
      host.dataset.anchor = "composer";
    } else {
      host.style.right = "14px";
      host.style.bottom = "14px";
      host.style.top = "auto";
      host.dataset.anchor = "corner";
    }
  }

  function createUi(shadow) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.collapsed = "false";
    panel.style.pointerEvents = "auto";
    panel.tabIndex = 0;

    panel.innerHTML = `
      <div class="chip" aria-hidden="true"><span class="chip-pct">—</span></div>
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
      chipPct: panel.querySelector(".chip-pct"),
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

    const unavailable =
      s.status === "error" ||
      (s.status === "waiting" && s.context?.percent == null && s.session?.percent == null);

    if (refs.empty) {
      refs.empty.hidden = !unavailable;
      if (unavailable) refs.empty.textContent = s.error || ERR_COPY;
    }

    const ctxPct = clampPct(s.context?.percent);
    refs.contextPct.textContent = fmtPct(ctxPct);
    refs.chipPct.textContent = fmtPct(ctxPct);
    refs.contextFill.style.width = ctxPct == null ? "0%" : `${ctxPct}%`;
    refs.model.textContent = s.model ? s.model.replace(/^claude-/, "") : "";
    // model-aware limit from eng — never hardcode 200k in UI
    if (refs.contextDetail) {
      const used = s.context?.tokensApprox;
      const limit = s.context?.limit;
      if (used != null || limit != null) {
        refs.contextDetail.textContent = `${fmtTokens(used)} / ${fmtTokens(limit)}`;
      } else {
        refs.contextDetail.textContent = "";
      }
    }

    const shares = breakdownShares(s.breakdown);
    refs.segT.style.width = `${shares.t}%`;
    refs.segW.style.width = `${shares.w}%`;
    refs.segO.style.width = `${shares.o}%`;
    const bd = s.breakdown || {};
    refs.tools.textContent = breakdownLabel(bd.tool_call, shares.t);
    refs.web.textContent = breakdownLabel(bd.web_search, shares.w);
    refs.other.textContent = breakdownLabel(bd.other, shares.o);

    const sp = clampPct(s.session?.percent);
    refs.sessionPct.textContent = fmtPct(sp);
    refs.sessionFill.style.width = sp == null ? "0%" : `${sp}%`;
    refs.sessionReset.textContent = fmtReset(s.session);

    const wp = clampPct(s.weekly?.percent);
    refs.weeklyPct.textContent = fmtPct(wp);
    refs.weeklyFill.style.width = wp == null ? "0%" : `${wp}%`;
    refs.weeklyReset.textContent = fmtReset(s.weekly);

    const cacheTxt = fmtCache(s.cache);
    if (refs.cacheRow) {
      const show = showCache && !!cacheTxt;
      refs.cacheRow.hidden = !show;
      if (show) refs.cacheTtl.textContent = cacheTxt;
    }

    const st = s.status || "waiting";
    refs.status.dataset.s = st;
    if (st === "error") refs.status.textContent = "error";
    else if (st === "waiting") refs.status.textContent = "waiting";
    else refs.status.textContent = "live";

    const ctxAria = ctxPct == null ? "Context unknown" : `Context ${Math.round(ctxPct)} percent`;
    refs.panel.setAttribute("aria-label", `Claude usage meter. ${ctxAria}.`);
  }

  function readPrefs(cb) {
    const defaults = { enabled: true, showCache: false };
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      cb(defaults);
      return;
    }
    chrome.storage.local.get(defaults, (p) => cb({ ...defaults, ...p }));
  }

  function mount() {
    const host = ensureHost();
    if (host.shadowRoot && host.__shiphookMeter) {
      positionHost(host);
      return host.__shiphookMeter;
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

    if (STYLE_URL) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = STYLE_URL;
      shadow.appendChild(link);
    } else if (globalThis.__SHIPHOOK_METER_CSS__) {
      const style = document.createElement("style");
      style.textContent = globalThis.__SHIPHOOK_METER_CSS__;
      shadow.appendChild(style);
    } else {
      const style = document.createElement("style");
      style.textContent =
        `.panel{position:relative;width:248px;background:#0f0f0f;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:10px;padding:10px 12px;font:12px/1.35 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5)}.bar{height:6px;background:#1f1f1f;border-radius:99px;overflow:hidden}.bar>i{display:block;height:100%;background:#a894ff}.pct{font-size:22px;font-weight:650;margin:6px 0 8px;color:#fff}.meta,.label,.status{color:#a3a3a3;font-size:10px}.empty{margin-top:8px;font-size:11px;color:#f0b429}.panel[data-collapsed=true] .body{display:none}.chip{display:none}.panel[data-collapsed=true] .chip{display:flex;font-weight:600}`;
      shadow.appendChild(style);
    }

    const { refs, setCollapsed } = createUi(shadow);
    let state = { status: "waiting", updatedAt: Date.now() };
    let prefs = { enabled: true, showCache: false };

    function applyVisibility() {
      host.style.display = prefs.enabled === false ? "none" : "";
    }

    function paint() {
      render(refs, state, prefs);
      applyVisibility();
      positionHost(host);
    }

    function setState(next) {
      state = next && typeof next === "object" ? next : state;
      paint();
    }

    host.addEventListener("shiphook-meter:update", (ev) => {
      if (ev?.detail) setState(ev.detail);
    });

    readPrefs((p) => {
      prefs = p;
      paint();
    });

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.enabled) prefs.enabled = changes.enabled.newValue;
        if (changes.showCache) prefs.showCache = changes.showCache.newValue;
        paint();
      });
    }

    window.addEventListener("resize", () => positionHost(host), { passive: true });
    window.addEventListener("scroll", () => positionHost(host), { passive: true, capture: true });

    const api = {
      setState,
      getState: () => state,
      setCollapsed,
      host,
      reposition: () => positionHost(host),
    };
    host.__shiphookMeter = api;
    window.__SHIPHOOK_METER__ = api;
    paint();
    return api;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mount());
  } else {
    mount();
  }

  const mo = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) mount();
    else if (window.__SHIPHOOK_METER__?.reposition) window.__SHIPHOOK_METER__.reposition();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  globalThis.__SHIPHOOK_METER_MOUNT__ = mount;
})();
