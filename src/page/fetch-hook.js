/**
 * Shiphook Claude Meter — MAIN-world fetch hook.
 * Tees SSE / completion streams, parses message_limit + tool events.
 * Never sends data off-device; only postMessage to same window.
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';

  function post(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload }, '*');
    } catch (_) {
      /* ignore */
    }
  }

  post('ready', { ts: Date.now() });

  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  function isSseContentType(headers) {
    if (!headers) return false;
    const ct =
      typeof headers.get === 'function'
        ? headers.get('content-type')
        : headers['content-type'] || headers['Content-Type'];
    return typeof ct === 'string' && ct.toLowerCase().includes('text/event-stream');
  }

  function isClaudeCompletionUrl(url) {
    if (!url) return false;
    const s = String(url);
    return (
      s.includes('/completion') ||
      s.includes('/chat_conversations') ||
      s.includes('/append_message') ||
      s.includes('/events') ||
      s.includes('message_stream')
    );
  }

  function isUsageOrConversationUrl(url) {
    if (!url) return false;
    const s = String(url);
    return (
      s.includes('/usage') ||
      s.includes('/organizations') ||
      s.includes('/chat_conversations') ||
      s.includes('/conversation')
    );
  }

  /**
   * Parse one SSE data line / blob for message_limit and tool-ish events.
   */
  function inspectSseChunk(text) {
    if (!text || typeof text !== 'string') return;

    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;

      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }

      // message_limit utilization / resets
      if (
        obj.type === 'message_limit' ||
        obj.message_limit ||
        obj.event === 'message_limit' ||
        (obj.utilization != null && (obj.resets_at || obj.resetsAt || obj.type === 'rate_limit'))
      ) {
        post('usage', { kind: 'message_limit', data: obj });
      }

      // Nested message_limit payloads
      if (obj.message && obj.message.message_limit) {
        post('usage', { kind: 'message_limit', data: obj.message.message_limit });
      }

      countToolsInObject(obj);
    }
  }

  function countToolsInObject(obj, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 8) return;

    const type = obj.type || obj.name || obj.tool || '';
    const typeStr = String(type).toLowerCase();

    if (
      typeStr === 'tool_use' ||
      typeStr === 'tool_call' ||
      typeStr.includes('tool_use') ||
      typeStr.includes('tool_call')
    ) {
      post('sse', {
        kind: 'tool',
        toolKind: classifyTool(obj),
        name: obj.name || obj.tool_name || obj.id || typeStr,
        approxChars: estimateChars(obj),
      });
    }

    if (
      typeStr.includes('web_search') ||
      typeStr === 'server_tool' ||
      typeStr.includes('server_tool')
    ) {
      post('sse', {
        kind: 'tool',
        toolKind: typeStr.includes('web_search') ? 'web_search' : 'tool_call',
        name: obj.name || typeStr,
        approxChars: estimateChars(obj),
      });
    }

    // Streamed delta content blocks
    const content = obj.delta || obj.content_block || obj.content || obj.message;
    if (Array.isArray(content)) {
      for (const block of content) countToolsInObject(block, (depth || 0) + 1);
    } else if (content && typeof content === 'object') {
      countToolsInObject(content, (depth || 0) + 1);
    }

    if (obj.delta && typeof obj.delta === 'object') {
      countToolsInObject(obj.delta, (depth || 0) + 1);
    }
  }

  function classifyTool(obj) {
    const name = String(obj.name || obj.tool_name || obj.type || '').toLowerCase();
    if (name.includes('web_search') || name.includes('web search')) return 'web_search';
    if (name.includes('server_tool') || name === 'server_tool') return 'tool_call';
    return 'tool_call';
  }

  function estimateChars(obj) {
    try {
      return JSON.stringify(obj).length;
    } catch {
      return 0;
    }
  }

  async function teeSseResponse(response, url) {
    if (!response || !response.body || !response.body.tee) {
      return response;
    }

    try {
      const [browserBranch, meterBranch] = response.body.tee();
      const reader = meterBranch.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Process complete SSE events (blank-line delimited) when possible
            let idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              const chunk = buffer.slice(0, idx + 2);
              buffer = buffer.slice(idx + 2);
              inspectSseChunk(chunk);
            }
            // Also scan residual for immediate data: lines
            if (buffer.length > 8192) {
              inspectSseChunk(buffer);
              buffer = buffer.slice(-2048);
            }
          }
          if (buffer) inspectSseChunk(buffer);
          post('sse', { kind: 'stream_end', url: String(url || '') });
        } catch (err) {
          post('sse', {
            kind: 'stream_error',
            error: err && err.message ? err.message : String(err),
          });
        }
      })();

      return new Response(browserBranch, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      post('sse', {
        kind: 'tee_error',
        error: err && err.message ? err.message : String(err),
      });
      return response;
    }
  }

  async function observeJsonResponse(response, url) {
    try {
      const clone = response.clone();
      const ct = clone.headers && clone.headers.get
        ? clone.headers.get('content-type') || ''
        : '';
      if (!ct.includes('application/json') && !isUsageOrConversationUrl(url)) {
        return;
      }
      const data = await clone.json();
      post('usage', { kind: 'json', url: String(url || ''), data });

      // Conversation tree / messages — useful for context approx
      if (data && (data.chat_messages || data.messages || data.conversation)) {
        post('sse', { kind: 'conversation_json', url: String(url || ''), data });
      }
    } catch (_) {
      /* non-JSON or aborted — ignore */
    }
  }

  window.fetch = async function patchedFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input && input.url
          ? input.url
          : String(input);

    const response = await originalFetch.apply(this, arguments);

    try {
      const wantSse =
        isSseContentType(response.headers) || isClaudeCompletionUrl(url);

      if (wantSse && response.ok) {
        const teed = await teeSseResponse(response, url);
        // Also try JSON observe on non-stream completions if applicable
        return teed;
      }

      if (isUsageOrConversationUrl(url) && response.ok) {
        observeJsonResponse(response, url);
      }
    } catch (_) {
      /* never break page fetch */
    }

    return response;
  };

  // Expose a best-effort same-origin usage fetch for the content script to request
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === 'request_usage_fetch' && msg.payload && msg.payload.url) {
      const targetUrl = msg.payload.url;
      originalFetch
        .call(window, targetUrl, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        })
        .then(async (res) => {
          if (!res.ok) {
            post('usage', {
              kind: 'fetch_error',
              status: res.status,
              url: targetUrl,
            });
            return;
          }
          try {
            const data = await res.json();
            post('usage', { kind: 'polled', url: targetUrl, data });
          } catch (err) {
            post('usage', {
              kind: 'fetch_error',
              error: err && err.message ? err.message : String(err),
              url: targetUrl,
            });
          }
        })
        .catch((err) => {
          post('usage', {
            kind: 'fetch_error',
            error: err && err.message ? err.message : String(err),
            url: targetUrl,
          });
        });
    }
  });
})();
