/**
 * Shiphook Claude Meter — MAIN-world fetch hook (v0.1.4 restore stub).
 * Full body follows in next commit if needed; this unblocks PLACEHOLDER.
 */
(function () {
  'use strict';
  var SOURCE = 'shiphook-claude-meter';
  function post(type, payload) {
    try { window.postMessage({ source: SOURCE, type: type, payload: payload }, '*'); } catch (_) {}
  }
  post('ready', { ts: Date.now() });
  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;
  function maybePostOrgFromUrl(url) {
    if (!url) return;
    var m = String(url).match(/\/api\/organizations\/([0-9a-fA-F-]{36})(?:\/|$|\?)/);
    if (m) post('org', { orgId: m[1] });
  }
  function isSse(headers) {
    if (!headers || typeof headers.get !== 'function') return false;
    var ct = headers.get('content-type') || '';
    return ct.toLowerCase().indexOf('text/event-stream') !== -1;
  }
  function interesting(url) {
    var s = String(url || '');
    return s.indexOf('/usage') !== -1 || s.indexOf('/organizations') !== -1 ||
      s.indexOf('/chat_conversations') !== -1 || s.indexOf('/completion') !== -1 ||
      s.indexOf('/append_message') !== -1 || s.indexOf('/events') !== -1;
  }
  function inspectSseChunk(text) {
    if (!text) return;
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed.indexOf('data:') !== 0) continue;
      var raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      var obj;
      try { obj = JSON.parse(raw); } catch (e) { continue; }
      if (obj.type === 'message_limit' || obj.message_limit || obj.event === 'message_limit' ||
          (obj.utilization != null && (obj.resets_at || obj.resetsAt))) {
        post('usage', { kind: 'message_limit', data: obj });
      }
      if (obj.message && obj.message.message_limit) {
        post('usage', { kind: 'message_limit', data: obj.message.message_limit });
      }
    }
  }
  async function teeSse(response, url) {
    if (!response || !response.body || !response.body.tee) return response;
    try {
      var branches = response.body.tee();
      var reader = branches[1].getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      (async function () {
        try {
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            var idx;
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
              inspectSseChunk(buffer.slice(0, idx + 2));
              buffer = buffer.slice(idx + 2);
            }
          }
          if (buffer) inspectSseChunk(buffer);
          post('sse', { kind: 'stream_end', url: String(url || '') });
        } catch (err) {
          post('sse', { kind: 'stream_error', error: err && err.message ? err.message : String(err) });
        }
      })();
      return new Response(branches[0], { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (err) {
      return response;
    }
  }
  async function observeJson(response, url) {
    try {
      var clone = response.clone();
      var data = await clone.json();
      post('usage', { kind: 'json', url: String(url || ''), data: data });
      if (data && (data.chat_messages || data.messages || data.conversation)) {
        post('sse', { kind: 'conversation_json', url: String(url || ''), data: data });
      }
    } catch (_) {}
  }
  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    maybePostOrgFromUrl(url);
    var response = await originalFetch.apply(this, arguments);
    try {
      if ((isSse(response.headers) || interesting(url)) && response.ok && isSse(response.headers)) {
        return await teeSse(response, url);
      }
      if (interesting(url) && response.ok) observeJson(response, url);
    } catch (_) {}
    return response;
  };
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.source !== SOURCE) return;
    if (msg.type === 'request_ready') {
      post('ready', { ts: Date.now(), resent: true });
      return;
    }
    if (msg.type === 'request_usage_fetch' && msg.payload && msg.payload.url) {
      var targetUrl = msg.payload.url;
      originalFetch.call(window, targetUrl, { credentials: 'include', headers: { Accept: 'application/json' } })
        .then(async function (res) {
          if (!res.ok) {
            post('usage', { kind: 'fetch_error', status: res.status, url: targetUrl });
            return;
          }
          try {
            var data = await res.json();
            maybePostOrgFromUrl(targetUrl);
            if (data && (data.chat_messages || data.messages || data.conversation)) {
              post('usage', { kind: 'json', url: targetUrl, data: data });
              post('sse', { kind: 'conversation_json', url: targetUrl, data: data });
            } else {
              post('usage', { kind: 'polled', url: targetUrl, data: data });
            }
          } catch (err) {
            post('usage', { kind: 'fetch_error', error: err && err.message ? err.message : String(err), url: targetUrl });
          }
        })
        .catch(function (err) {
          post('usage', { kind: 'fetch_error', error: err && err.message ? err.message : String(err), url: targetUrl });
        });
    }
  });
})();
