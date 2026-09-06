/**
 * Shiphook Claude Meter — ISOLATED content script.
 * Injects MAIN-world fetch-hook, mounts Redline overlay, merges MeterState.
 * Metrics from network (postMessage) — never depend on brittle DOM anchors.
 *
 * Prefs (chrome.storage.local):
 *   enabled   — default true; if false, do not inject/mount overlay
 *   showCache — default false; only pass cache fields when true
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';
  const HOST_ID = 'shiphook-claude-meter';

  /** @type {boolean} */
  let enabled = true;
  /** @type {boolean} */
  let showCache = false;
  /** @type {boolean} */
  let overlayLoaded = false;
  /** @type {string|null} */
  let lastOrgId = null;

  let meterState = createEmptyState();

  function createEmptyState() {
    const bucket = () => ({ count: 0, tokensApprox: 0 });
    const usage = () => ({ utilization: 0, percent: 0 });
    return {
      updatedAt: Date.now(),
      context: { tokensApprox: 0, limit: 200000, percent: 0 },
      breakdown: {
        tool_call: bucket(),
        web_search: bucket(),
        other: bucket(),
      },
      session: usage(),
      weekly: usage(),
      status: 'waiting',
    };
  }

  // --- prefs ---
  function readPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(
          { enabled: true, showCache: false },
          (result) => {
            enabled = result.enabled !== false;
            showCache = result.showCache === true;
            resolve({ enabled, showCache });
          }
        );
      } catch (_) {
        enabled = true;
        showCache = false;
        resolve({ enabled, showCache });
      }
    });
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        applyEnabled();
      }
      if (changes.showCache) {
        showCache = changes.showCache.newValue === true;
        pushStateToOverlay();
      }
    });
  } catch (_) {
    /* ignore */
  }

  function applyEnabled() {
    if (enabled) {
      remountOverlayIfNeeded();
      const host = document.getElementById(HOST_ID);
      if (host) host.style.display = '';
    } else {
      const host = document.getElementById(HOST_ID);
      if (host) {
        // Hide rather than remove — Redline overlay MutationObserver remounts on remove
        host.style.display = 'none';
      }
    }
  }

  // MAIN-world fetch-hook is registered via manifest content_scripts world:MAIN.
  // Keep a no-op for older loads; do not script-tag inject (CSP / ordering issues).
  function injectFetchHook() {
    /* intentional no-op — see manifest world: MAIN entry */
  }

  // --- host ---
  function ensureHost() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-shiphook', 'claude-meter');
      host.setAttribute('role', 'region');
      host.setAttribute('aria-label', 'Claude usage meter');
      (document.documentElement || document.body || document).appendChild(host);
    }
    if (!enabled) host.style.display = 'none';
    return host;
  }

  /**
   * Overlay is loaded via manifest content_scripts (overlay.js before this file).
   * MV3 extension CSP blocks eval — never fetch+eval overlay.js.
   */
  function loadOverlay() {
    if (!enabled) return null;
    ensureHost();
    const api = window.__SHIPHOOK_METER__;
    if (api) {
      overlayLoaded = true;
      if (typeof api.reposition === 'function') {
        try { api.reposition(); } catch (_) { /* ignore */ }
      }
      return api;
    }
    // Overlay content script may still be mounting — host stays for MutationObserver
    return null;
  }

  function stateForUi() {
    const out = { ...meterState };
    if (!showCache) {
      delete out.cache;
    }
    return out;
  }

  function pushStateToOverlay() {
    if (!enabled) return;
    const api = window.__SHIPHOOK_METER__;
    if (api && typeof api.setState === 'function') {
      api.setState(stateForUi());
    }
    const host = document.getElementById(HOST_ID);
    if (host) {
      try {
        host.dispatchEvent(
          new CustomEvent('shiphook-meter:update', { detail: stateForUi() })
        );
      } catch (_) {
        /* ignore */
      }
    }
  }

  function setState(partial) {
    meterState = {
      ...meterState,
      ...partial,
      context: { ...meterState.context, ...(partial.context || {}) },
      breakdown: mergeBreakdown(meterState.breakdown, partial.breakdown),
      session: { ...meterState.session, ...(partial.session || {}) },
      weekly: { ...meterState.weekly, ...(partial.weekly || {}) },
      updatedAt: Date.now(),
    };
    if (partial.cache !== undefined) meterState.cache = partial.cache;
    if (partial.model !== undefined) meterState.model = partial.model;
    if (partial.error !== undefined) meterState.error = partial.error;
    if (partial.status) meterState.status = partial.status;

    pushStateToOverlay();

    try {
      chrome.runtime.sendMessage({
        source: SOURCE,
        type: 'storage.set',
        patch: {
          lastStatus: meterState.status,
          lastUpdatedAt: meterState.updatedAt,
        },
      });
    } catch (_) {
      /* extension context invalidated */
    }
  }

  function mergeBreakdown(prev, next) {
    if (!next) return prev;
    const keys = ['tool_call', 'web_search', 'other'];
    const out = { ...prev };
    for (const k of keys) {
      if (next[k]) out[k] = { ...prev[k], ...next[k] };
    }
    return out;
  }

  // --- postMessage from MAIN world ---
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === 'ready') {
      setState({
        status: meterState.status === 'error' ? 'error' : 'waiting',
      });
      scheduleUsagePoll();
      return;
    }
    if (msg.type === 'org') {
      if (msg.payload && msg.payload.orgId) {
        lastOrgId = msg.payload.orgId;
      }
      return;
    }
    if (msg.type === 'usage') {
      handleUsagePayload(msg.payload);
      return;
    }
    if (msg.type === 'sse') {
      handleSsePayload(msg.payload);
    }
  });

  // Request ready signal from MAIN world
  window.postMessage({ source: SOURCE, type: 'request_ready' }, '*');

  function handleUsagePayload(payload) {
    if (!payload) return;
    const kind = payload.kind;
    const data = payload.data;

    if (kind === 'fetch_error') {
      setState({
        status:
          meterState.session.percent || meterState.weekly.percent
            ? 'ok'
            : 'waiting',
        error:
          payload.error ||
          (payload.status ? 'usage_http_' + payload.status : 'usage_fetch_error'),
      });
      return;
    }

    if (kind === 'message_limit' || kind === 'polled' || kind === 'json') {
      // When kind===json with messages, ALWAYS walk tree BEFORE returning on empty
      if (kind === 'json' && data && (data.chat_messages || data.messages)) {
        applyConversationTree(data);
        return;
      }

      const normalized = normalizeUsageInline(data);
      if (normalized && normalized.empty) {
        // Free plan REST null → fail soft empty / waiting
        setState({ status: 'waiting', error: undefined });
        return;
      }
      if (normalized) {
        setState({
          session: normalized.session,
          weekly: normalized.weekly,
          status: 'ok',
          error: undefined,
        });
      }
    }
  }

  function handleSsePayload(payload) {
    if (!payload) return;
    if (payload.kind === 'tool') {
      const key =
        payload.toolKind === 'web_search' ? 'web_search' : 'tool_call';
      const prev = meterState.breakdown[key] || { count: 0, tokensApprox: 0 };
      const addTokens = Math.ceil((payload.approxChars || 0) / 4);
      setState({
        breakdown: {
          [key]: {
            count: prev.count + 1,
            tokensApprox: (prev.tokensApprox || 0) + addTokens,
          },
        },
        status: 'ok',
      });
    }
    if (payload.kind === 'conversation_json' && payload.data) {
      applyConversationTree(payload.data);
    }
  }

  /**
   * Trunk walk: current_leaf_message_uuid → parent_message_uuid.
   * Mirrors src/lib/tokens.js (content scripts stay bundle-free).
   */
  function applyConversationTree(tree) {
    try {
      const messages =
        tree.chat_messages ||
        tree.messages ||
        (tree.conversation && tree.conversation.chat_messages) ||
        [];
      if (!Array.isArray(messages)) return;

      const byUuid = new Map();
      for (const msg of messages) {
        const id = msg.uuid || msg.id;
        if (id) byUuid.set(String(id), msg);
      }
      const leafId =
        tree.current_leaf_message_uuid || tree.currentLeafMessageUuid || null;

      const trunk = [];
      if (leafId && byUuid.has(String(leafId))) {
        let cur = byUuid.get(String(leafId));
        const seen = new Set();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          trunk.push(cur);
          const parentId = cur.parent_message_uuid || cur.parentMessageUuid;
          cur = parentId ? byUuid.get(String(parentId)) : null;
        }
        trunk.reverse();
      } else {
        trunk.push(...messages);
      }

      const breakdown = {
        tool_call: { count: 0, tokensApprox: 0 },
        web_search: { count: 0, tokensApprox: 0 },
        other: { count: 0, tokensApprox: 0 },
      };
      let totalChars = 0;

      function blockText(b) {
        if (!b) return '';
        if (typeof b === 'string') return b;
        if (typeof b.text === 'string') return b.text;
        if (typeof b.content === 'string') return b.content;
        try {
          return JSON.stringify(b);
        } catch {
          return '';
        }
      }

      function classify(b) {
        if (!b || typeof b !== 'object') return 'other';
        const type = String(b.type || '').toLowerCase();
        const name = String(b.name || b.tool_name || '').toLowerCase();
        // PRD: web_search = named tool_use
        if (name.includes('web_search') || type.includes('web_search')) {
          return 'web_search';
        }
        if (
          type === 'tool_use' ||
          type === 'tool_result' ||
          type === 'tool_call' ||
          type === 'server_tool'
        ) {
          return 'tool_call';
        }
        return 'other';
      }

      for (const msg of trunk) {
        const content = msg.content || msg.contents || [];
        const blocks = Array.isArray(content)
          ? content
          : typeof content === 'string'
            ? [{ type: 'text', text: content }]
            : [];
        for (const b of blocks) {
          const t = blockText(b);
          totalChars += t.length;
          const key = classify(b);
          breakdown[key].count += 1;
          breakdown[key].tokensApprox += Math.ceil(t.length / 4);
        }
      }

      const model =
        tree.model ||
        tree.chat_model ||
        (tree.conversation && tree.conversation.model) ||
        meterState.model;
      const limit = resolveLimit(model, meterState.context.limit);
      const tokensApprox = Math.ceil(totalChars / 4);
      const percent =
        limit > 0 ? Math.min(100, (tokensApprox / limit) * 100) : 0;

      // Soft cache timer (~5 min) — optional; only forwarded when showCache
      let cache;
      try {
        let lastAssistant = null;
        for (const msg of trunk) {
          const role = String(msg.role || msg.sender || '').toLowerCase();
          if (role === 'assistant' || role === 'bot') {
            const ts = Date.parse(msg.created_at || msg.updated_at || '');
            if (ts && (!lastAssistant || ts > lastAssistant)) lastAssistant = ts;
          }
        }
        if (lastAssistant) {
          const expiresAt = lastAssistant + 5 * 60 * 1000;
          const remainingMs = expiresAt - Date.now();
          if (remainingMs > 0) cache = { expiresAt, remainingMs };
        }
      } catch (_) {
        /* ignore */
      }

      const patch = {
        model,
        context: { tokensApprox, limit, percent },
        breakdown,
        status: 'ok',
      };
      if (cache) patch.cache = cache;
      setState(patch);
    } catch (err) {
      setState({
        status: 'error',
        error: err && err.message ? err.message : 'tree_walk_error',
      });
    }
  }

  /** Model-aware map: 200k / 500k / 1M — do not hardcode only 200k */
  function resolveLimit(model, fallback) {
    if (!model) return fallback || 200000;
    const s = String(model).toLowerCase();
    if (/\b1m\b|1000000/.test(s)) return 1000000;
    if (/\b500k\b|500000/.test(s)) return 500000;
    if (/\b200k\b|200000/.test(s)) return 200000;
    return fallback || 200000;
  }

  /** Defensive inline normalize (mirrors src/lib/usage.js adapters). */
  function normalizeUsageInline(apiJson) {
    if (apiJson == null) return { empty: true };
    if (typeof apiJson !== 'object') return null;

    const emptyB = () => ({ utilization: 0, percent: 0 });
    const result = { session: emptyB(), weekly: emptyB() };

    function num(...vals) {
      for (const v of vals) {
        if (v == null || v === '') continue;
        const n = Number(v);
        if (!Number.isNaN(n) && Number.isFinite(n)) return n;
      }
      return null;
    }
    function str(...vals) {
      for (const v of vals) {
        if (v != null && String(v).length) return String(v);
      }
      return null;
    }
    function bucket(b) {
      if (!b || typeof b !== 'object') return null;
      let util = num(b.utilization, b.util);
      if (util == null) {
        const used = num(b.used, b.usage, b.consumed);
        const limit = num(b.limit, b.max, b.quota);
        if (used != null && limit) util = used / limit;
      }
      if (util == null && b.percent != null) util = Number(b.percent) / 100;
      const resetsAt = str(b.resets_at, b.resetsAt, b.reset_at, b.resetAt);
      let resetsInSec = num(
        b.resets_in_seconds,
        b.resetsInSec,
        b.resets_in_sec,
        b.seconds_remaining
      );
      // Parse resets_at: number < 1e12 → unix seconds → ms epoch
      if (resetsAt != null && resetsInSec == null) {
        const n = Number(resetsAt);
        if (!Number.isNaN(n) && Number.isFinite(n)) {
          const ms = n < 1e12 ? n * 1000 : n;
          resetsInSec = Math.max(0, Math.floor((ms - Date.now()) / 1000));
        }
      }
      if (util == null) {
        if (resetsAt == null && resetsInSec == null) return null;
        return {
          utilization: 0,
          percent: 0,
          ...(resetsAt ? { resetsAt } : {}),
          ...(resetsInSec != null ? { resetsInSec } : {}),
        };
      }
      const clamped = Math.min(1, Math.max(0, util));
      const out = {
        utilization: clamped,
        percent: Math.min(
          100,
          Math.max(0, num(b.percent, clamped * 100) ?? clamped * 100)
        ),
      };
      if (resetsAt) out.resetsAt = resetsAt;
      if (resetsInSec != null) out.resetsInSec = resetsInSec;
      return out;
    }

    const root =
      apiJson.message_limit ||
      apiJson.messageLimit ||
      (apiJson.type === 'message_limit' ? apiJson : apiJson);

    // Parse windows["5h"] → session, windows["7d"] → weekly
    const windows = root.windows || apiJson.windows || null;
    const sessionSrc =
      (windows && typeof windows === 'object'
        ? windows['5h'] || windows['5H'] || windows.session
        : null) ||
      root.five_hour ||
      root.fiveHour ||
      root.session ||
      root.rate_limit_0 ||
      apiJson.five_hour ||
      apiJson.session;
    const weeklySrc =
      (windows && typeof windows === 'object'
        ? windows['7d'] || windows['7D'] || windows.weekly
        : null) ||
      root.seven_day ||
      root.sevenDay ||
      root.weekly ||
      root.rate_limit_1 ||
      apiJson.seven_day ||
      apiJson.weekly;

    const s = bucket(sessionSrc);
    const w = bucket(weeklySrc);
    if (!s && !w) {
      const flat = bucket(root);
      if (!flat) return { empty: true };
      result.session = flat;
      return result;
    }
    if (s) result.session = s;
    if (w) result.weekly = w;
    return result;
  }

  // --- org id + usage poll (best-effort) ---
  function readLastActiveOrg() {
    // Prefer lastOrgId from fetch-hook org messages
    if (lastOrgId) return lastOrgId;

    try {
      const cookies = document.cookie.split(';');
      for (const c of cookies) {
        const [k, ...rest] = c.trim().split('=');
        if (k === 'lastActiveOrg' || k === 'lastActiveOrganization') {
          return decodeURIComponent(rest.join('='));
        }
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const ls =
        localStorage.getItem('lastActiveOrg') ||
        localStorage.getItem('lastActiveOrganization');
      if (ls) return ls;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  let pollTimer = null;
  function scheduleUsagePoll() {
    if (pollTimer) return;
    const tick = () => {
      requestUsageFetch();
      pollTimer = setTimeout(tick, 60_000);
    };
    pollTimer = setTimeout(tick, 2_000);
  }

  function requestUsageFetch() {
    const org = readLastActiveOrg();
    if (!org) {
      setState({
        status: meterState.status === 'ok' ? 'ok' : 'waiting',
      });
      return;
    }
    // Same-origin usage via MAIN-world fetch (cookies). Adapters in usage.js.
    const url =
      'https://claude.ai/api/organizations/' +
      encodeURIComponent(org) +
      '/usage';
    window.postMessage(
      {
        source: SOURCE,
        type: 'request_usage_fetch',
        payload: { url },
      },
      '*'
    );
  }

  /** If SPA left an empty host (no ShadowRoot), ask overlay to remount. */
  function remountOverlayIfNeeded() {
    if (!enabled) return;
    const host = ensureHost();
    if (host && !host.shadowRoot) {
      try {
        if (typeof globalThis.__SHIPHOOK_METER_MOUNT__ === 'function') {
          globalThis.__SHIPHOOK_METER_MOUNT__();
        }
      } catch (_) {
        /* ignore */
      }
    }
    pushStateToOverlay();
  }

  // Reattach host if SPA removes it; remount shadow if host is empty shell

  /** Clean-room lugia-style: keep re-attaching if SPA wipes/hollows the host. */
  let remountRaf = 0;
  function startRemountLoop() {
    if (remountRaf) return;
    const tick = () => {
      remountRaf = 0;
      if (enabled) remountOverlayIfNeeded();
      remountRaf = requestAnimationFrame(tick);
    };
    remountRaf = requestAnimationFrame(tick);
  }

  function watchHost() {
    const obs = new MutationObserver(() => {
      if (!enabled) return;
      const host = document.getElementById(HOST_ID);
      if (!host) {
        remountOverlayIfNeeded();
        return;
      }
      if (!host.shadowRoot) {
        remountOverlayIfNeeded();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- boot ---
  injectFetchHook();

  async function boot() {
    await readPrefs();
    if (enabled) {
      remountOverlayIfNeeded();
      // Overlay may mount a tick later after SPA — retry
      setTimeout(() => remountOverlayIfNeeded(), 0);
      setTimeout(() => remountOverlayIfNeeded(), 250);
      setTimeout(() => remountOverlayIfNeeded(), 1000);
    }
    watchHost();
    startRemountLoop();
    scheduleUsagePoll();
    // Request ready signal from MAIN world at boot
    window.postMessage({ source: SOURCE, type: 'request_ready' }, '*');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      boot();
    }, { once: true });
  } else {
    boot();
  }
})();
