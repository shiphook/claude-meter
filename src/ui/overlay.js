/**
 * Shiphook Claude Meter — inject UI (Shadow DOM)
 * Mount: #shiphook-claude-meter
 * Updates: CustomEvent "shiphook-meter:update" on host, or window.__SHIPHOOK_METER__.setState(state)
 * No network. Renders with missing fields as "—".
 */
(function () {
  const HOST_ID = "shiphook-claude-meter";
  const STYLE_URL = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
    ? chrome.runtime.getURL("src/ui/overlay.css")
    : null;

  /** @typedef {import('./meter-types').MeterState} MeterState */

  const cssText = `/* inlined fallback if fetch fails — content script should prefer getURL */`;

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

  function fmtReset(statePart) {
    if (!statePart) return "";
    if (statePart.resetsInSec != null && !Number.isNaN(Number(statePart.resetsInSec))) {
      const s = Math.max(0, Number(statePart.resetsInSec));
      if (s < 60) return `resets ${s}s`;
      if (s < 3600) return `resets ${Math.round(s / 60)}m`;
      if (s < 86400) return `resets ${(s / 3600).toFixed(1)}h`;
      return `resets ${(s / 86400).toFixed(1)}d`;
    }
    return "";
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

  function createUi(shadow) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.collapsed = "false";
    panel.tabIndex = 0;

    panel.innerHTML = `
      <div class="chip" aria-hidden="true">
        <span class="chip-pct">—</span>
      </div>
      <div class="body">
        <div class="row">
          <span class="title">Context</span>
          <span class="meta model"></span>
        </div>
        <div class="pct" data-k="context-pct">—</div>
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
      status: $("status"),
      collapse: $("collapse"),
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
    // fall back to counts
    const ct = Number(bd.tool_call?.count) || 0;
    const cw = Number(bd.web_search?.count) || 0;
    const co = Number(bd.other?.count) || 0;
    const csum = ct + cw + co;
    if (csum <= 0) return { t: 0, w: 0, o: 0 };
    return { t: (ct / csum) * 100, w: (cw / csum) * 100, o: (co / csum) * 100 };
  }

  function render(refs, state) {
    const s = state || {};
    const ctxPct = clampPct(s.context?.percent);
    refs.contextPct.textContent = fmtPct(ctxPct);
    refs.chipPct.textContent = fmtPct(ctxPct);
    refs.contextFill.style.width = ctxPct == null ? "0%" : `${ctxPct}%`;

    if (s.model) {
      refs.model.textContent = s.model.replace(/^claude-/, "");
    } else {
      refs.model.textContent = "";
    }

    const shares = breakdownShares(s.breakdown);
    refs.segT.style.width = `${shares.t}%`;
    refs.segW.style.width = `${shares.w}%`;
    refs.segO.style.width = `${shares.o}%`;

    const bd = s.breakdown || {};
    const toolsLabel = bd.tool_call?.tokensApprox != null
      ? fmtTokens(bd.tool_call.tokensApprox)
      : fmtCount(bd.tool_call?.count);
    const webLabel = bd.web_search?.tokensApprox != null
      ? fmtTokens(bd.web_search.tokensApprox)
      : fmtCount(bd.web_search?.count);
    const otherLabel = bd.other?.tokensApprox != null
      ? fmtTokens(bd.other.tokensApprox)
      : fmtCount(bd.other?.count);
    refs.tools.textContent = toolsLabel;
    refs.web.textContent = webLabel;
    refs.other.textContent = otherLabel;

    const sp = clampPct(s.session?.percent);
    refs.sessionPct.textContent = fmtPct(sp);
    refs.sessionFill.style.width = sp == null ? "0%" : `${sp}%`;
    refs.sessionReset.textContent = fmtReset(s.session);

    const wp = clampPct(s.weekly?.percent);
    refs.weeklyPct.textContent = fmtPct(wp);
    refs.weeklyFill.style.width = wp == null ? "0%" : `${wp}%`;
    refs.weeklyReset.textContent = fmtReset(s.weekly);

    const st = s.status || "waiting";
    refs.status.dataset.s = st;
    if (st === "error") refs.status.textContent = s.error || "error";
    else if (st === "waiting") refs.status.textContent = "waiting";
    else refs.status.textContent = "live";

    const ctxAria = ctxPct == null ? "Context unknown" : `Context ${Math.round(ctxPct)} percent`;
    refs.panel.setAttribute("aria-label", `Claude usage meter. ${ctxAria}.`);
  }

  function mount() {
    const host = ensureHost();
    if (host.shadowRoot && host.__shiphookMeter) return host.__shiphookMeter;

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

    // Styles: prefer chrome.runtime.getURL (MV3 web_accessible), else window.__SHIPHOOK_METER_CSS__
    if (STYLE_URL) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = STYLE_URL;
      shadow.appendChild(link);
    } else if (typeof globalThis !== "undefined" && globalThis.__SHIPHOOK_METER_CSS__) {
      const style = document.createElement("style");
      style.textContent = globalThis.__SHIPHOOK_METER_CSS__;
      shadow.appendChild(style);
    } else {
      const style = document.createElement("style");
      style.textContent = `.panel{position:fixed;right:14px;bottom:14px;z-index:2147483646;width:248px;background:#141414;color:#e8e8e8;border:1px solid #2a2a2a;border-radius:10px;padding:10px 12px;font:12px/1.3 system-ui,sans-serif}.bar{height:6px;background:#262626;border-radius:99px;overflow:hidden}.bar>i{display:block;height:100%;background:#7c6af0}.meta,.label,.status{color:#8b8b8b;font-size:10px}.pct{font-size:22px;font-weight:650;margin:6px 0 8px}.section{margin-top:10px;padding-top:9px;border-top:1px solid #2a2a2a}.row{display:flex;justify-content:space-between}.btn{background:0;border:0;color:#8b8b8b;cursor:pointer;font-size:10px}.panel[data-collapsed=true]{width:auto;border-radius:999px;padding:6px 10px}.panel[data-collapsed=true] .body{display:none}.panel[data-collapsed=true] .chip{display:flex}.chip{display:none;font-weight:600}`;
      shadow.appendChild(style);
    }

    const { refs, setCollapsed } = createUi(shadow);
    let state = { status: "waiting", updatedAt: Date.now() };
    render(refs, state);

    function setState(next) {
      state = next && typeof next === "object" ? next : state;
      render(refs, state);
    }

    host.addEventListener("shiphook-meter:update", (ev) => {
      if (ev?.detail) setState(ev.detail);
    });

    const api = { setState, getState: () => state, setCollapsed, host };
    host.__shiphookMeter = api;
    window.__SHIPHOOK_METER__ = api;
    return api;
  }

  // auto-mount when script loads in page/content
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { mount(); });
  } else {
    mount();
  }

  // SPA reattach: if host removed, remount
  const mo = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) mount();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // export for module bundlers / tests
  if (typeof globalThis !== "undefined") {
    globalThis.__SHIPHOOK_METER_MOUNT__ = mount;
  }
})();
