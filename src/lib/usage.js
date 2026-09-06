/**
 * Shiphook Claude Meter — usage / message_limit parsing.
 * Versioned adapters for undocumented Claude.ai field names.
 * Free plan REST may return null until after a reply — fail soft.
 */

/** Adapter registry — bump when spike finds new shapes. */
export const USAGE_ADAPTER_VERSION = 2;

/**
 * @param {any} payload
 * @returns {{
 *   session?: ReturnType<typeof normalizeBucket>,
 *   weekly?: ReturnType<typeof normalizeBucket>,
 *   raw?: any,
 *   empty?: boolean
 * } | null}
 */
export function parseMessageLimit(payload) {
  // Free plan / pre-reply: REST null → empty state
  if (payload == null) {
    return { empty: true, raw: null };
  }
  if (typeof payload !== 'object') return null;

  const root =
    payload.message_limit ||
    payload.messageLimit ||
    (payload.type === 'message_limit' ? payload : null) ||
    payload.data ||
    payload;

  if (root == null) {
    return { empty: true, raw: payload };
  }
  if (typeof root !== 'object') return null;

  // 2026-08 live shape: message_limit.windows["5h"|"7d"]
  const windows = root.windows || payload.windows || null;
  const sessionFromWindows =
    windows && typeof windows === 'object'
      ? normalizeBucket(windows['5h'] || windows['5H'] || windows.session)
      : null;
  const weeklyFromWindows =
    windows && typeof windows === 'object'
      ? normalizeBucket(windows['7d'] || windows['7D'] || windows.weekly)
      : null;

  const session =
    sessionFromWindows ||
    normalizeBucket(
      pickFirst(root, [
        'session',
        'five_hour',
        'fiveHour',
        'five_hour_util',
        'rate_limit_0',
        'short',
      ])
    ) ||
    undefined;

  const weekly =
    weeklyFromWindows ||
    normalizeBucket(
      pickFirst(root, [
        'weekly',
        'seven_day',
        'sevenDay',
        'seven_day_util',
        'rate_limit_1',
        'long',
        'week',
      ])
    ) ||
    undefined;

  const single = normalizeBucket(root);
  if (!session && !weekly && single) {
    return { session: single, raw: payload };
  }

  if (!session && !weekly) {
    return { empty: true, raw: payload };
  }

  return {
    session: session || undefined,
    weekly: weekly || undefined,
    raw: payload,
  };
}

/**
 * Normalize API usage JSON → session/weekly MeterState shape.
 * Handles GET /api/organizations/{org}/usage and SSE message_limit.
 * @param {any} apiJson
 * @returns {{
 *   session: { utilization: number, percent: number, resetsAt?: string|number, resetsInSec?: number },
 *   weekly: { utilization: number, percent: number, resetsAt?: string|number, resetsInSec?: number },
 *   empty?: boolean
 * }}
 */
export function normalizeUsage(apiJson) {
  const emptyBucket = () => ({ utilization: 0, percent: 0 });
  const result = {
    session: emptyBucket(),
    weekly: emptyBucket(),
  };

  if (apiJson == null) {
    result.empty = true;
    return result;
  }
  if (typeof apiJson !== 'object') return result;

  const parsed = parseMessageLimit(apiJson);
  if (parsed && parsed.empty && !parsed.session && !parsed.weekly) {
    result.empty = true;
    return result;
  }

  const windows =
    (apiJson.message_limit && apiJson.message_limit.windows) ||
    apiJson.windows ||
    null;

  const sessionSrc =
    (parsed && parsed.session) ||
    (windows && (windows['5h'] || windows['5H'])) ||
    pickFirst(apiJson, [
      'five_hour',
      'fiveHour',
      'session',
      'rate_limit_0',
    ]) ||
    null;

  const weeklySrc =
    (parsed && parsed.weekly) ||
    (windows && (windows['7d'] || windows['7D'])) ||
    pickFirst(apiJson, [
      'seven_day',
      'sevenDay',
      'weekly',
      'rate_limit_1',
    ]) ||
    null;

  if (sessionSrc && typeof sessionSrc === 'object') {
    const n = normalizeBucket(sessionSrc);
    if (n) result.session = n;
  }
  if (weeklySrc && typeof weeklySrc === 'object') {
    const n = normalizeBucket(weeklySrc);
    if (n) result.weekly = n;
  }

  // Flat utilization on root (single bucket)
  if (
    !sessionSrc &&
    (apiJson.utilization != null || apiJson.used != null)
  ) {
    const n = normalizeBucket(apiJson);
    if (n) result.session = n;
  }

  return result;
}

/**
 * Parse resets_at: unix seconds (< 1e12) → ms epoch number; else keep ISO/string.
 * Also derive resetsInSec from now when possible.
 * @param {any} raw
 * @returns {{ resetsAt?: string|number, resetsInSec?: number }}
 */
export function normalizeResetsAt(raw) {
  const out = {};
  if (raw == null || raw === '') return out;

  let ms = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    ms = raw < 1e12 ? raw * 1000 : raw;
    out.resetsAt = ms;
  } else {
    const s = String(raw).trim();
    if (!s) return out;
    const asNum = Number(s);
    if (!Number.isNaN(asNum) && Number.isFinite(asNum) && /^\d+(\.\d+)?$/.test(s)) {
      ms = asNum < 1e12 ? asNum * 1000 : asNum;
      out.resetsAt = ms;
    } else {
      const parsed = Date.parse(s);
      if (!Number.isNaN(parsed)) {
        ms = parsed;
        out.resetsAt = s; // keep ISO string when provided as string
      } else {
        out.resetsAt = s;
      }
    }
  }

  if (ms != null) {
    const sec = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    out.resetsInSec = sec;
  }
  return out;
}

/**
 * @param {any} bucket
 * @returns {{ utilization: number, percent: number, resetsAt?: string|number, resetsInSec?: number } | null}
 */
export function normalizeBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;

  const utilization = firstNumber(
    bucket.utilization,
    bucket.util,
    fractionFromUsedLimit(bucket),
    bucket.percent != null ? Number(bucket.percent) / 100 : null,
    bucket.pct != null ? Number(bucket.pct) / 100 : null
  );

  const rawResets = firstPresent(
    bucket.resets_at,
    bucket.resetsAt,
    bucket.reset_at,
    bucket.resetAt,
    bucket.resets
  );
  const resetInfo = normalizeResetsAt(rawResets);

  let resetsInSec = firstNumber(
    bucket.resets_in_seconds,
    bucket.resetsInSec,
    bucket.resets_in_sec,
    bucket.seconds_remaining,
    bucket.remaining_seconds
  );
  if (resetsInSec == null && resetInfo.resetsInSec != null) {
    resetsInSec = resetInfo.resetsInSec;
  }

  if (utilization == null || Number.isNaN(utilization)) {
    if (resetInfo.resetsAt == null && resetsInSec == null) return null;
    return {
      utilization: 0,
      percent: 0,
      ...(resetInfo.resetsAt != null ? { resetsAt: resetInfo.resetsAt } : {}),
      ...(resetsInSec != null ? { resetsInSec: Number(resetsInSec) } : {}),
    };
  }

  const clamped = Math.min(1, Math.max(0, Number(utilization)));
  const percent =
    firstNumber(bucket.percent, bucket.pct, clamped * 100) ?? clamped * 100;

  const out = {
    utilization: clamped,
    percent: Math.min(100, Math.max(0, Number(percent))),
  };
  if (resetInfo.resetsAt != null) out.resetsAt = resetInfo.resetsAt;
  if (resetsInSec != null) out.resetsInSec = Number(resetsInSec);
  return out;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return null;
}

function firstPresent(...vals) {
  for (const v of vals) {
    if (v != null && v !== '') return v;
  }
  return null;
}

function fractionFromUsedLimit(bucket) {
  const used = firstNumber(bucket.used, bucket.usage, bucket.consumed);
  const limit = firstNumber(bucket.limit, bucket.max, bucket.quota, bucket.cap);
  if (used == null || limit == null || limit === 0) return null;
  return used / limit;
}

function firstNumber(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}
