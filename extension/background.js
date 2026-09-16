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

// Read the (optional) relay URL override from chrome.storage.local.
// Change it from the service-worker console with:
//   chrome.storage.local.set({ relayUrl: 'ws://127.0.0.1:9000/ws' })
function loadConfig() {
  try {
    chrome.storage.local.get({ relayUrl: DEFAULT_RELAY_URL }, (r) => {
      if (r.relayUrl && r.relayUrl !== relayUrl) {
        relayUrl = r.relayUrl;
        if (ws) { try { ws.close(); } catch (e) {} }
        ws = null;
        ensureWs();
      }
    });
  } catch (e) {}
}

function ensureWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(relayUrl);
  } catch (e) {
    ws = null;
    return;
  }
  ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'hello' })); } catch (e) {} };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'chat') handleChat(msg);
  };
  ws.onclose = () => { ws = null; };
  ws.onerror = () => { try { ws.close(); } catch (e) {} ws = null; };
}

function respond(id, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(Object.assign({ id }, obj))); } catch (e) {}
  }
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
  if (msg.conversation !== 'new') {
    try {
      const { boundConversationId } = await chrome.storage.local.get('boundConversationId');
      if (boundConversationId) {
        const t = await chrome.tabs.get(tab.id);
        if (t.url && !t.url.includes('/c/' + boundConversationId)) {
          await chrome.tabs.update(tab.id, { url: 'https://chatgpt.com/c/' + boundConversationId });
          await waitForTabLoad(tab.id, 15000);
        }
      }
    } catch (e) {}
  }

  const payload = {
    type: 'chat',
    message: msg.message,
    conversation: msg.conversation,
    timeoutMs: msg.timeoutMs,
    file: msg.file
  };

  try {
    const r = await sendToTab(tab.id, payload);
    if (r && r.error) respond(msg.id, { type: 'error', error: r.error });
    else respond(msg.id, { type: 'result', markdown: (r && r.markdown) || '', attachments: (r && r.attachments) || [], failed: (r && r.failed) || [] });
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
    if (area === 'local' && changes.relayUrl) loadConfig();
  });
} catch (e) {}

chrome.runtime.onStartup.addListener(ensureWs);
chrome.runtime.onInstalled.addListener(ensureWs);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'ping') return;
  ensureWs();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
  }
});
