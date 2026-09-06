/**
 * Shiphook Claude Meter — MAIN-world fetch hook (MIT, clean-room).
 * URL patterns inspired by she-llac/claude-counter (MIT) + lugia path shape (GPL — patterns only).
 * Posts to ISOLATED content via postMessage. Does not copy third-party source.
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';

  // she-llac-style: https://claude.ai/api/organizations/<org>/chat_conversations/<convo>
  const ORG_CONVO_RE =
    /^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/i;

  // lugia/she-llac completion path shape
  const COMPLETION_RE =
    /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/(retry_)?completion\b/i;

  const CHAT_CONVERSATIONS_RE = /\/chat_conversations\//i;
  const ORG_ONLY_RE = /\/api\/organizations\/([a-f0-9-]{36})\//i;

  let lastOrgId = null;
  let lastConvoId = null;

  function post(type, payload) {
    try {
      const msg = { source: SOURCE, type };
      if (payload !== undefined) msg.payload = payload;
      window.postMessage(msg, '*');
    } catch (_) {}
  }

  function parseOrgConvo(url) {
    const m = ORG_CONVO_RE.exec(url);
    if (m) {
      lastOrgId = m[1];
      lastConvoId = m[2];
      post('org', { orgId: lastOrgId });
      return { orgId: m[1], convoId: m[2] };
    }
    const o = ORG_ONLY_RE.exec(url);
    if (o) {
      lastOrgId = o[1];
      post('org', { orgId: lastOrgId });
    }
    return null;
  }

  function isGenerationUrl(url) {
    // she-llac: POST URL includes /completion OR /retry_completion
    if (typeof url !== 'string') return false;
    if (COMPLETION_RE.test(url)) return true;
    if (url.includes('/completion') || url.includes('/retry_completion')) {
      return CHAT_CONVERSATIONS_RE.test(url);
    }
    return false;
  }

  function isTreeOrConversationUrl(url) {
    if (typeof url !== 'string') return false;
    if (isGenerationUrl(url)) return false;
    // she-llac: includes /chat_conversations/ (and often tree=)
    return CHAT_CONVERSATIONS_RE.test(url);
  }

  function isUsageUrl(url) {
    return (
      typeof url === 'string' &&
      /\/api\/organizations\/[^/]+\/usage\b/i.test(url)
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === 'request_ready') {
      post('ready');
      return;
    }

    if (msg.type === 'request_usage_fetch') {
      const url = msg.payload && msg.payload.url;
      if (!url) return;
      fetchUsage(url, !!(msg.payload && msg.payload.tree));
    }
  });

  const originalFetch = window.fetch;
  window.fetch = function hookFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    parseOrgConvo(url);

    const req = originalFetch.call(this, input, init);

    if (isGenerationUrl(url)) {
      return teeSSE(req, url);
    }
    if (isTreeOrConversationUrl(url) || isUsageUrl(url)) {
      return observeJsonResponse(req, url);
    }
    // Fallback: any claude.ai/api event-stream
    if (url.includes('claude.ai/api/') || url.startsWith('/api/')) {
      return maybeTeeByContentType(req, url);
    }
    return req;
  };

  function maybeTeeByContentType(responsePromise, url) {
    return responsePromise.then((response) => {
      if (!response || !response.ok || !response.body) return response;
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream')) return response;
      const [a, b] = response.body.tee();
      parseSSE(b, url);
      return new Response(a, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  }

  function teeSSE(responsePromise, url) {
    return responsePromise.then((response) => {
      if (!response.ok || !response.body) return response;
      const ct = response.headers.get('content-type') || '';
      if (
        ct &&
        !ct.includes('text/event-stream') &&
        !ct.includes('text/plain')
      ) {
        return response;
      }
      const [a, b] = response.body.tee();
      parseSSE(b, url);
      return new Response(a, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  }

  async function parseSSE(stream, url) {
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
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            handleSSEEvent(JSON.parse(raw));
          } catch (_) {}
        }
      }
    } catch (_) {
    } finally {
      try {
        await fetchConversationTreeAfterStream(url);
      } catch (_) {}
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

    if (
      (json.type === 'content_block_start' ||
        json.type === 'content_block_delta') &&
      json.content_block
    ) {
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

  async function fetchConversationTreeAfterStream(completionUrl) {
    parseOrgConvo(completionUrl || '');
    const orgId = lastOrgId;
    const convoId = lastConvoId;
    if (!orgId || !convoId) return;

    // she-llac active pull: tree=true&rendering_mode=messages&render_all_tools=true
    const treeUrl =
      'https://claude.ai/api/organizations/' +
      orgId +
      '/chat_conversations/' +
      convoId +
      '?tree=true&rendering_mode=messages&render_all_tools=true';

    try {
      const res = await originalFetch.call(window, treeUrl, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && (data.chat_messages || data.messages)) {
        post('sse', { kind: 'conversation_json', data });
      }
    } catch (_) {}

    // Also poll usage (she-llac: GET /api/organizations/${orgId}/usage)
    try {
      const usageUrl =
        'https://claude.ai/api/organizations/' + orgId + '/usage';
      const ures = await originalFetch.call(window, usageUrl, {
        method: 'GET',
        credentials: 'include',
      });
      if (!ures.ok) return;
      const uj = await ures.json();
      post('usage', { kind: 'polled', data: uj });
    } catch (_) {}
  }

  function observeJsonResponse(responsePromise, url) {
    return responsePromise.then(async (response) => {
      if (!response.ok || !response.body) return response;
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return response;
      try {
        const clone = response.clone();
        const json = await clone.json();
        if (json && (json.chat_messages || json.messages)) {
          post('sse', { kind: 'conversation_json', data: json });
        }
        if (
          json &&
          (json.message_limit ||
            json.messageLimit ||
            json.windows ||
            json.five_hour ||
            json.seven_day)
        ) {
          post('usage', { kind: 'json', data: json });
        }
      } catch (_) {}
      return response;
    });
  }

  async function fetchUsage(url, includeTree) {
    try {
      let fetchUrl = url;
      if (includeTree && !/[?&]tree=/i.test(url)) {
        fetchUrl +=
          (url.includes('?') ? '&' : '?') +
          'tree=true&rendering_mode=messages&render_all_tools=true';
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
      if (json && (json.chat_messages || json.messages)) {
        post('usage', { kind: 'json', data: json });
        post('sse', { kind: 'conversation_json', data: json });
      } else {
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
