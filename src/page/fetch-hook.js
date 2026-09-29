/**
 * Shiphook Claude Meter — MAIN-world fetch hook (MIT, clean-room).
 * URL patterns inspired by she-llac/claude-counter (MIT) + lugia path shape (GPL — patterns only).
 * Posts to ISOLATED content via postMessage. Does not copy third-party source.
 *
 * Conversation trees are summarized here (a few numbers) instead of posting the
 * full JSON across worlds: structured-cloning a multi-MB tree is the single most
 * expensive thing this extension could do on the main thread.
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';
  const API_ORIGIN = 'https://claude.ai';
  const TREE_PARAMS = 'tree=true&rendering_mode=messages&render_all_tools=true';

  // she-llac-style: /api/organizations/<org>/chat_conversations/<convo>
  const ORG_CONVO_RE =
    /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?#]+)/i;
  // lugia/she-llac completion path shape
  const COMPLETION_RE = /\/chat_conversations\/[^/]+\/(retry_)?completion\b/i;
  const CHAT_CONVERSATIONS_RE = /\/chat_conversations\//i;
  const ORG_ONLY_RE = /\/api\/organizations\/([a-f0-9-]{36})\//i;
  const USAGE_RE = /\/api\/organizations\/[^/]+\/usage\b/i;

  let lastOrgId = null;

  function post(type, payload) {
    try {
      const msg = { source: SOURCE, type };
      if (payload !== undefined) msg.payload = payload;
      window.postMessage(msg, '*');
    } catch (_) {}
  }

  function noteOrg(orgId) {
    if (!orgId || orgId === lastOrgId) return;
    lastOrgId = orgId;
    post('org', { orgId });
  }

  function parseOrgConvo(url) {
    const m = ORG_CONVO_RE.exec(url);
    if (m) {
      noteOrg(m[1]);
      return { orgId: m[1], convoId: m[2] };
    }
    const o = ORG_ONLY_RE.exec(url);
    if (o) noteOrg(o[1]);
    return null;
  }

  function requestUrl(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
    return url.startsWith('/') ? API_ORIGIN + url : url;
  }

  // ---------------------------------------------------------------------------
  // Conversation summary (context + breakdown), computed where the JSON lives.

  function emptyBucket() {
    return { count: 0, chars: 0 };
  }

  function classify(b) {
    if (!b || typeof b !== 'object') return 'other';
    const type = String(b.type || '').toLowerCase();
    // Earlier-turn thinking is stripped from the prompt, so it takes no context.
    if (type === 'thinking' || type === 'redacted_thinking') return null;
    const name = String(b.name || b.tool_name || '').toLowerCase();
    if (name.includes('web_search') || type.includes('web_search')) return 'web_search';
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

  // Count what reaches the model (text, tool input, tool output), not UI metadata.
  function blockChars(b) {
    if (b == null) return 0;
    if (typeof b === 'string') return b.length;
    if (typeof b.text === 'string') return b.text.length;
    if (typeof b.content === 'string') return b.content.length;
    if (Array.isArray(b.content)) {
      let n = 0;
      for (const c of b.content) n += blockChars(c);
      return n;
    }
    if (b.input != null) {
      if (typeof b.input === 'string') return b.input.length;
      try {
        return JSON.stringify(b.input).length;
      } catch (_) {
        return 0;
      }
    }
    try {
      return JSON.stringify(b).length;
    } catch (_) {
      return 0;
    }
  }

  function activeBranch(tree, messages) {
    const leafId = tree.current_leaf_message_uuid || tree.currentLeafMessageUuid;
    if (!leafId) return messages;
    const byUuid = new Map();
    for (const msg of messages) {
      const id = msg && (msg.uuid || msg.id);
      if (id) byUuid.set(String(id), msg);
    }
    let cur = byUuid.get(String(leafId));
    if (!cur) return messages;
    const trunk = [];
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      trunk.push(cur);
      const parentId = cur.parent_message_uuid || cur.parentMessageUuid;
      cur = parentId ? byUuid.get(String(parentId)) : null;
    }
    return trunk.reverse();
  }

  function summarizeConversation(tree, url) {
    if (!tree || typeof tree !== 'object') return null;
    const messages =
      tree.chat_messages ||
      tree.messages ||
      (tree.conversation && tree.conversation.chat_messages);
    if (!Array.isArray(messages)) return null;

    const breakdown = {
      tool_call: emptyBucket(),
      web_search: emptyBucket(),
      other: emptyBucket(),
    };
    let totalChars = 0;
    let lastAssistantTs = 0;

    for (const msg of activeBranch(tree, messages)) {
      if (!msg) continue;
      const content = msg.content || msg.contents || [];
      const blocks = Array.isArray(content)
        ? content
        : typeof content === 'string'
          ? [content]
          : [];
      for (const b of blocks) {
        const key = classify(b);
        if (!key) continue;
        const n = blockChars(b);
        totalChars += n;
        breakdown[key].count += 1;
        breakdown[key].chars += n;
      }
      // Pasted/uploaded text lands in attachments, not content, but still fills context.
      if (Array.isArray(msg.attachments)) {
        for (const a of msg.attachments) {
          const text = a && a.extracted_content;
          if (typeof text !== 'string' || !text) continue;
          totalChars += text.length;
          breakdown.other.count += 1;
          breakdown.other.chars += text.length;
        }
      }
      const role = String(msg.role || msg.sender || '').toLowerCase();
      if (role === 'assistant' || role === 'bot') {
        const ts = Date.parse(msg.created_at || msg.updated_at || '');
        if (ts > lastAssistantTs) lastAssistantTs = ts;
      }
    }

    const m = ORG_CONVO_RE.exec(url || '');
    return {
      conversationId: String(tree.uuid || (m && m[2]) || '') || null,
      model:
        tree.model ||
        tree.chat_model ||
        (tree.conversation && tree.conversation.model) ||
        null,
      totalChars,
      breakdown,
      lastAssistantTs: lastAssistantTs || null,
    };
  }

  function postConversation(json, url) {
    const summary = summarizeConversation(json, url);
    if (summary) post('sse', { kind: 'conversation_summary', data: summary });
    return !!summary;
  }

  function hasUsageShape(json) {
    return !!(
      json &&
      (json.message_limit ||
        json.messageLimit ||
        json.windows ||
        json.five_hour ||
        json.seven_day)
    );
  }

  // ---------------------------------------------------------------------------
  // SPA navigation. Patching history has to happen in the MAIN world: an
  // isolated-world patch never sees the page's own pushState calls.

  function postUrl() {
    post('url', { href: location.href });
  }

  for (const fn of ['pushState', 'replaceState']) {
    const original = history[fn];
    if (typeof original !== 'function') continue;
    history[fn] = function (...args) {
      const before = location.href;
      const result = original.apply(this, args);
      if (location.href !== before) postUrl();
      return result;
    };
  }
  window.addEventListener('popstate', postUrl);

  // ---------------------------------------------------------------------------
  // Messages from the ISOLATED content script.

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === 'request_ready') {
      post('ready');
      if (lastOrgId) post('org', { orgId: lastOrgId });
      return;
    }

    if (msg.type === 'request_usage_fetch') {
      const url = msg.payload && msg.payload.url;
      if (!url) return;
      fetchUsage(url, !!(msg.payload && msg.payload.tree));
    }
  });

  // ---------------------------------------------------------------------------
  // fetch hook

  const originalFetch = window.fetch;
  window.fetch = function hookFetch(input, init) {
    const url = requestUrl(input);
    parseOrgConvo(url);

    const req = originalFetch.call(this, input, init);

    if (COMPLETION_RE.test(url)) {
      return req.then((res) => observeStream(res, url, true));
    }
    if (CHAT_CONVERSATIONS_RE.test(url) || USAGE_RE.test(url)) {
      return req.then((res) => observeJson(res, url));
    }
    // Fallback: any other claude.ai/api event-stream
    if (url.startsWith(API_ORIGIN + '/api/')) {
      return req.then((res) => observeStream(res, url, false));
    }
    return req;
  };

  // clone() keeps the page's Response untouched (url, redirected, type) while we
  // read a copy of the body.
  function observeStream(response, url, isCompletion) {
    if (!response || !response.ok || !response.body) return response;
    const ct = response.headers.get('content-type') || '';
    const isSse = ct.includes('text/event-stream');
    if (!isSse && !(isCompletion && (!ct || ct.includes('text/plain')))) {
      return response;
    }
    try {
      parseSSE(response.clone().body, isCompletion ? url : null);
    } catch (_) {}
    return response;
  }

  function observeJson(response, url) {
    if (!response || !response.ok || !response.body) return response;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return response;
    response
      .clone()
      .json()
      .then((json) => {
        postConversation(json, url);
        if (hasUsageShape(json)) post('usage', { kind: 'json', data: json });
      })
      .catch(() => {});
    return response;
  }

  async function parseSSE(stream, completionUrl) {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          // Nearly every event is a text delta. Skip JSON.parse unless the
          // line can hold something we read.
          if (
            !line.includes('message_limit') &&
            !line.includes('"content_block_start"')
          ) {
            continue;
          }
          try {
            handleSSEEvent(JSON.parse(line.slice(5).trim()));
          } catch (_) {}
        }
      }
    } catch (_) {
    } finally {
      if (completionUrl) {
        try {
          await refreshAfterStream(completionUrl);
        } catch (_) {}
      }
    }
  }

  function handleSSEEvent(json) {
    if (!json || typeof json !== 'object') return;

    // she-llac: json.type === 'message_limit' && json.message_limit
    if (json.type === 'message_limit' && json.message_limit) {
      post('usage', { kind: 'message_limit', data: json.message_limit });
    } else if (
      json.type === 'message_limit' &&
      (json.windows || json.five_hour || json.seven_day)
    ) {
      // windows on event root
      post('usage', { kind: 'message_limit', data: json });
    } else if (json.message_limit && typeof json.message_limit === 'object') {
      post('usage', { kind: 'message_limit', data: json.message_limit });
    }

    if (json.type === 'content_block_start' && json.content_block) {
      const block = json.content_block;
      if (block.type === 'tool_use' || block.type === 'web_search') {
        const toolKind = block.type === 'web_search' ? 'web_search' : 'tool_call';
        const text =
          (block.input && JSON.stringify(block.input)) ||
          (typeof block.text === 'string' ? block.text : '');
        post('sse', { kind: 'tool', toolKind, approxChars: text.length });
      }
    }
  }

  // After a reply: pull the tree (context) and usage in parallel.
  async function refreshAfterStream(completionUrl) {
    const ids = parseOrgConvo(completionUrl);
    const orgId = (ids && ids.orgId) || lastOrgId;
    if (!orgId) return;
    const base = API_ORIGIN + '/api/organizations/' + orgId;
    const jobs = [getJson(base + '/usage').then((uj) => {
      if (uj !== undefined) post('usage', { kind: 'polled', data: uj });
    })];
    if (ids && ids.convoId) {
      jobs.push(
        getJson(base + '/chat_conversations/' + ids.convoId + '?' + TREE_PARAMS).then(
          (tree) => {
            if (tree) postConversation(tree, completionUrl);
          }
        )
      );
    }
    await Promise.all(jobs.map((p) => p.catch(() => {})));
  }

  async function getJson(url) {
    const res = await originalFetch.call(window, url, {
      method: 'GET',
      credentials: 'include',
    });
    if (!res.ok) return undefined;
    return res.json();
  }

  async function fetchUsage(url, includeTree) {
    try {
      let fetchUrl = url;
      if (includeTree && !/[?&]tree=/i.test(url)) {
        fetchUrl += (url.includes('?') ? '&' : '?') + TREE_PARAMS;
      }
      const res = await originalFetch.call(window, fetchUrl, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        post('usage', { kind: 'fetch_error', status: res.status });
        return;
      }
      const json = await res.json();
      if (!postConversation(json, fetchUrl)) {
        post('usage', { kind: 'polled', data: json });
      }
    } catch (err) {
      post('usage', {
        kind: 'fetch_error',
        error: err && err.message ? err.message : 'fetch_error',
      });
    }
  }

  post('ready');
})();
