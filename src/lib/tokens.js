/**
 * Shiphook Claude Meter — lightweight token heuristics + model-aware limits.
 * ~4 chars/token is a rough English/code average.
 * A proper o200k_base tokenizer would be more accurate but heavier;
 * keep this lean for content-script / page use. Label UI as "approx".
 */

/**
 * Model-aware context window limits (Help Center / paid plans cite 200k / 500k / 1M).
 * Do NOT hardcode only 200k. Extend as Claude ships new windows.
 * Keys are lowercase substrings matched against model display/id strings.
 */
export const MODEL_CONTEXT_LIMITS = {
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku': 200000,
  'claude-3-opus': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-7-sonnet': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  '1m': 1000000,
  '500k': 500000,
  '200k': 200000,
};

/** Default when model unknown — conservative common paid window */
export const DEFAULT_CONTEXT_LIMIT = 200000;

/**
 * Resolve context token limit from a model id / display name / hint.
 * @param {string|undefined|null} model
 * @param {number|undefined|null} explicitLimit — from API if present
 * @returns {number}
 */
export function resolveContextLimit(model, explicitLimit) {
  if (explicitLimit != null && Number(explicitLimit) > 0) {
    return Number(explicitLimit);
  }
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  const s = String(model).toLowerCase();

  if (/\b1m\b|1_000_000|1000000/.test(s)) return 1000000;
  if (/\b500k\b|500_000|500000/.test(s)) return 500000;
  if (/\b200k\b|200_000|200000/.test(s)) return 200000;

  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (s.includes(String(key).toLowerCase())) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  // Heuristic: ~4 characters per token (comment: o200k would be better)
  return Math.max(0, Math.ceil(s.length / 4));
}

/**
 * Classify content blocks into tool_call / web_search / other.
 * Web search = named tool_use (name includes web_search), per PRD.
 * @param {Array<object|string>} blocks
 * @returns {{
 *   tool_call: { count: number, tokensApprox: number },
 *   web_search: { count: number, tokensApprox: number },
 *   other: { count: number, tokensApprox: number }
 * }}
 */
export function classifyBreakdown(blocks) {
  const empty = () => ({ count: 0, tokensApprox: 0 });
  const out = {
    tool_call: empty(),
    web_search: empty(),
    other: empty(),
  };

  if (!Array.isArray(blocks)) return out;

  for (const block of blocks) {
    const bucket = classifyOne(block);
    const text = blockToText(block);
    const tokens = estimateTokens(text);
    out[bucket].count += 1;
    out[bucket].tokensApprox += tokens;
  }

  return out;
}

function classifyOne(block) {
  if (!block || typeof block !== 'object') return 'other';
  const type = String(block.type || block.kind || '').toLowerCase();
  const name = String(block.name || block.tool_name || '').toLowerCase();

  // PRD: web_search = named tool_use
  if (
    name.includes('web_search') ||
    name.includes('web search') ||
    type.includes('web_search')
  ) {
    return 'web_search';
  }

  if (
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'tool_call' ||
    type === 'server_tool' ||
    type.includes('tool_use') ||
    type.includes('tool_call') ||
    type.includes('server_tool')
  ) {
    return 'tool_call';
  }

  return 'other';
}

function blockToText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map(blockToText).join('\n');
  }
  if (block.input != null) {
    try {
      return typeof block.input === 'string'
        ? block.input
        : JSON.stringify(block.input);
    } catch {
      /* fall through */
    }
  }
  try {
    return JSON.stringify(block);
  } catch {
    return '';
  }
}

/**
 * Walk conversation trunk: current_leaf_message_uuid → parent_message_uuid.
 * Collects text + tool_use / tool_result blocks along the active branch only.
 * @param {object} tree — chat_conversations payload (with messages / chat_messages)
 * @returns {Array<object>} ordered blocks root→leaf (approx)
 */
export function walkConversationTrunk(tree) {
  if (!tree || typeof tree !== 'object') return [];

  const messages =
    tree.chat_messages ||
    tree.messages ||
    (tree.conversation && tree.conversation.chat_messages) ||
    (tree.conversation && tree.conversation.messages) ||
    [];

  if (!Array.isArray(messages) || messages.length === 0) return [];

  const byUuid = new Map();
  for (const msg of messages) {
    const id = msg.uuid || msg.id || msg.message_uuid;
    if (id) byUuid.set(String(id), msg);
  }

  const leafId =
    tree.current_leaf_message_uuid ||
    tree.currentLeafMessageUuid ||
    (tree.conversation && tree.conversation.current_leaf_message_uuid) ||
    null;

  const trunk = [];
  if (leafId && byUuid.has(String(leafId))) {
    let cur = byUuid.get(String(leafId));
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      trunk.push(cur);
      const parentId =
        cur.parent_message_uuid || cur.parentMessageUuid || cur.parent_uuid;
      cur = parentId ? byUuid.get(String(parentId)) : null;
    }
    trunk.reverse(); // root → leaf
  } else {
    trunk.push(...messages);
  }

  const blocks = [];
  for (const msg of trunk) {
    const content = msg.content || msg.contents || [];
    if (typeof content === 'string') {
      blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) blocks.push(b);
    } else if (msg.text) {
      blocks.push({ type: 'text', text: String(msg.text) });
    }
  }
  return blocks;
}

/**
 * Build MeterState-partial from conversation tree (context + breakdown).
 * @param {object} tree
 * @param {{ model?: string, contextLimit?: number }} [opts]
 * @returns {{
 *   model?: string,
 *   context: { tokensApprox: number, limit: number, percent: number },
 *   breakdown: ReturnType<typeof classifyBreakdown>
 * }}
 */
export function buildMeterPartialFromTree(tree, opts) {
  const model =
    (opts && opts.model) ||
    (tree && tree.model) ||
    (tree && tree.chat_model) ||
    (tree && tree.conversation && tree.conversation.model) ||
    undefined;

  const limit = resolveContextLimit(
    model,
    opts && opts.contextLimit != null ? opts.contextLimit : null
  );

  const blocks = walkConversationTrunk(tree);
  const breakdown = classifyBreakdown(blocks);

  let tokensApprox = 0;
  for (const b of blocks) {
    tokensApprox += estimateTokens(blockToText(b));
  }

  const percent =
    limit > 0 ? Math.min(100, Math.max(0, (tokensApprox / limit) * 100)) : 0;

  return {
    ...(model ? { model } : {}),
    context: {
      tokensApprox,
      limit,
      percent,
    },
    breakdown,
  };
}

/**
 * Soft cache-timer heuristic (optional, do not block v1).
 * last assistant timestamp + ~5 minutes.
 * @param {object} tree
 * @param {number} [ttlMs=300000]
 * @returns {{ expiresAt: number, remainingMs: number } | null}
 */
export function estimateCacheTimer(tree, ttlMs) {
  const TTL = ttlMs != null ? ttlMs : 5 * 60 * 1000;
  const messages =
    (tree && (tree.chat_messages || tree.messages)) || [];
  if (!Array.isArray(messages) || !messages.length) return null;

  let lastAssistantTs = null;
  const leafId =
    tree.current_leaf_message_uuid || tree.currentLeafMessageUuid || null;
  const byUuid = new Map();
  for (const msg of messages) {
    const id = msg.uuid || msg.id;
    if (id) byUuid.set(String(id), msg);
  }

  const consider = [];
  if (leafId && byUuid.has(String(leafId))) {
    let cur = byUuid.get(String(leafId));
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      consider.push(cur);
      const parentId = cur.parent_message_uuid || cur.parentMessageUuid;
      cur = parentId ? byUuid.get(String(parentId)) : null;
    }
  } else {
    consider.push(...messages);
  }

  for (const msg of consider) {
    const role = String(msg.role || msg.sender || '').toLowerCase();
    if (role === 'assistant' || role === 'bot') {
      const ts =
        Date.parse(msg.created_at || msg.updated_at || msg.timestamp || '') ||
        null;
      if (ts && (lastAssistantTs == null || ts > lastAssistantTs)) {
        lastAssistantTs = ts;
      }
    }
  }

  if (lastAssistantTs == null) return null;
  const expiresAt = lastAssistantTs + TTL;
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return null;
  return { expiresAt, remainingMs };
}
