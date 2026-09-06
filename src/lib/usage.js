/**
 * Shiphook Claude Meter — usage / message_limit parsing.
 * Versioned adapters for undocumented Claude.ai field names.
 * Free plan REST may return null until after a reply — fail soft.
 */

/** Adapter registry — bump when spike finds new shapes. */
export const USAGE_ADAPTER_VERSION = 1;

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

  const session =
    normalizeBucket(
      pickFirst(root, [
        'session',
        'five_hour',
        'fiveHour',
        'five_hour_util',
        'rate_limit_0',
        'short',
      ])
    ) || undefined;

  const weekly =
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
    ) || undefined;

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
 *   session: { utilization: number, percent: number, resetsAt?: string, resetsInSec?: number },
 *   weekly: { utilization: number, percent: number, resetsAt?: string, resetsInSec?: number },
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

  const sessionSrc =
    (parsed && parsed.session) ||
    pickFirst(apiJson, [
      'five_hour',
      'fiveHour',
      'session',
      'rate_limit_0',
    ]) ||
    null;

  const weeklySrc =
    (parsed && parsed.weekly) ||
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
 * @param {any} bucket
 * @returns {{ utilization: number, percent: number, resetsAt?: string, resetsInSec?: number } | null}
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

  const resetsAt = firstString(
    bucket.resets_at,
    bucket.resetsAt,
    bucket.reset_at,
    bucket.resetAt,
    bucket.resets
  );
  const resetsInSec = firstNumber(
    bucket.resets_in_seconds,
    bucket.resetsInSec,
    bucket.resets_in_sec,
    bucket.seconds_remaining,
    bucket.remaining_seconds
  );

  if (utilization == null || Number.isNaN(utilization)) {
    if (resetsAt == null && resetsInSec == null) return null;
    return {
      utilization: 0,
      percent: 0,
      ...(resetsAt != null ? { resetsAt: String(resetsAt) } : {}),
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
  if (resetsAt != null) out.resetsAt = String(resetsAt);
  if (resetsInSec != null) out.resetsInSec = Number(resetsInSec);
  return out;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
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

function firstString(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v);
    if (s.length) return s;
  }
  return null;
}
