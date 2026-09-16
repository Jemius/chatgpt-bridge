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
//      attribute (`data-bridge-reply-<id>`), which the content script observes.
//
// Communication with the content script (which lives in the ISOLATED world) is
// done through shared DOM attributes rather than `window.postMessage`, because
// the DOM is the one thing both worlds reliably share.
//
// ---------------------------------------------------------------------------
// Reply capture model (rewritten — the previous version truncated long replies)
// ---------------------------------------------------------------------------
// A single answer is NOT necessarily one response body. ChatGPT can end a
// stream early and continue the same message in a follow-up request, and a
// response body can also be cancelled mid-flight by the page. The old code
// stopped watching after the first matching response and posted whatever it had
// the moment that body ended, which returned only the first fragment of any
// multi-chunk answer (reproducible: "count 1..30" came back as "1,2,3").
//
// The current model instead:
//   - keeps watching the request id across *all* matching responses,
//   - accumulates text per content path (handling snapshots and deltas),
//   - posts once, after the stream has been quiet for SETTLE_MS.
// ---------------------------------------------------------------------------
(function () {
  if (window.__chatgptBridgeInjected) return;
  window.__chatgptBridgeInjected = true;

  // How long the stream must stay silent before we consider the answer finished.
  // Long enough to bridge the gap between a truncated stream and its follow-up
  // request; short enough not to feel laggy.
  const SETTLE_MS = 1800;
  // When the protocol itself says the message is complete we can release almost
  // immediately instead of waiting out the silence window.
  const SETTLE_DONE_MS = 400;

  // Capture-protocol version, exposed to the content script via the
  // `data-bridge-protocol` attribute on <html>. IMPORTANT: this MAIN-world
  // script's idempotency guard lives on the PAGE's window and survives an
  // extension reload — reloading the extension alone never updates this file
  // inside an open tab. The version attribute lets the content script detect
  // that stale state and fail loudly ("refresh the ChatGPT page") instead of
  // silently parsing with old capture code.
  const PROTOCOL = 5;
  function exposeProtocol() {
    const el = document.documentElement;
    if (!el) { setTimeout(exposeProtocol, 0); return; }
    try { el.setAttribute('data-bridge-protocol', String(PROTOCOL)); } catch (e) {}
  }
  exposeProtocol();

  // The request id we are currently watching for (set via data-bridge-watch).
  let watching = null;

  // requestId -> { acc: Map<path,string>, fallback: string[], raw: string,
  //                settleTimer, done, posted, lastOp }
  const captures = new Map();

  const origFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const method = (args[1] && args[1].method) || 'GET';

    // "Sent" marker: set the moment a conversation POST goes out while watching.
    // Doing this BEFORE `await` means the marker appears at the exact instant the
    // request is dispatched, which the content script uses to confirm the send.
    // The regex accepts both endpoint shapes ChatGPT has used
    // (/backend-api/conversation and /backend-api/f/conversation) while still
    // excluding lookalikes such as .../latent_conversation.
    if (watching && typeof url === 'string' && method === 'POST' && /backend-api\/(?:f\/)?conversation/.test(url)) {
      try { document.documentElement.setAttribute('data-bridge-sent', String(watching)); } catch (e) {}
    }

    const res = await origFetch.apply(this, args);

    try {
      if (typeof url === 'string' && /backend-api/.test(url)) {
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        // Only capture the real streaming reply: a 200 response that is NOT HTML
        // (an HTML response is usually a challenge/error page). If it's HTML we
        // deliberately do NOT consume the watch, so we keep waiting for the real
        // stream.
        //
        // NOTE: we deliberately do NOT clear `watching` here. The answer may span
        // several responses; every one of them is folded into the same capture.
        if (watching && /backend-api\/(?:f\/)?conversation/.test(url) && method === 'POST' && res.status === 200 && !/text\/html/.test(ct)) {
          captureResponse(res.clone(), watching);
        }
      }
    } catch (e) {}

    return res;
  };

  function entryFor(reqId) {
    let e = captures.get(reqId);
    if (!e) {
      // `lastOp` remembers the most recent frame that carried an operation —
      // see mergeInto (delta_encoding "v1" bare frames inherit from it).
      e = { acc: new Map(), fallback: [], raw: '', settleTimer: null, done: false, posted: false, lastOp: null };
      captures.set(reqId, e);
    }
    return e;
  }

  // Read the (cloned) response stream fully and fold it into the request's
  // capture. We read chunk by chunk and tolerate an abort: ChatGPT aborts the
  // fetch once the stream is complete (or when it switches to a follow-up), which
  // throws on the next read — we treat that as "this body is done", not as an
  // error, and keep everything we already have.
  async function captureResponse(res, reqId) {
    const entry = entryFor(reqId);
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

    entry.raw += text;
    // Fold this body into the running accumulators (a follow-up body may repeat
    // the whole message or continue it — the merge rule handles both).
    mergeInto(entry, text);

    // Restart the settle timer: the answer is only "done" once nothing new has
    // arrived. A body ending is NOT proof of completion — ChatGPT can end one
    // stream and continue the same message in a follow-up request, which is
    // exactly how the old code ended up returning only the first fragment.
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    entry.settleTimer = setTimeout(() => flush(reqId), entry.done ? SETTLE_DONE_MS : SETTLE_MS);
  }

  function flush(reqId) {
    const entry = captures.get(reqId);
    if (!entry || entry.posted) return;
    entry.posted = true;
    if (entry.settleTimer) { clearTimeout(entry.settleTimer); entry.settleTimer = null; }
    captures.delete(reqId);
    if (watching === reqId) watching = null;

    // cleanReplyText strips ChatGPT-internal artifacts that would otherwise
    // leak into the Markdown: citation markers (filecite + private-use
    // sentinel chars) and the :::writing canvas directive wrapper (N-9).
    const reply = cleanReplyText(assemble(entry));
    postReply({
      type: 'reply',
      requestId: reqId,
      reply,
      blockedFeatures: entry.blockedFeatures || [],
      rawLen: entry.raw.length,
      rawSample: entry.raw.slice(0, 20000)
    });
  }

  // Hand the reply back to the content script via a per-request DOM attribute.
  function postReply(payload) {
    try {
      const key = 'data-bridge-reply-' + (payload && payload.requestId ? payload.requestId : 'x');
      document.documentElement.setAttribute(key, encodeURIComponent(JSON.stringify(payload)));
    } catch (e) {}
  }

  // Parse one SSE body and fold every assistant text fragment into `entry`.
  // Line by line, tolerating the "data:" prefix and multi-line SSE frames.
  function mergeInto(entry, text) {
    const s = String(text);
    // Completion signals, checked on the raw text so they are found regardless of
    // the exact event shape: the SSE terminator, or ChatGPT marking the turn as
    // finished. Only used to release the settle timer early — never to cut a
    // capture short.
    if (s.indexOf('[DONE]') >= 0 || s.indexOf('finished_successfully') >= 0) entry.done = true;

    const lines = s.split('\n');
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('data:')) line = line.slice(5).trim();
      if (line === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        if (typeof obj.o === 'string') {
          // A frame that carries an operation: remember it, then process it.
          // delta_encoding "v1" lets later frames OMIT p/o — they inherit from
          // this one (real streams: `{"p":".../parts/0","o":"append","v":"1,2,3,"}`
          // followed by bare `{"v":"4,5,6,7,"}` frames).
          entry.lastOp = { p: obj.p, o: obj.o };
          collectText(obj, entry);
        } else if (entry.lastOp && 'v' in obj && !('type' in obj)) {
          // A bare delta frame (only `v`): inherit p/o from the last operation
          // frame. Frames carrying `type` are event notifications
          // (message_marker / title_generation / …), never content deltas, so
          // they must NOT inherit anything.
          collectText({ p: entry.lastOp.p, o: entry.lastOp.o, v: obj.v }, entry);
        } else {
          collectText(obj, entry);
        }
      } else {
        collectText(obj, entry);
      }
    }
  }

  // N-14 helper: depth-limited deep scan for `blocked_features` arrays anywhere
  // inside a parsed SSE frame (ChatGPT nests them under
  // conversation_detail_metadata, sometimes directly under the frame's v).
  // Dedup happens on the entry via name+resets_after, so repeated frames
  // collapse to one entry.
  function scanBlockedFeatures(obj, entry, depth) {
    if (!obj || typeof obj !== 'object' || depth > 8) return;
    if (Array.isArray(obj.blocked_features)) {
      for (const f of obj.blocked_features) {
        if (!f || typeof f !== 'object') continue;
        const key = String(f.name || '') + '|' + String(f.resets_after || '');
        if (!entry.blockedKeys) entry.blockedKeys = new Set();
        if (entry.blockedKeys.has(key)) continue;
        entry.blockedKeys.add(key);
        if (!entry.blockedFeatures) entry.blockedFeatures = [];
        entry.blockedFeatures.push({
          name: f.name,
          resetsAfter: f.resets_after,
          description: f.description
        });
      }
    }
    for (const k of Object.keys(obj)) {
      try { scanBlockedFeatures(obj[k], entry, depth + 1); } catch (e) { /* skip unreadable value */ }
    }
  }

  // Recursively extract reply text, covering the delta formats ChatGPT has used:
  //   - a path-scoped write: {"p":"/message/content/parts/0","o":"append","v":"..."}
  //     (also "replace"/"add"/"set"; "patch" wraps an array of such operations)
  //   - a full assistant message: message.author.role === "assistant" with
  //     message.content.parts — used only as a fallback when no path writes were
  //     seen, so the two shapes never get counted twice.
  function collectText(obj, entry) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const x of obj) collectText(x, entry); return; }

    // N-14: ChatGPT-side feature blocks (e.g. the attachment-quota block) ride
    // along inside metadata frames, nested at any depth (e.g.
    // v.conversation_detail_metadata.blocked_features, or v.blocked_features
    // on a p:"/conversation/metadata" frame). Deep-scan the frame and collect
    // them so the caller can tell "ChatGPT explicitly refused" apart from
    // "the model simply did not produce a file" — previously this only
    // surfaced by luck inside rawSample.
    scanBlockedFeatures(obj, entry, 0);

    const p = typeof obj.p === 'string' ? obj.p : null;
    if (p && /^\/message\/content\/parts\/\d+$/.test(p) && typeof obj.v === 'string') {
      writePath(entry, p, obj.v, obj.o);
    } else if (p === '' && obj.v && typeof obj.v === 'object') {
      // the initial "add" frame: p is the root, v is the whole node
      const m = obj.v.message || (obj.v.v && obj.v.v.message);
      if (m && m.author && m.author.role === 'assistant') pushFallback(entry, contentToString(m.content));
      collectText(obj.v, entry);
    } else if (obj.o === 'patch' && Array.isArray(obj.v)) {
      for (const x of obj.v) collectText(x, entry);
    }

    const msg = obj.message || (obj.v && obj.v.message);
    if (msg && msg.author && msg.author.role === 'assistant') {
      pushFallback(entry, contentToString(msg.content));
    }
    if (obj.type === 'text' && typeof obj.text === 'string' && obj.text) pushFallback(entry, obj.text);
    if (typeof obj.delta === 'string' && obj.delta) pushFallback(entry, obj.delta);
  }

  // Merge one write to a content path. The op tells us the semantics:
  //   - "replace"/"set"/"add" -> the value IS the content, overwrite ("add" is
  //     JSON-Patch insert/set, NOT append — treating it as append duplicated
  //     content whenever its value was not a prefix extension)
  //   - "append" -> the value is a fragment, concatenate
  // A follow-up body that re-sends the whole message still arrives as
  // "append"/"add", but its value then starts with everything we already have —
  // that is the one case we detect and treat as an overwrite, so re-sent
  // content is not doubled.
  function writePath(entry, path, value, op) {
    if (op === 'replace' || op === 'set' || op === 'add') { entry.acc.set(path, value); return; }
    const cur = entry.acc.get(path) || '';
    if (!cur) { entry.acc.set(path, value); return; }
    if (value === cur) return; // duplicate frame
    if (value.startsWith(cur)) { entry.acc.set(path, value); return; } // re-sent full text
    entry.acc.set(path, cur + value); // normal streaming fragment
  }

  function pushFallback(entry, text) {
    if (!text) return;
    if (entry.fallback[entry.fallback.length - 1] === text) return; // repeated snapshot
    entry.fallback.push(text);
  }

  function contentToString(content) {
    if (typeof content === 'string') return content;
    if (content && Array.isArray(content.parts)) {
      return content.parts.filter((p) => typeof p === 'string').join('');
    }
    if (Array.isArray(content)) return content.filter((p) => typeof p === 'string').join('');
    return '';
  }

  // Assemble the final reply. Path writes are the streaming source of truth;
  // the fallback list (whole-message snapshots taken straight from the server)
  // wins whenever it is LONGER. A snapshot can only come from this same
  // request's stream, so a longer snapshot means the path accumulation is
  // missing something (e.g. frames the parser had to skip) and the server's
  // own snapshot is the more complete truth.
  function assemble(entry) {
    const paths = [...entry.acc.keys()].sort((a, b) => partIndex(a) - partIndex(b));
    const fromPaths = paths.map((k) => entry.acc.get(k)).join('');

    let longest = '';
    for (const c of entry.fallback) if (c.length > longest.length) longest = c;

    if (!longest) return fromPaths || null;
    if (!fromPaths) return longest;
    return longest.length > fromPaths.length ? longest : fromPaths;
  }

  function partIndex(path) {
    const m = /\/parts\/(\d+)$/.exec(path);
    return m ? Number(m[1]) : 0;
  }

  // Strip ChatGPT-internal citation markers that leak into the Markdown reply
  // (observed with uploaded files): private-use sentinel characters wrapped
  // around a `filecite turn<N>file<N> [L<A>-L<B> …]` phrase. Private-use chars
  // are never legitimate content, so they become spaces; the citation phrase
  // itself is removed along with at most one leading space (any leftover
  // trailing space is trimmed downstream by the content script).
  function cleanReplyText(text) {
    if (!text) return text;
    return stripWritingWrapper(String(text)
      .replace(/[\uE000-\uF8FF]/g, ' ')
      .replace(/ ?\bfilecite\s+turn\d+file\d+(?:\s+L\d+(?:-L?\d+)?)*/g, ''));
  }

  // N-9: strip the ChatGPT-internal writing/canvas directive wrapper. When the
  // answer is produced in document/canvas mode, the raw stream wraps the whole
  // text in `:::writing{variant="document" id="…"}` … `:::`. The web page
  // renders that as a canvas (users never see the markers), but the bridge
  // would return them verbatim. Remove the opening line and the FIRST bare
  // `:::` line after it (when present) — independent `:::` lines in a reply
  // with no `:::writing` opening are legitimate content and stay untouched.
  function stripWritingWrapper(text) {
    const lines = String(text).split(/\r?\n/);
    let openIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^ *:::writing\{/.test(lines[i])) { openIdx = i; break; }
    }
    if (openIdx === -1) return text;
    let closeIdx = -1;
    for (let i = openIdx + 1; i < lines.length; i++) {
      if (/^ *::: *$/.test(lines[i])) { closeIdx = i; break; }
    }
    return lines.filter((_, i) => i !== openIdx && i !== closeIdx).join('\n');
  }

  // Poll for the content script's "watch" instruction (via a DOM attribute).
  // Implemented with a MutationObserver: attribute changes fire the callback
  // immediately and are NOT subject to background-tab timer throttling (the
  // previous 50ms setInterval was — a hidden tab throttles timers to 1/min,
  // which broke the whole handshake).
  function armWatchObserver() {
    const el = document.documentElement;
    if (!el) { setTimeout(armWatchObserver, 50); return; }
    const apply = () => {
      const v = el.getAttribute('data-bridge-watch');
      if (v) {
        el.removeAttribute('data-bridge-watch');
        watching = v;
      }
    };
    new MutationObserver(apply).observe(el, { attributes: true, attributeFilter: ['data-bridge-watch'] });
    apply(); // catch an instruction that was set before the observer was armed
  }
  armWatchObserver();
})();
