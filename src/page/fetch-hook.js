/**
 * Shiphook Claude Meter — MAIN-world fetch hook.
 * Intercepts network for org discovery, SSE tee, usage polling.
 * Posts to ISOLATED content script via postMessage.
 * MIT License — clean-room implementation.
 */
(function () {
  'use strict';

  const SOURCE = 'shiphook-claude-meter';

  // --- org discovery: /api/organizations/<uuid>/ ---
  const orgPattern = /\/api\/organizations\/([a-f0-9-]{36})\//i;

  // --- ready handshake ---
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === 'request_ready') {
      window.postMessage({ source: SOURCE, type: 'ready' }, '*');
      return;
    }

    if (msg.type === 'request_usage_fetch') {
      const url = msg.payload && msg.payload.url;
      if (!url) return;
      fetchUsage(url, msg.payload.tree);
    }
  });

  // --- fetch hook ---
  const originalFetch = window.fetch;
  window.fetch = function hookFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const match = orgPattern.exec(url);
    if (match) {
      const orgId = match[1];
      try {
        window.postMessage(
          { source: SOURCE, type: 'org', payload: { orgId } },
          '*'
        );
      } catch (_) {
        /* ignore */
      }
    }

    const req = originalFetch.call(this, input, init);
    if (/\/api\/conversations\//.test(url)) {
      return observeJsonResponse(req, url);
    }
    if (/\/api\/append_message/.test(url)) {
      return teeSSE(req, url);
    }
    return req;
  };

  // --- SSE tee ---
  function teeSSE(responsePromise, url) {
    return responsePromise.then((response) => {
      if (!response.ok || !response.body) return response;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) return response;

      const [stream1, stream2] = response.body.tee();
      parseSSE(stream2);
      return new Response(stream1, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
  }

  async function parseSSE(stream) {
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
          if (line.startsWith('data:')) {
            const json = line.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const event = JSON.parse(json);
              handleSSEEvent(event);
            } catch (_) {
              /* ignore */
            }
          }
        }
      }
    } catch (_) {
      /* stream closed or error */
    }
  }

  function handleSSEEvent(event) {
    if (!event || typeof event !== 'object') return;

    // message_limit
    if (event.type === 'message_limit' && event.message_limit) {
      try {
        window.postMessage(
          {
            source: SOURCE,
            type: 'usage',
            payload: { kind: 'message_limit', data: event.message_limit },
          },
          '*'
        );
      } catch (_) {
        /* ignore */
      }
    }

    // tool_use / web_search
    if (
      (event.type === 'content_block_start' || event.type === 'content_block_delta') &&
      event.content_block
    ) {
      const block = event.content_block;
      if (block.type === 'tool_use' || block.type === 'web_search') {
        const toolKind = block.type === 'web_search' ? 'web_search' : 'tool_call';
        const text =
          (block.input && JSON.stringify(block.input)) ||
          (block.text && typeof block.text === 'string' ? block.text : '');
        try {
          window.postMessage(
            {
              source: SOURCE,
              type: 'sse',
              payload: { kind: 'tool', toolKind, approxChars: text.length },
            },
            '*'
          );
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  // --- JSON response observer ---
  function observeJsonResponse(responsePromise, url) {
    return responsePromise.then(async (response) => {
      if (!response.ok || !response.body) return response;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return response;

      try {
        const clone = response.clone();
        const json = await clone.json();

        // conversation tree with chat_messages
        if (json && (json.chat_messages || json.messages)) {
          try {
            window.postMessage(
              {
                source: SOURCE,
                type: 'sse',
                payload: { kind: 'conversation_json', data: json },
              },
              '*'
            );
          } catch (_) {
            /* ignore */
          }
        }

        // usage JSON (GET /api/organizations/{org}/usage)
        if (
          json &&
          (json.message_limit ||
            json.messageLimit ||
            json.windows ||
            json.five_hour ||
            json.seven_day)
        ) {
          try {
            window.postMessage(
              {
                source: SOURCE,
                type: 'usage',
                payload: { kind: 'json', data: json },
              },
              '*'
            );
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* JSON parse error or cloning error */
      }

      return response;
    });
  }

  // --- usage fetch (polled or on-demand) ---
  async function fetchUsage(url, includeTree) {
    try {
      const fetchUrl = includeTree ? url + '?tree=True' : url;
      const res = await originalFetch.call(window, fetchUrl, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        window.postMessage(
          {
            source: SOURCE,
            type: 'usage',
            payload: { kind: 'fetch_error', status: res.status },
          },
          '*'
        );
        return;
      }

      const json = await res.json();

      // If response has messages/chat_messages, post both usage + conversation
      if (json && (json.chat_messages || json.messages)) {
        window.postMessage(
          {
            source: SOURCE,
            type: 'usage',
            payload: { kind: 'json', data: json },
          },
          '*'
        );
        window.postMessage(
          {
            source: SOURCE,
            type: 'sse',
            payload: { kind: 'conversation_json', data: json },
          },
          '*'
        );
      } else {
        // Standard usage poll
        window.postMessage(
          {
            source: SOURCE,
            type: 'usage',
            payload: { kind: 'polled', data: json },
          },
          '*'
        );
      }
    } catch (err) {
      window.postMessage(
        {
          source: SOURCE,
          type: 'usage',
          payload: {
            kind: 'fetch_error',
            error: err && err.message ? err.message : 'fetch_error',
          },
        },
        '*'
      );
    }
  }

  // Boot: signal ready
  window.postMessage({ source: SOURCE, type: 'ready' }, '*');
})();
