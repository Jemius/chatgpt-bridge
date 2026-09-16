// chatgpt-bridge · extension injected script (MAIN world)
//
// Injected into the page's MAIN world at document_start (see manifest.json,
// "world": "MAIN") so it can hook `window.fetch` and read ChatGPT's backend
// responses directly — this is far more robust than scraping page class names,
// which ChatGPT changes frequently.
//
// Responsibilities:
//   1. Hook `window.fetch` to detect when a conversation POST goes out while the
//      content script is "watching" (marks `data-bridge-sent`).
//   2. Capture the streaming (SSE) reply to that conversation request and parse
//      out the assistant's Markdown text.
//   3. Hand the parsed reply back to the content script via a per-request DOM
//      attribute (`data-bridge-reply-<id>`), which the content script polls.
//
// Communication with the content script (which lives in the ISOLATED world) is
// done through shared DOM attributes rather than `window.postMessage`, because
// the DOM is the one thing both worlds reliably share.
(function () {
  if (window.__chatgptBridgeInjected) return;
  window.__chatgptBridgeInjected = true;

  // The request id we are currently watching for (set via data-bridge-watch).
  let watching = null;

  const origFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const method = (args[1] && args[1].method) || 'GET';

    // "Sent" marker: set the moment a conversation POST goes out while watching.
    // Doing this BEFORE `await` means the marker appears at the exact instant the
    // request is dispatched, which the content script uses to confirm the send.
    if (watching && typeof url === 'string' && method === 'POST' && /backend-api\/f\/conversation/.test(url)) {
      try { document.documentElement.setAttribute('data-bridge-sent', String(watching)); } catch (e) {}
    }

    const res = await origFetch.apply(this, args);

    try {
      if (typeof url === 'string' && /backend-api/.test(url)) {
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        // Only capture the real streaming reply: a 200 response that is NOT HTML
        // (an HTML response is usually a challenge/error page). If it's HTML we
        // deliberately do NOT consume `watching`, so we keep waiting for the real
        // stream.
        if (watching && /f\/conversation/.test(url) && method === 'POST' && res.status === 200 && !/text\/html/.test(ct)) {
          const reqId = watching;
          watching = null;
          captureResponse(res.clone(), reqId);
        }
      }
    } catch (e) {}

    return res;
  };

  // Read the (cloned) response stream fully and parse the reply. We read chunk
  // by chunk and tolerate an abort: ChatGPT aborts the fetch once the stream is
  // complete, which throws on the next read — we treat that as "done".
  async function captureResponse(res, reqId) {
    let text = '';
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        while (true) {
          try {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) text += decoder.decode(value, { stream: true });
          } catch (e) {
            break; // stream interrupted (e.g. aborted) — treat as end, keep what we have
          }
        }
        try { text += decoder.decode(); } catch (e) {}
      } else {
        try { text = await res.text(); } catch (e) {}
      }
    } catch (e) {}

    const reply = parseReply(text);
    postReply({ type: 'reply', requestId: reqId, reply, rawSample: text.slice(0, 20000) });
  }

  // Hand the reply back to the content script via a per-request DOM attribute.
  function postReply(payload) {
    try {
      const key = 'data-bridge-reply-' + (payload && payload.requestId ? payload.requestId : 'x');
      document.documentElement.setAttribute(key, encodeURIComponent(JSON.stringify(payload)));
    } catch (e) {}
  }

  // Parse the SSE-ish stream, line by line (tolerating the "data:" prefix), and
  // extract every assistant text fragment.
  function parseReply(text) {
    const cands = [];
    const lines = String(text).split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      collectText(obj, cands);
    }
    return finalize(cands);
  }

  // Recursively extract reply text, covering the delta formats ChatGPT has used:
  //   - a top-level append: {"p":"/message/content/parts/0","o":"append","v":"..."}
  //   - an append nested inside a patch array (common for short replies)
  //   - the older assistant message shape: message.author.role === "assistant"
  //     with message.content.parts.
  function collectText(obj, cands) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const x of obj) collectText(x, cands); return; }

    if (obj.o === 'append' && typeof obj.p === 'string' && obj.p.indexOf('/message/content/parts/') === 0 && typeof obj.v === 'string' && obj.v) {
      cands.push(obj.v);
    }
    if (obj.o === 'patch' && Array.isArray(obj.v)) {
      for (const x of obj.v) collectText(x, cands);
    }
    const msg = obj.message || (obj.v && obj.v.message);
    if (msg && msg.author && msg.author.role === 'assistant') {
      const c = contentToString(msg.content);
      if (c) cands.push(c);
    }
    if (obj.type === 'text' && typeof obj.text === 'string' && obj.text) cands.push(obj.text);
    if (typeof obj.delta === 'string' && obj.delta) cands.push(obj.delta);
  }

  function contentToString(content) {
    if (typeof content === 'string') return content;
    if (content && Array.isArray(content.parts)) {
      return content.parts.filter((p) => typeof p === 'string').join('');
    }
    if (Array.isArray(content)) return content.filter((p) => typeof p === 'string').join('');
    return '';
  }

  // ChatGPT streams text either as growing snapshots (each event is the full
  // text so far) or as deltas. Collapse accordingly:
  //   - if every fragment is a prefix of the next → take the last (full text)
  //   - otherwise → join them (deltas)
  function finalize(cands) {
    cands = cands.filter((c) => c && c.length);
    if (!cands.length) return null;
    let accumulative = true;
    for (let i = 1; i < cands.length; i++) {
      if (!cands[i].startsWith(cands[i - 1])) { accumulative = false; break; }
    }
    if (accumulative) return cands[cands.length - 1];
    return cands.join('');
  }

  // Poll for the content script's "watch" instruction (via a DOM attribute).
  setInterval(() => {
    const el = document.documentElement;
    if (!el) return;
    const v = el.getAttribute('data-bridge-watch');
    if (v) {
      el.removeAttribute('data-bridge-watch');
      watching = v;
    }
  }, 50);
})();
