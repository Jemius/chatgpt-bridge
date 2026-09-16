// chatgpt-bridge · extension content script (isolated world)
//
// Runs on chatgpt.com and drives ChatGPT via DOM automation, while cooperating
// with the MAIN-world `injected.js` script to read replies from the network.
//
// Per chat request, it:
//   1. waits for the composer to be ready
//   2. optionally uploads a .md file
//   3. pastes the message into the composer
//   4. submits it (form submit, no button/text dependency)
//   5. asks injected.js (via a DOM attribute) to watch for the network reply
//   6. waits for the network reply (no reliance on page class names)
//   7. optionally captures Canvas "document" attachments (best-effort)
//   8. records the current conversation id for session binding
//
// Everything in this file is wrapped in an IIFE and guarded by a globalThis flag
// so re-injection (e.g. after an extension reload) never double-registers.
(function () {
  // Idempotency guard. globalThis resets across extension reloads/page refreshes,
  // so a stale DOM attribute (which would survive) can't block re-injection.
  if (globalThis.__chatgptBridgeLoaded) return;
  globalThis.__chatgptBridgeLoaded = true;

  // ChatGPT's DOM changes often. All selectors are kept as candidate arrays and
  // are tried in order, so a future breakage only needs an update here.
  const SELECTORS = {
    editor: [
      '#prompt-textarea',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]'
    ],
    fileInput: [
      'input[type="file"]',
      'form input[type="file"]',
      'input[accept*=".md"]'
    ],
    login: [
      'a[href*="/auth/login"]',
      'button[data-testid="login-button"]'
    ]
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Expected capture-protocol version — must match PROTOCOL in injected.js,
  // which exposes its actual version as the `data-bridge-protocol` attribute on
  // <html>. injected.js runs in the PAGE's MAIN world and its idempotency guard
  // survives an extension reload, so reloading the extension alone can leave an
  // OLD injected.js running in this tab. We fail loudly on that instead of
  // silently parsing with stale capture code.
  const EXPECTED_PROTOCOL = '4';
  function protocolError() {
    let actual = null;
    try { actual = document.documentElement.getAttribute('data-bridge-protocol'); } catch (e) {}
    if (actual === EXPECTED_PROTOCOL) return null;
    return actual == null
      ? 'injected.js (MAIN world) is not active — refresh the ChatGPT page (F5) and retry.'
      : 'injected.js is an old version (protocol ' + actual + ', expected ' + EXPECTED_PROTOCOL + ') — refresh the ChatGPT page (F5) and retry.';
  }

  // querySelector over a list of candidate selectors (first match wins).
  function $(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Wait for the composer to be ready (or fail fast with a clear error).
  async function ensureReady() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if ($(SELECTORS.login)) throw new Error('ChatGPT is not logged in — log in to chatgpt.com first.');
      if ($(SELECTORS.editor)) return true;
      await sleep(300);
    }
    throw new Error('ChatGPT composer not found — make sure the page is fully loaded.');
  }

  // Start a new conversation (used for `conversation: "new"`). Verified: we
  // poll until the SPA actually navigated to the fresh-chat URL, so a broken
  // selector can never silently drop the message into the previous conversation.
  async function clickNewChat() {
    if (location.pathname === '/') return; // already on a fresh chat
    const candidates = [
      'a[href="/"]',
      'button[data-testid*="new-chat"]',
      'button[aria-label*="New chat"]',
      'a[aria-label*="New chat"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) { el.click(); break; }
    }
    const byText = Array.from(document.querySelectorAll('button, a')).find(
      (b) => (b.textContent || '').trim().toLowerCase() === 'new chat'
    );
    if (byText) byText.click();

    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (location.pathname === '/') return;
      await sleep(200);
    }
    throw new Error('could not start a new chat — the new-chat button was not found or navigation did not happen (update clickNewChat)');
  }

  // Write text into the composer by simulating a paste event. This is more
  // reliable than setting innerText on ChatGPT's rich-text (ProseMirror) editor
  // and correctly handles newlines.
  function setEditorText(message) {
    const el = $(SELECTORS.editor);
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', message);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }

  // Submit the message and confirm the send at the NETWORK layer (no DOM class
  // dependency). `injected.js` sets the `data-bridge-sent` attribute the moment
  // the conversation POST goes out; we poll for it and safely retry if the
  // submit was blocked (e.g. a file still uploading — the editor still holds
  // text then, so re-submitting is safe and cannot double-send). Retries are
  // capped and gently backed off so a stuck confirmation can never spam the
  // same message into the conversation.
  async function submitWithConfirmation(requestId) {
    const editor = $(SELECTORS.editor);
    if (!editor) throw new Error('ChatGPT composer not found');
    if (!(editor.innerText || '').trim()) throw new Error('composer is empty — the message was not pasted');

    const form = editor.closest('form');
    const canSubmitForm = form && typeof form.requestSubmit === 'function';
    const submit = () => {
      if (canSubmitForm) {
        try { form.requestSubmit(); } catch (e) {}
      } else {
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    };
    const sent = () => document.documentElement.getAttribute('data-bridge-sent') === requestId;

    document.documentElement.removeAttribute('data-bridge-sent');
    submit();

    const start = Date.now();
    const MAX_SUBMITS = 5;
    let submits = 1;
    let delay = 1000; // mild backoff: 1s, 1.5s, 2s, 2.5s
    while (Date.now() - start < 12000) {
      if (sent()) return;
      await sleep(delay);
      delay = Math.min(delay + 500, 2500);
      if (sent()) return;
      if (submits < MAX_SUBMITS && (editor.innerText || '').trim().length > 0) {
        submit();
        submits++;
      }
    }
    if (sent()) return;
    throw new Error('message was not sent — no conversation request observed (upload may still be in progress, or timers are throttled because the tab is in the background)');
  }

  // Upload a .md file by placing a File into ChatGPT's hidden file input. This
  // uses the DataTransfer trick; note that some ChatGPT versions may not accept
  // it (known limitation, see README).
  function uploadFile(file) {
    const input = $(SELECTORS.fileInput);
    if (!input) return false;
    const f = new File([file.content], file.filename, { type: 'text/markdown' });
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Record the current conversation id (from /c/<id>) so the background can
  // navigate back to it on `continue` and avoid polluting other conversations.
  function recordConversationId() {
    const m = location.pathname.match(/^\/c\/([^/]+)/);
    if (m) {
      try { chrome.storage.local.set({ boundConversationId: m[1] }); } catch (e) {}
    }
  }

  // Wait for the network reply that injected.js posts back via a per-request
  // DOM attribute (data-bridge-reply-<requestId>). Uses a MutationObserver on
  // the attribute — its callback fires the moment the attribute is set and is
  // NOT subject to background-tab timer throttling (the old 100ms setInterval
  // polling was, which stalled the whole handshake in hidden tabs). A single
  // one-shot timeout enforces the deadline.
  function waitForNetworkReply(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const key = 'data-bridge-reply-' + requestId;
      const el = document.documentElement;
      let settled = false;

      const finish = (d) => {
        if (settled) return;
        settled = true;
        try { mo.disconnect(); } catch (e) {}
        clearTimeout(timer);
        resolve(d);
      };
      const check = () => {
        if (settled || !el) return;
        const attr = el.getAttribute(key);
        if (attr) {
          el.removeAttribute(key);
          try {
            finish(JSON.parse(decodeURIComponent(attr)));
          } catch (e) {}
        }
      };

      const mo = new MutationObserver(check);
      try { mo.observe(el, { attributes: true, attributeFilter: [key] }); } catch (e) {}
      const timer = setTimeout(() => {
        try { el.removeAttribute(key); } catch (e) {} // don't leave a stale attribute on <html>
        finish({ type: 'error', error: `timed out waiting for network reply (${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);

      check(); // the reply may already be there
    });
  }

  // ---------- HTML -> Markdown ----------
  // Used only for Canvas document attachments (best-effort). The main reply
  // comes from the network layer as Markdown already.
  function renderInline(node) {
    let out = '';
    for (const c of Array.from(node.childNodes || [])) {
      if (c.nodeType === 3) { out += c.textContent; continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (tag === 'pre') continue;
      const inner = renderInline(c);
      switch (tag) {
        case 'strong': case 'b': out += '**' + inner + '**'; break;
        case 'em': case 'i': out += '*' + inner + '*'; break;
        case 'code': out += '`' + c.textContent + '`'; break;
        case 'a': out += '[' + inner + '](' + (c.getAttribute('href') || '') + ')'; break;
        case 'del': case 's': out += '~~' + inner + '~~'; break;
        case 'img': out += '![' + (c.getAttribute('alt') || '') + '](' + (c.getAttribute('src') || '') + ')'; break;
        case 'br': out += '\n'; break;
        default: out += inner; break;
      }
    }
    return out;
  }

  function renderCodeBlock(pre) {
    const code = pre.querySelector('code') || pre;
    let lang = '';
    const holder = pre.querySelector('[class*="language-"]') || code;
    const m = (holder.className || '').match(/language-([\w+#.-]+)/);
    if (m) lang = m[1];
    return '```' + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n```';
  }

  function renderList(list, out, type) {
    let idx = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      idx++;
      const marker = type === 'ol' ? idx + '. ' : '- ';
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
      out.push(marker + renderInline(clone).trim());
      for (const ch of Array.from(li.children)) {
        if (['ul', 'ol'].includes(ch.tagName.toLowerCase())) renderList(ch, out, ch.tagName.toLowerCase());
      }
    }
  }

  function renderTable(table, out) {
    for (const [ri, tr] of Array.from(table.querySelectorAll('tr')).entries()) {
      const cells = Array.from(tr.children).map((c) => renderInline(c).replace(/\|/g, '\\|').trim());
      out.push('| ' + cells.join(' | ') + ' |');
      if (ri === 0) out.push('| ' + cells.map(() => '---').join(' | ') + ' |');
    }
  }

  function renderBlocks(node, out) {
    for (const c of Array.from(node.childNodes || [])) {
      if (c.nodeType === 3) { const t = c.textContent.trim(); if (t) out.push(t); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      switch (tag) {
        case 'p': out.push(renderInline(c)); out.push(''); break;
        case 'h1': out.push('# ' + renderInline(c)); out.push(''); break;
        case 'h2': out.push('## ' + renderInline(c)); out.push(''); break;
        case 'h3': out.push('### ' + renderInline(c)); out.push(''); break;
        case 'h4': case 'h5': case 'h6': out.push('#### ' + renderInline(c)); out.push(''); break;
        case 'ul': case 'ol': renderList(c, out, tag); out.push(''); break;
        case 'pre': out.push(renderCodeBlock(c)); out.push(''); break;
        case 'blockquote': {
          const inner = [];
          renderBlocks(c, inner);
          out.push(inner.filter((l) => l !== '').map((l) => '> ' + l).join('\n'));
          out.push('');
          break;
        }
        case 'table': renderTable(c, out); out.push(''); break;
        case 'hr': out.push('---'); out.push(''); break;
        default: renderBlocks(c, out); break;
      }
    }
  }

  function extractMarkdown(el) {
    const isMd = el && el.classList && el.classList.contains('markdown');
    const content = isMd ? el : (el.querySelector('.markdown') || el);
    const out = [];
    renderBlocks(content, out);
    return out.join('\n').trim() + '\n';
  }

  // ---------- Canvas document attachment capture (best-effort) ----------
  // Reads the Canvas editor (a ProseMirror element with class `markdown`),
  // preserving headings/lists/tables/code blocks via extractMarkdown rather
  // than the flattened innerText.
  //
  // A canvas left open by a PREVIOUS request stays in the DOM. Reading "the
  // first non-empty canvas" then silently attributed that stale text to every
  // later file capture — the right filename with unrelated content and no
  // error signal (the N-7 bug). The read is therefore bound to each click: a
  // pre-click snapshot records every open canvas node and its text; after the
  // click only a NEW canvas node, or a node whose text CHANGED relative to
  // that snapshot, counts as the answer.
  function snapshotCanvases() {
    const before = new Map();
    for (const el of document.querySelectorAll('div.ProseMirror.markdown')) {
      before.set(el, extractMarkdown(el).trim());
    }
    return before;
  }

  function readCanvasMarkdownExcluding(before) {
    for (const el of document.querySelectorAll('div.ProseMirror.markdown')) {
      const md = extractMarkdown(el).trim();
      if (!md) continue;
      if (before && before.has(el) && before.get(el) === md) continue;
      return md;
    }
    return '';
  }

  // Wait for a canvas that is new or changed relative to the pre-click
  // snapshot `before`. An unchanged stale canvas never qualifies, and a click
  // that failed to open anything times out honestly instead of returning
  // unrelated text.
  async function waitForCanvasMarkdown(timeoutMs, before) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const md = readCanvasMarkdownExcluding(before);
      if (md) return md;
      await sleep(300);
    }
    return '';
  }

  // Resolve an artifact card's display filename. The aria-label is verified
  // clean ("checkpoint.md"); when it is missing, fall back to the card text if
  // it names a .md file, else a generic name.
  function artifactFilename(btn) {
    const label = (btn.getAttribute('aria-label') || '').trim();
    if (label) return label;
    const text = (btn.textContent || '').trim();
    return (/\.md\b/i.test(text) && text.length <= 200) ? text : 'document.md';
  }

  // Cards inside a user message are the user's own uploads, not ChatGPT
  // artifacts — clicking them never yields Canvas content and used to produce
  // a fake "read failed" entry for every upload. Cards with no author-role
  // ancestor keep the old capture attempt (safe default).
  function isUserArtifact(btn) {
    try { return !!(btn.closest && btn.closest('[data-message-author-role="user"]')); }
    catch (e) { return false; }
  }

  // Pick capture targets from the matched card buttons. One file card can
  // surface as TWO distinct buttons (the aria-label chip and the peer/open-file
  // card), so the same file used to be clicked twice: the second read saw
  // content identical to the first, spun out its whole timeout, and landed in
  // `failed` — a misleading error sitting right next to the successful
  // capture. Dedup by resolved filename; nameless buttons stay one-per-node.
  function collectArtifactTargets(nodes, api) {
    const byName = new Map();
    const unnamed = [];
    for (const b of nodes) {
      if (api.isUserArtifact(b)) continue;
      const name = api.artifactFilename(b);
      if (name === 'document.md') { unnamed.push({ btn: b, filename: name }); continue; }
      if (!byName.has(name)) byName.set(name, { btn: b, filename: name });
    }
    return [...byName.values(), ...unnamed];
  }

  // Find every "document" card in the reply (e.g. 琵琶行.md), click to open it,
  // and read its content from the Canvas editor — one click per unique file,
  // each read bound to its own pre-click snapshot (see snapshotCanvases above).
  async function captureArtifacts(timeoutMs) {
    const targets = collectArtifactTargets(
      document.querySelectorAll('button[aria-label$=".md"], button[class*="peer/open-file"]'),
      { artifactFilename, isUserArtifact }
    );
    if (!targets.length) return { attachments: [], failed: [] };

    const perFileTimeout = Math.max(5000, Math.min(15000, Math.floor(timeoutMs / Math.max(targets.length, 1))));
    const attachments = [];
    const failed = [];

    for (const { btn, filename } of targets) {
      const before = snapshotCanvases();
      btn.click();
      const md = await waitForCanvasMarkdown(perFileTimeout, before);
      if (md) {
        attachments.push({ filename, content: md });
      } else {
        failed.push({ filename, error: 'attachment read timed out (canvas did not open or showed no new content)' });
      }
    }
    return { attachments, failed };
  }

  // Serialize requests — only one chat at a time, so the watch/reply handshake
  // and conversation state never get crossed.
  let busy = false;

  async function handleChat(request) {
    if (busy) return { error: 'another request is already in progress — try again in a moment.' };
    busy = true;
    try {
      const stale = protocolError();
      if (stale) throw new Error(stale);
      await ensureReady();
      if (request.conversation === 'new') {
        await clickNewChat(); // verified navigation; throws instead of polluting the old chat
        await ensureReady();  // the composer is re-created after the SPA navigation
      }

      // Optional .md file upload.
      if (request.file && request.file.content != null) {
        if (!uploadFile(request.file)) {
          throw new Error('could not find the file-upload input — update SELECTORS.fileInput');
        }
        await sleep(3000); // give the upload time; send success is confirmed at the network layer
      }

      // Tell injected.js to watch for the next network reply.
      const requestId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      document.documentElement.setAttribute('data-bridge-watch', requestId);
      await sleep(100);

      setEditorText(request.message);
      await sleep(300);
      await submitWithConfirmation(requestId);

      // The relay hands us an absolute deadline (its own timeout). EVERYTHING
      // that is left — waiting for the reply AND capturing attachments — must
      // fit inside it, otherwise the relay gives up first and the work is
      // wasted. Reserve ~25s of the remaining budget for attachment capture +
      // transport (floored so small timeouts still behave sanely).
      const deadline = Number(request.deadline) ||
        Date.now() + Math.min(Number(request.timeoutMs) || 240000, 600000);
      const netWait = Math.max(30000, deadline - Date.now() - 25000);
      const net = await waitForNetworkReply(requestId, netWait);

      let markdown = '';
      if (net.type === 'reply' && net.reply) {
        markdown = net.reply.trim();
      } else if (net.type === 'reply' && !net.reply) {
        throw new Error('captured a response but could not parse reply content. raw sample: ' + (net.rawSample || '(empty)'));
      } else {
        throw new Error(net.error || 'no ChatGPT reply captured');
      }

      const artifactsBudget = Math.max(10000, deadline - Date.now() - 5000);
      const { attachments, failed } = await captureArtifacts(artifactsBudget);
      recordConversationId();
      // `debug` is opt-in per request (see relay): it hands the raw captured
      // stream back to the caller for diagnosing truncation/parse issues.
      return request.debug
        ? { markdown, attachments, failed, rawSample: net.rawSample || '', rawLen: net.rawLen || 0 }
        : { markdown, attachments, failed };
    } catch (e) {
      return { error: e.message || String(e) };
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.type === 'chat') {
      handleChat(request).then(sendResponse);
      return true; // keep the message channel open for the async reply
    }
  });

  // Early console warning if the MAIN-world script is stale or missing. The
  // attribute may lag slightly behind at document_start, hence the delay.
  setTimeout(() => {
    const stale = protocolError();
    if (stale) console.error('[chatgpt-bridge] ' + stale);
  }, 1500);

  // Keep the service worker alive with a long-lived port + periodic heartbeat
  // messages. Without this, Chrome kills the idle worker and the WebSocket
  // (in background.js) drops repeatedly.
  (function keepAlive() {
    let port = null;
    let timer = null;
    const connect = () => {
      try {
        port = chrome.runtime.connect({ name: 'keepalive' });
        port.onDisconnect.addListener(() => {
          if (timer) { clearInterval(timer); timer = null; }
          setTimeout(connect, 500);
        });
        if (!timer) {
          timer = setInterval(() => {
            try { if (port) port.postMessage({ type: 'ping' }); } catch (e) {}
          }, 20000);
        }
      } catch (e) {
        setTimeout(connect, 2000);
      }
    };
    connect();
  })();
})();
