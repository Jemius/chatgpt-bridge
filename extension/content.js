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

  // Start a new conversation (used for `conversation: "new"`).
  function clickNewChat() {
    const candidates = [
      'a[href="/"]',
      'button[data-testid*="new-chat"]',
      'button[aria-label*="New chat"]',
      'a[aria-label*="New chat"]'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) { el.click(); return; }
    }
    const byText = Array.from(document.querySelectorAll('button, a')).find(
      (b) => (b.textContent || '').trim().toLowerCase() === 'new chat'
    );
    if (byText) byText.click();
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
  // text then, so re-submitting is safe and cannot double-send).
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
    while (Date.now() - start < 10000) {
      if (sent()) return;
      await sleep(500);
      if (!sent() && (editor.innerText || '').trim().length > 0) submit();
    }
    if (sent()) return;
    throw new Error('message was not sent — no conversation request observed (upload may still be in progress)');
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
  // DOM attribute (data-bridge-reply-<requestId>). Using a per-request key
  // avoids a race when multiple requests overlap.
  function waitForNetworkReply(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const key = 'data-bridge-reply-' + requestId;
      const start = Date.now();
      const timer = setInterval(() => {
        const el = document.documentElement;
        const attr = el ? el.getAttribute(key) : null;
        if (attr) {
          el.removeAttribute(key);
          try {
            const d = JSON.parse(decodeURIComponent(attr));
            clearInterval(timer);
            resolve(d);
            return;
          } catch (e) {}
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve({ type: 'error', error: `timed out waiting for network reply (${Math.round(timeoutMs / 1000)}s)` });
        }
      }, 100);
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
  function readCanvasMarkdown() {
    for (const el of document.querySelectorAll('div.ProseMirror.markdown')) {
      const md = extractMarkdown(el).trim();
      if (md) return md;
    }
    return '';
  }

  // Wait for the Canvas editor to show content different from `previous`, so a
  // multi-file reply doesn't re-read the previous file.
  async function waitForCanvasMarkdown(timeoutMs, previous) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const md = readCanvasMarkdown();
      if (md && md !== previous) return md;
      await sleep(300);
    }
    return '';
  }

  // Find every "document" card in the reply (e.g. 琵琶行.md), click to open it,
  // and read its content from the Canvas editor.
  async function captureArtifacts(timeoutMs) {
    const seen = new Set();
    document.querySelectorAll('button[aria-label$=".md"], button[class*="peer/open-file"]').forEach((b) => seen.add(b));
    const btns = [...seen];
    if (!btns.length) return { attachments: [], failed: [] };

    const perFileTimeout = Math.max(5000, Math.min(15000, Math.floor(timeoutMs / Math.max(btns.length, 1))));
    const attachments = [];
    const failed = [];
    let prev = '';

    for (const btn of btns) {
      const filename = (btn.getAttribute('aria-label') || '').trim() || 'document.md';
      btn.click();
      const md = await waitForCanvasMarkdown(perFileTimeout, prev);
      if (md) {
        attachments.push({ filename, content: md });
        prev = md;
      } else {
        failed.push({ filename, error: 'attachment read timed out or was empty' });
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
      await ensureReady();
      if (request.conversation === 'new') { clickNewChat(); await sleep(800); }

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

      // Timeout slightly before the relay gives up, so the relay gets a clean
      // error rather than silently dropping the result.
      const timeoutMs = Math.max(30000, (Number(request.timeoutMs) || 240000) - 20000);
      const net = await waitForNetworkReply(requestId, timeoutMs);

      let markdown = '';
      if (net.type === 'reply' && net.reply) {
        markdown = net.reply.trim();
      } else if (net.type === 'reply' && !net.reply) {
        throw new Error('captured a response but could not parse reply content. raw sample: ' + (net.rawSample || '(empty)'));
      } else {
        throw new Error(net.error || 'no ChatGPT reply captured');
      }

      const { attachments, failed } = await captureArtifacts(timeoutMs);
      recordConversationId();
      return { markdown, attachments, failed };
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
