/**
 * Shiphook Claude Meter — ISOLATED content script.
 * Receives events from the MAIN-world fetch hook, keeps MeterState, persists
 * session/weekly/context locally, and pushes state to the overlay.
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';
  const HOST_ID = 'shiphook-claude-meter';
  const PERSIST_KEY = 'shiphook_usage_snapshot_v3';
  const API_BASE = 'https://claude.ai/api/organizations/';
  const DEFAULT_LIMIT = 200000;
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const POLL_MS = 60_000;
  const USAGE_MIN_GAP_MS = 10_000;
  const PERSIST_DEBOUNCE_MS = 1_000;
  // Claude usually loads the tree itself on navigation; only fetch if it doesn't.
  const TREE_FALLBACK_MS = 1_500;

  let enabled = true;
  let showCache = false;
  let meterState = createEmptyState();
  let lastOrgId = null;
  let hydrateComplete = false;
  let usageSeen = false;
  let contextSeen = false;
  let conversationId = extractConversationId(location.href);
  let lastHref = location.href;

  function emptyBucket() {
    return { count: 0, tokensApprox: 0 };
  }

  function emptyBreakdown() {
    return { tool_call: emptyBucket(), web_search: emptyBucket(), other: emptyBucket() };
  }

  function createEmptyState() {
    const usage = () => ({ utilization: 0, percent: 0 });
    return {
      updatedAt: Date.now(),
      context: { tokensApprox: 0, limit: DEFAULT_LIMIT, percent: 0 },
      breakdown: emptyBreakdown(),
      session: usage(),
      weekly: usage(),
      status: 'waiting',
    };
  }

  function extractConversationId(url) {
    const m = String(url || '').match(/\/chat\/([0-9a-fA-F-]{36})/);
    return m ? m[1] : null;
  }

  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  function windowHasReset(bucket) {
    const at = toMs(bucket && bucket.resetsAt);
    return at != null && at <= Date.now();
  }

  // ---------------------------------------------------------------------------
  // Prefs + persistence

  function readPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ enabled: true, showCache: false }, (result) => {
          enabled = result.enabled !== false;
          showCache = result.showCache === true;
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });
  }

  function hydrateUsageSnapshot() {
    return new Promise((resolve) => {
      const done = () => {
        hydrateComplete = true;
        resolve();
      };
      try {
        chrome.storage.local.get(PERSIST_KEY, (result) => {
          const snap = result && result[PERSIST_KEY];
          if (snap && typeof snap === 'object') {
            // Live data that raced ahead of storage wins over the snapshot.
            if (!usageSeen) {
              for (const k of ['session', 'weekly']) {
                const b = snap[k];
                if (!b) continue;
                meterState[k] = windowHasReset(b)
                  ? { utilization: 0, percent: 0 }
                  : { ...meterState[k], ...b };
              }
            }
            // Context belongs to one chat; don't show it on another.
            if (
              !contextSeen &&
              snap.context &&
              conversationId &&
              snap.conversationId === conversationId
            ) {
              meterState.context = { ...meterState.context, ...snap.context };
            }
            if (snap.orgId && !lastOrgId) lastOrgId = snap.orgId;
            meterState.updatedAt = Date.now();
          }
          done();
        });
      } catch (_) {
        done();
      }
    });
  }

  let persistTimer = 0;
  let lastPersisted = '';
  function persistUsageSnapshot() {
    if (!hydrateComplete || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      const snapshot = {
        session: meterState.session,
        weekly: meterState.weekly,
        context: meterState.context,
        conversationId,
        orgId: lastOrgId || null,
      };
      const json = JSON.stringify(snapshot);
      if (json === lastPersisted) return;
      lastPersisted = json;
      try {
        chrome.storage.local.set({ [PERSIST_KEY]: { ...snapshot, updatedAt: Date.now() } });
      } catch (_) {}
    }, PERSIST_DEBOUNCE_MS);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (enabled) remountOverlayIfNeeded();
      }
      if (changes.showCache) {
        showCache = changes.showCache.newValue === true;
        pushStateToOverlay();
      }
    });
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // State -> overlay

  function stateForUi() {
    const out = { ...meterState };
    if (!showCache) delete out.cache;
    const sp = Number(out.session && out.session.percent);
    const wp = Number(out.weekly && out.weekly.percent);
    out.session = {
      ...(out.session || {}),
      percent: Number.isFinite(sp) ? sp : 0,
      utilization: Number(out.session && out.session.utilization) || 0,
    };
    out.weekly = {
      ...(out.weekly || {}),
      percent: Number.isFinite(wp) ? wp : 0,
      utilization: Number(out.weekly && out.weekly.utilization) || 0,
    };
    // Collapsed pill: session+weekly bars (not context %). Redline chip layout.
    out.chip = { sessionPercent: out.session.percent, weeklyPercent: out.weekly.percent };
    return out;
  }

  // Several setState calls in one task (e.g. a burst of SSE events) paint once.
  let pushQueued = false;
  function pushStateToOverlay() {
    if (!enabled || pushQueued) return;
    pushQueued = true;
    queueMicrotask(() => {
      pushQueued = false;
      if (!enabled) return;
      const state = stateForUi();
      const api = window.__SHIPHOOK_METER__;
      if (api && typeof api.setState === 'function') {
        api.setState(state);
        return;
      }
      const host = document.getElementById(HOST_ID);
      if (host) {
        try {
          host.dispatchEvent(new CustomEvent('shiphook-meter:update', { detail: state }));
        } catch (_) {}
      }
    });
  }

  function remountOverlayIfNeeded() {
    if (!enabled) return;
    try {
      if (typeof globalThis.__SHIPHOOK_METER_MOUNT__ === 'function') {
        globalThis.__SHIPHOOK_METER_MOUNT__();
      }
    } catch (_) {}
    pushStateToOverlay();
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
    if (partial.session || partial.weekly || partial.context) persistUsageSnapshot();
    pushStateToOverlay();
  }

  function mergeBreakdown(prev, next) {
    if (!next) return prev;
    const out = { ...prev };
    for (const k of ['tool_call', 'web_search', 'other']) {
      if (next[k]) out[k] = { ...prev[k], ...next[k] };
    }
    return out;
  }

  function hasUsageBars(state) {
    const sp = state && state.session && state.session.percent;
    const wp = state && state.weekly && state.weekly.percent;
    return (sp != null && sp > 0) || (wp != null && wp > 0);
  }

  // A 0% reading while the window is still open is almost always a partial
  // payload (model flip, remount), so keep the prior value. After resetsAt
  // passes, 0% is real and wins.
  function mergeUsageBucket(existing, incoming) {
    if (!incoming) return existing;
    const prior = Number(existing && existing.percent) || 0;
    const next = Number(incoming.percent) || 0;
    if (next <= 0 && prior > 0 && !windowHasReset(existing)) return existing;
    return incoming;
  }

  function mergeContextKeep(existing, incoming) {
    if (!incoming) return existing;
    const priorTok = Number(existing && existing.tokensApprox) || 0;
    const incomingTok = Number(incoming && incoming.tokensApprox) || 0;
    if (incomingTok <= 0 && priorTok > 0) return existing;
    return incoming;
  }

  // ---------------------------------------------------------------------------
  // Messages from the MAIN-world hook

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;
    switch (msg.type) {
      case 'ready':
        scheduleUsagePoll();
        return;
      case 'org': {
        const orgId = msg.payload && msg.payload.orgId;
        if (orgId && String(orgId) !== lastOrgId) {
          lastOrgId = String(orgId);
          persistUsageSnapshot();
          requestUsageFetch(true);
        }
        scheduleUsagePoll();
        return;
      }
      case 'url':
        onUrlChange();
        return;
      case 'usage':
        handleUsagePayload(msg.payload);
        return;
      case 'sse':
        handleSsePayload(msg.payload);
        return;
    }
  });

  function handleUsagePayload(payload) {
    if (!payload) return;
    const kind = payload.kind;
    if (kind === 'fetch_error') {
      setState({
        status: hasUsageBars(meterState) ? 'ok' : 'waiting',
        error: payload.error || (payload.status ? 'usage_http_' + payload.status : 'usage_fetch_error'),
      });
      return;
    }
    if (kind !== 'message_limit' && kind !== 'polled' && kind !== 'json') return;
    const normalized = normalizeUsageInline(payload.data);
    if (!normalized) return;
    if (normalized.empty) {
      setState({ status: hasUsageBars(meterState) ? 'ok' : 'waiting', error: undefined });
      return;
    }
    usageSeen = true;
    setState({
      session: mergeUsageBucket(meterState.session, normalized.session),
      weekly: mergeUsageBucket(meterState.weekly, normalized.weekly),
      status: 'ok',
      error: undefined,
    });
  }

  function handleSsePayload(payload) {
    if (!payload) return;
    if (payload.kind === 'tool') {
      const key = payload.toolKind === 'web_search' ? 'web_search' : 'tool_call';
      const prev = meterState.breakdown[key] || emptyBucket();
      setState({
        breakdown: {
          [key]: {
            count: prev.count + 1,
            tokensApprox: (prev.tokensApprox || 0) + Math.ceil((payload.approxChars || 0) / 4),
          },
        },
        status: 'ok',
      });
      return;
    }
    if (payload.kind === 'conversation_summary' && payload.data) {
      applyConversationSummary(payload.data);
    }
  }

  function applyConversationSummary(sum) {
    // A slow response for a chat we already left must not overwrite this one.
    if (sum.conversationId && conversationId && sum.conversationId !== conversationId) return;
    clearTimeout(treeFallbackTimer);
    contextSeen = true;

    const toTokens = (chars) => Math.ceil((Number(chars) || 0) / 4);
    const breakdown = emptyBreakdown();
    for (const k of Object.keys(breakdown)) {
      const b = sum.breakdown && sum.breakdown[k];
      if (b) breakdown[k] = { count: Number(b.count) || 0, tokensApprox: toTokens(b.chars) };
    }
    const model = sum.model || meterState.model;
    const limit = resolveLimit(model, meterState.context.limit);
    const tokensApprox = toTokens(sum.totalChars);
    const percent = limit > 0 ? Math.min(100, (tokensApprox / limit) * 100) : 0;

    const patch = {
      model,
      context: mergeContextKeep(meterState.context, { tokensApprox, limit, percent }),
      breakdown,
      status: 'ok',
    };
    if (sum.lastAssistantTs) {
      const expiresAt = sum.lastAssistantTs + CACHE_TTL_MS;
      patch.cache = expiresAt > Date.now() ? { expiresAt } : undefined;
    }
    setState(patch);
  }

  function resolveLimit(model, fallback) {
    if (!model) return fallback || DEFAULT_LIMIT;
    const s = String(model).toLowerCase();
    if (/\b1m\b|1000000/.test(s)) return 1000000;
    if (/\b500k\b|500000/.test(s)) return 500000;
    if (/\b200k\b|200000/.test(s)) return 200000;
    return fallback || DEFAULT_LIMIT;
  }

  // ---------------------------------------------------------------------------
  // Usage normalization (undocumented Claude.ai shapes; fail soft)

  function normalizeUsageInline(apiJson) {
    if (apiJson == null) return { empty: true };
    if (typeof apiJson !== 'object') return null;

    function num(...vals) {
      for (const v of vals) {
        if (v == null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    function present(...vals) {
      for (const v of vals) {
        if (v != null && v !== '') return v;
      }
      return null;
    }

    // Claude usage windows may send utilization as 0-1 OR 0-100.
    // Values >1 are treated as percent-used (e.g. 7 → 0.07). Never Math.min(1,7)=1.
    function normalizeUtilFraction(raw) {
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return null;
      return n > 1 ? Math.min(1, n / 100) : n;
    }

    function bucket(b) {
      if (!b || typeof b !== 'object') return null;
      // Prefer explicit used/limit; then remaining*; then utilization/util; then percent.
      let util = null;
      const used = num(b.used, b.usage, b.consumed, b.used_percent, b.usedPercent);
      const limit = num(b.limit, b.max, b.quota);
      if (used != null && limit) util = used / limit;
      else if (used != null && used > 1) util = used / 100; // used already in percent units
      else if (used != null) util = used;
      if (util == null) {
        const rem = num(
          b.remaining,
          b.remaining_fraction,
          b.remainingFraction,
          b.percent_remaining,
          b.percentRemaining
        );
        if (rem != null) util = 1 - Math.min(1, Math.max(0, rem > 1 ? rem / 100 : rem));
      }
      if (util == null) util = normalizeUtilFraction(present(b.utilization, b.util));
      if (util == null && b.percent != null) util = normalizeUtilFraction(b.percent);

      // Store an absolute reset time so the countdown stays right after a
      // reload instead of freezing at the seconds value we saw back then.
      let resetsAt = toMs(present(b.resets_at, b.resetsAt, b.reset_at, b.resetAt, b.resets));
      if (resetsAt == null) {
        const secs = num(b.resets_in_seconds, b.resetsInSec, b.resets_in_sec, b.seconds_remaining);
        if (secs != null) resetsAt = Date.now() + secs * 1000;
      }
      const reset = resetsAt != null ? { resetsAt } : {};

      if (util == null) {
        return resetsAt == null ? null : { utilization: 0, percent: 0, ...reset };
      }
      const clamped = Math.min(1, Math.max(0, util));
      // Prefer explicit percent if it is on 0-100 used scale; invert if it names "remaining".
      let pct = null;
      const rawPct = num(b.percent, b.used_percent, b.usedPercent);
      if (rawPct != null) {
        const type = String(present(b.percent_type, b.percentType) || '').toLowerCase();
        const as100 = rawPct > 1 ? rawPct : rawPct * 100;
        pct = type.includes('remain') ? 100 - Math.min(100, Math.max(0, as100)) : Math.min(100, as100);
      }
      if (pct == null) pct = clamped * 100;
      return { utilization: clamped, percent: Math.min(100, Math.max(0, pct)), ...reset };
    }

    const root = apiJson.message_limit || apiJson.messageLimit || apiJson;
    const windows = (root && root.windows) || apiJson.windows || null;
    const sessionSrc =
      (windows && (windows['5h'] || windows['5H'] || windows.session)) ||
      root.five_hour || root.fiveHour || root.session || root.rate_limit_0 ||
      apiJson.five_hour || apiJson.session;
    const weeklySrc =
      (windows && (windows['7d'] || windows['7D'] || windows.weekly)) ||
      root.seven_day || root.sevenDay || root.weekly || root.rate_limit_1 ||
      apiJson.seven_day || apiJson.weekly;

    const s = bucket(sessionSrc);
    const w = bucket(weeklySrc);
    if (!s && !w) {
      const flat = bucket(root);
      return flat ? { session: flat, weekly: null } : { empty: true };
    }
    return { session: s, weekly: w };
  }

  // ---------------------------------------------------------------------------
  // Polling + requests (all network goes through the MAIN-world hook)

  function readLastActiveOrg() {
    try {
      for (const c of document.cookie.split(';')) {
        const [k, ...rest] = c.trim().split('=');
        if (k === 'lastActiveOrg' || k === 'lastActiveOrganization') {
          return decodeURIComponent(rest.join('='));
        }
      }
    } catch (_) {}
    try {
      return localStorage.getItem('lastActiveOrg') || localStorage.getItem('lastActiveOrganization');
    } catch (_) {}
    return null;
  }

  let pollTimer = 0;
  function scheduleUsagePoll() {
    if (pollTimer) return;
    const tick = () => {
      // Hidden tabs don't poll; visibilitychange catches them up.
      if (!document.hidden) requestUsageFetch();
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, 2_000);
  }

  let lastUsageRequestAt = 0;
  function requestUsageFetch(force) {
    const org = lastOrgId || readLastActiveOrg();
    if (!org) return;
    const now = Date.now();
    if (!force && now - lastUsageRequestAt < USAGE_MIN_GAP_MS) return;
    lastUsageRequestAt = now;
    window.postMessage(
      {
        source: SOURCE,
        type: 'request_usage_fetch',
        payload: { url: API_BASE + encodeURIComponent(org) + '/usage' },
      },
      '*'
    );
  }

  function requestConversationTree(id) {
    const org = lastOrgId || readLastActiveOrg();
    if (!id || !org) return;
    const url = API_BASE + encodeURIComponent(org) + '/chat_conversations/' + encodeURIComponent(id);
    window.postMessage({ source: SOURCE, type: 'request_usage_fetch', payload: { url, tree: true } }, '*');
  }

  let treeFallbackTimer = 0;
  function onUrlChange() {
    const href = location.href;
    if (href === lastHref) return;
    lastHref = href;
    const nextId = extractConversationId(href);
    if (nextId !== conversationId) {
      conversationId = nextId;
      contextSeen = false;
      setState({
        context: { tokensApprox: 0, limit: meterState.context.limit || DEFAULT_LIMIT, percent: 0 },
        breakdown: emptyBreakdown(),
        cache: undefined,
      });
    }
    clearTimeout(treeFallbackTimer);
    if (nextId) {
      // Same chat (e.g. model flip) or a new one: re-read the tree unless
      // Claude's own load hands it to us first.
      treeFallbackTimer = setTimeout(() => requestConversationTree(nextId), TREE_FALLBACK_MS);
    }
    requestUsageFetch();
  }

  // ---------------------------------------------------------------------------
  // Boot

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) requestUsageFetch();
  });

  async function boot() {
    await Promise.all([readPrefs(), hydrateUsageSnapshot()]);
    remountOverlayIfNeeded();
    requestUsageFetch(true);
    scheduleUsagePoll();
    // Catch-all for a hook that loaded after us, and an initial tree if Claude
    // already loaded it before our listener could see it.
    window.postMessage({ source: SOURCE, type: 'request_ready' }, '*');
    if (conversationId && !contextSeen) {
      treeFallbackTimer = setTimeout(() => {
        if (!contextSeen) requestConversationTree(conversationId);
      }, TREE_FALLBACK_MS);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
  } else {
    boot();
  }
})();
