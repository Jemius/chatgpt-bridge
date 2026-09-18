// chatgpt-bridge · extension background service worker
//
// This is the "middleman" between the local relay and the ChatGPT page:
//
//   1. Opens a WebSocket to the relay (ws://127.0.0.1:8742/ws).
//   2. When the relay pushes a `chat` request, it finds the ChatGPT tab and
//      forwards the request to the content script (which does the DOM work).
//   3. Sends the content script's result (Markdown + attachments) back to the relay.
//
// Two MV3-specific concerns are handled here:
//   - **Service-worker lifetime**: Chrome kills idle service workers, which
//     would drop the WebSocket. We keep it alive with (a) a keepalive port from
//     the content script, and (b) a 30-second `chrome.alarms` heartbeat.
//   - **Content-script injection**: after an extension reload, an already-open
//     tab may not have the content script. We auto-inject it and retry once.
const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8742/ws';
let relayUrl = DEFAULT_RELAY_URL;

let ws = null;
let reconnectTimer = null;
let backoffMs = 1000;

// Optional shared secret. Must match BRIDGE_TOKEN on the relay. Browser
// WebSockets cannot set headers, so it is appended to the WS URL as ?token=.
let bridgeToken = '';

// Results that could not be delivered because the socket was down. The relay
// keeps requests pending in a map (it does not tie a request to a socket), so
// a late answer after a reconnect is still accepted. Bounded to the 20 most
// recent results.
const outboundQueue = new Map(); // id -> serialized payload

// Build the connect URL, attaching the token when one is configured.
function wsUrl() {
  if (!bridgeToken) return relayUrl;
  return relayUrl + (relayUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(bridgeToken);
}

// Read the (optional) relay URL and token from chrome.storage.local.
// Change them from the service-worker console with:
//   chrome.storage.local.set({ relayUrl: 'ws://127.0.0.1:9000/ws', bridgeToken: 'secret' })
function loadConfig() {
  try {
    chrome.storage.local.get({ relayUrl: DEFAULT_RELAY_URL, bridgeToken: '' }, (r) => {
      const urlChanged = r.relayUrl && r.relayUrl !== relayUrl;
      const tokenChanged = (r.bridgeToken || '') !== bridgeToken;
      if (!urlChanged && !tokenChanged) return;
      relayUrl = r.relayUrl || DEFAULT_RELAY_URL;
      bridgeToken = r.bridgeToken || '';
      if (ws) { try { ws.close(); } catch (e) {} }
      ws = null;
      ensureWs();
    });
  } catch (e) {}
}

// Send the connect handshake: extension version + expected capture protocol.
// The relay surfaces both via /health, so "which build is running" stops being
// a five-path investigation. `chrome.runtime.getManifest()` is always available
// in the service worker; the protocol value comes from chrome.storage (written
// by content.js at injection time, since content.js owns EXPECTED_PROTOCOL).
// If storage is slow or the socket died meanwhile we fall back to a
// version-only hello — old relays ignore the extra fields, new relays show
// nulls as "not reported".
function sendHello(sock) {
  let version = null;
  try { version = chrome.runtime.getManifest().version; } catch (e) {}
  try {
    chrome.storage.local.get({ extProtocol: null }, (r) => {
      try {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(JSON.stringify({ type: 'hello', version, protocol: r.extProtocol || null }));
      } catch (e) {}
    });
  } catch (e) {
    try {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'hello', version, protocol: null }));
      }
    } catch (e2) {}
  }
}

function ensureWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let sock;
  try {
    sock = new WebSocket(wsUrl());
  } catch (e) {
    ws = null;
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    backoffMs = 1000; // connection succeeded — reset the backoff
    flushOutbound();
    sendHello(sock);
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'chat') handleChat(msg);
  };
  // The handlers close over `sock`, NOT the module-level `ws`. A stale socket's
  // close event (e.g. fired right after a config-driven reconnect) must not
  // clear the NEW connection's slot — that used to orphan the live connection
  // and made ensureWs() open duplicates.
  sock.onclose = () => {
    if (ws === sock) { ws = null; scheduleReconnect(); }
  };
  sock.onerror = () => {
    try { sock.close(); } catch (e) {}
    if (ws === sock) { ws = null; scheduleReconnect(); }
  };
}

// Exponential backoff with jitter: reconnect quickly after a relay restart.
// (The 30s chrome.alarms fallback alone left a dead window of up to a minute —
// and the minimum alarm period is even longer in packed extensions.)
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = backoffMs + Math.floor(Math.random() * 300);
  backoffMs = Math.min(backoffMs * 2, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureWs();
  }, delay);
}

function respond(id, obj) {
  const payload = JSON.stringify(Object.assign({ id }, obj));
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(payload); outboundQueue.delete(id); return; } catch (e) {}
  }
  // Socket down (reconnecting): buffer instead of silently dropping — the
  // caller would otherwise wait the full relay timeout for a result that
  // already exists.
  outboundQueue.set(id, payload);
  if (outboundQueue.size > 20) {
    outboundQueue.delete(outboundQueue.keys().next().value);
  }
}

function flushOutbound() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const payload of outboundQueue.values()) {
    try { ws.send(payload); } catch (e) {}
  }
  outboundQueue.clear();
}

// Wait for a tab to finish loading after a navigation (used by session binding).
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve();
      } catch (e) { return resolve(); }
      if (Date.now() - start > timeoutMs) return resolve();
      setTimeout(check, 500);
    };
    check();
  });
}

// Send a message to the content script. If it isn't ready (e.g. the extension
// was just reloaded), inject both scripts and retry once.
async function sendToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['injected.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

async function handleChat(msg) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  } catch (e) {
    respond(msg.id, { type: 'error', error: 'tab query failed: ' + (e.message || e) });
    return;
  }
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) {
    respond(msg.id, { type: 'error', error: 'no ChatGPT tab open — open and log in to https://chatgpt.com first.' });
    return;
  }

  // Session binding: for `continue`, if the tab is on a different conversation
  // than the one we've been using, navigate back to it first. This prevents the
  // bridge from polluting your other conversations.
  // User report (2026-09-18): when the navigation did NOT finish within the
  // wait window (slow network / ChatGPT slowness), the request used to fall
  // through and submit on the CURRENT page — which silently created a NEW
  // conversation instead of continuing the bound one. Verify the tab actually
  // got there; fail loudly with a retry hint instead of submitting into the
  // wrong page (a retry is cheap; a wrong-page submit is not).
  if (msg.conversation !== 'new') {
    let boundConversationId = null;
    try {
      boundConversationId = (await chrome.storage.local.get('boundConversationId')).boundConversationId;
    } catch (e) {} // no binding info: nothing to rebind — submit normally
    if (boundConversationId) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (t && t.url && !t.url.includes('/c/' + boundConversationId)) {
        // Tester re-check (2026-09-18): the outer catch(e){} used to swallow
        // navigation plumbing errors (tabs.get/tabs.update throwing) and let
        // the request fall through to a submit on the CURRENT page — the
        // exact new-conversation failure mode this block exists to prevent.
        // Every failure past this point now fails loudly instead.
        try {
          await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/c/' + boundConversationId });
          await waitForTabLoad(tab.id, 15000);
        } catch (e) {
          respond(msg.id, {
            type: 'error',
            error: 'session rebinding failed: ' + (e && e.message ? e.message : e) + ' — the request was NOT submitted (retry)'
          });
          return;
        }
        const t2 = await chrome.tabs.get(tab.id).catch(() => null);
        if (!t2 || !t2.url || !t2.url.includes('/c/' + boundConversationId)) {
          respond(msg.id, {
            type: 'error',
            error: 'session rebinding did not finish: the tab never reached conversation ' + boundConversationId + ' — the request was NOT submitted (retry; if this repeats, open the conversation manually and retry)'
          });
          return;
        }
      }
    }
  }

  const payload = {
    type: 'chat',
    message: msg.message,
    conversation: msg.conversation,
    timeoutMs: msg.timeoutMs,
    deadline: msg.deadline, // absolute relay deadline, budgeted against in content.js
    file: msg.file,
    // `debug` makes the content script return the raw captured stream so a
    // caller can diagnose truncation/parse issues.
    debug: !!msg.debug
  };

  try {
    const r = await sendToTab(tab.id, payload);
    if (r && r.error) respond(msg.id, { type: 'error', error: r.error });
    else {
      respond(msg.id, {
        type: 'result',
        markdown: (r && r.markdown) || '',
        attachments: (r && r.attachments) || [],
        failed: (r && r.failed) || [],
        // N-14 field chain: forward the content script's blockedFeatures. This
        // line was MISSING in v1.2.8..v1.2.11 — background silently dropped the
        // field here, so the relay/MCP always saw [] and ChatGPT-side feature
        // blocks (e.g. attachment quota) never reached the caller. Now covered
        // by tools/test-bridge-fields.js so it cannot silently regress.
        blockedFeatures: (r && r.blockedFeatures) || [],
        rawSample: (r && r.rawSample) || undefined,
        rawLen: (r && r.rawLen) || undefined
      });
    }
  } catch (e) {
    respond(msg.id, { type: 'error', error: 'content script not ready — reload the ChatGPT tab. (' + (e.message || e) + ')' });
  }
}

loadConfig();
ensureWs();

// Accept the content script's keepalive port. An open port with periodic
// messages keeps the service worker alive so the WebSocket doesn't drop.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {});
  }
});

// Recreate the heartbeat alarm on every service-worker startup (idempotent),
// so a killed worker is woken up and reconnects.
try { chrome.alarms.create('ping', { periodInMinutes: 0.5 }); } catch (e) {}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.relayUrl || changes.bridgeToken)) loadConfig();
  });
} catch (e) {}

chrome.runtime.onStartup.addListener(ensureWs);
chrome.runtime.onInstalled.addListener(() => {
  ensureWs();
  // MAIN-world injected.js survives extension reloads inside open tabs (its
  // guard lives on the page's window). The content script detects that stale
  // state via the data-bridge-protocol version handshake and fails with a
  // clear message instead of silently mis-parsing — this log is the heads-up.
  console.warn('[chatgpt-bridge] extension (re)installed — refresh open ChatGPT tabs (F5) so injected.js picks up the new capture code.');
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'ping') return;
  ensureWs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
  }
});
