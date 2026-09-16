// chatgpt-bridge · local relay server
//
// A single localhost process that bridges CLI/AI tools (Claude Code, Codex,
// WorkBuddy, etc.) to the ChatGPT web UI running in your browser.
//
// It exposes two transports on the same port:
//   - HTTP  /api/chat  — receives a message from the MCP server, forwards it to
//                        the browser extension over WebSocket, and resolves with
//                        ChatGPT's Markdown reply.
//            /health   — returns connection status (used by the MCP "status" tool).
//   - WS    /ws        — the browser extension connects here and receives chat
//                        requests, then posts back the result.
//
// Data flow:
//   AI tool → MCP server → POST /api/chat → WebSocket → browser extension
//           → ChatGPT (via DOM automation + network interception) → Markdown
//           → back through the same chain.
//
// Security: the relay only accepts loopback-bound requests from the local
// machine. Because browsers let ANY webpage send requests to 127.0.0.1
// (WebSockets and simple POSTs are not subject to CORS), the relay enforces
// three cheap defenses — see the "Access control" block below:
//   1. Host header must be loopback (blocks DNS rebinding).
//   2. Requests carrying an Origin must come from a browser extension
//      (blocks web-page CSRF; curl/Node clients send no Origin at all).
//   3. Optional shared secret via the BRIDGE_TOKEN env var.
const http = require('http');
const { WebSocketServer } = require('ws');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8742);

// Optional shared secret. When set, HTTP clients must send it as the
// `x-bridge-token` header and the extension must append `?token=` to the WS URL.
const TOKEN = process.env.BRIDGE_TOKEN || '';

// Maximum accepted request body size (10 MB). Protects the relay from a local
// process (or webpage) that floods it with a huge body.
const MAX_BODY = 10 * 1024 * 1024;

// Maximum size of a single chat message pasted into the editor (200 KB). Very
// long content belongs in a .md file attachment, not in the composer.
const MAX_MESSAGE = 200 * 1024;

// Maximum wait time for a single chat request (10 minutes). Prevents a stuck
// request from holding memory/connections forever.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

// Maximum size of a single WS message (10 MB, aligned with MAX_BODY). Result
// messages carry attachments in full, so this must stay generous — but a limit
// prevents a misbehaving local client from ballooning memory without bound.
const MAX_WS_PAYLOAD = 10 * 1024 * 1024;

// Maximum concurrent in-flight chat requests. A runaway local loop could
// otherwise stack unbounded pending entries (each holding timers + memory).
const MAX_PENDING = 50;

// Connected extension WebSocket clients. The relay only needs ONE client (the
// browser extension), but multiple may connect briefly (e.g. several browser
// profiles). Requests are delivered to the first connected client only.
const clients = new Set();

// In-flight requests: requestId -> { resolve, timer }.
const pending = new Map();

// Relay version, read once from package.json. Shown in /health so a caller can
// tell at a glance WHICH relay build is running (the most expensive unknown
// during past debugging rounds).
const RELAY_VERSION = require('../package.json').version;

// Last reported extension identity from the WS `hello` handshake. Null fields
// mean "an extension connected that does not send version info yet" (pre-1.2.11
// builds). Kept after disconnect on purpose: "last known" beats "unknown".
let extInfo = { version: null, protocol: null, seenAt: null };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Reject every pending request with the given error. Called when the last
// extension disconnects and does not reconnect within the grace period, and on
// graceful shutdown.
function failAllPending(error) {
  for (const [id, p] of pending) {
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ ok: false, error });
  }
}

// ---- Access control --------------------------------------------------------
// The HOST header check only applies when the relay is actually bound to a
// loopback address (the default); a deliberately LAN-bound relay stays usable.
const HOST_IS_LOOPBACK = /^(127\.|localhost|\[::1\]|::1)/i.test(HOST);

function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host || '');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;                       // non-browser client (curl, Node, ...)
  if (origin === 'null') return false;            // sandboxed iframe / opaque origin
  // Any chrome-extension:// origin passes — the browser guarantees web pages
  // cannot forge this scheme, but it does NOT identify WHICH extension is
  // talking. A malicious extension could connect; set BRIDGE_TOKEN if you
  // need stronger isolation than the localhost trust boundary.
  return /^chrome-extension:\/\//i.test(origin);
}

function rejectHttp(res, error) {
  sendJson(res, 403, { ok: false, error });
  return false;
}

// Gate for the HTTP endpoints. Returns true when the request may proceed.
function checkHttpAuth(req, res) {
  if (HOST_IS_LOOPBACK && !isLoopbackHost(req.headers.host)) {
    return rejectHttp(res, 'forbidden: Host header is not loopback (DNS-rebinding protection)');
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return rejectHttp(res, 'forbidden: web pages may not call this API');
  }
  if (TOKEN && req.headers['x-bridge-token'] !== TOKEN) {
    return rejectHttp(res, 'forbidden: missing or wrong x-bridge-token header (set BRIDGE_TOKEN, see README)');
  }
  return true;
}

const server = http.createServer((req, res) => {
  // Prevent an aborted/invalid client connection from crashing the process.
  req.on('error', () => {});
  res.on('error', () => {});

  if (!checkHttpAuth(req, res)) return;

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      clients: clients.size,
      pending: pending.size,
      relay: { version: RELAY_VERSION },
      extension: extInfo
    });
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    // Accumulate body chunks as Buffers, then decode once as UTF-8. This avoids
    // corrupting multi-byte characters (e.g. Chinese) that arrive split across
    // TCP chunks — the naive `body += chunk` string concatenation breaks them.
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        sendJson(res, 413, { ok: false, error: 'request body too large' });
        // Tear the connection down only AFTER the 413 has been flushed, so the
        // client actually receives the error instead of a connection reset.
        res.on('finish', () => { try { req.destroy(); } catch {} });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (tooLarge || res.writableEnded) return;

      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }

      const message = String(input.message || '');
      if (!message) return sendJson(res, 400, { ok: false, error: 'message is required' });
      if (message.length > MAX_MESSAGE) {
        return sendJson(res, 413, {
          ok: false,
          error: `message too large (${message.length} chars, max ${MAX_MESSAGE}) — send long content as a .md file attachment instead`
        });
      }

      // Log a bounded slice of the ORIGINAL string: JSON.stringify-ing the
      // whole message first cost memory on huge bodies and echoed user
      // content into the log. BRIDGE_LOG_BODY=0 keeps only the length.
      const reqDesc = process.env.BRIDGE_LOG_BODY === '0'
        ? `(${message.length} chars)`
        : message.slice(0, 80);
      console.log(`[relay] chat request: ${reqDesc} (clients=${clients.size})`);
      if (clients.size === 0) {
        return sendJson(res, 503, {
          ok: false,
          error: 'no browser extension connected — load the extension and open chatgpt.com'
        });
      }
      if (pending.size >= MAX_PENDING) {
        return sendJson(res, 503, {
          ok: false,
          error: `relay busy: ${pending.size} requests in flight (max ${MAX_PENDING}) — retry later`
        });
      }

      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Clamp on both ends: a negative/zero timeoutMs used to reach setTimeout
      // unclamped and fire immediately; the floor keeps callers from doing
      // that by accident. (The extension budgets its phases against this.)
      const timeoutMs = Math.max(5000, Math.min(Number(input.timeoutMs) || 240000, MAX_TIMEOUT_MS));

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: `timed out waiting for ChatGPT (${timeoutMs}ms)` });
        }, timeoutMs);
        pending.set(id, { resolve, timer });

        const payload = JSON.stringify({
          type: 'chat',
          id,
          message,
          timeoutMs,
          // Absolute deadline (relay clock). The extension budgets ALL of its
          // remaining phases (reply wait + attachment capture) against this, so
          // it always answers before the relay gives up.
          deadline: Date.now() + timeoutMs,
          file: input.file, // optional .md file to upload (see MCP `file` arg)
          conversation: input.conversation === 'new' ? 'new' : 'continue',
          // `debug: true` makes the extension return the raw captured stream
          // alongside the parsed reply — for diagnosing truncation/parse issues.
          debug: !!input.debug
        });

        // Deliver to a single client to avoid duplicate sends when multiple
        // browser profiles each have the extension connected.
        for (const ws of clients) {
          if (ws.readyState === 1) { ws.send(payload); break; }
        }
      });

      console.log(`[relay] result ${id}: ok=${result.ok}${result.ok ? '' : ` error=${String(result.error).slice(0, 100)}`}`);
      return sendJson(res, 200, result);
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

// Malformed HTTP connections should not crash the server.
server.on('clientError', (_err, socket) => {
  try { socket.destroy(); } catch {}
});

// Give a friendly hint on the common "port already in use" failure instead of
// an unhandled crash.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[relay] port ${PORT} is already in use. Stop the old relay first.`);
    console.error(`[relay] find it:  netstat -ano | findstr :${PORT}`);
    console.error('[relay] kill it:   taskkill /PID <pid> /F');
  } else {
    console.error('[relay] failed to start:', err && err.message);
  }
});

// The handshake is handled manually so we can reject non-extension clients:
// browsers do not apply CORS to WebSockets, so any webpage could otherwise
// connect to ws://127.0.0.1:8742/ws and impersonate the extension (and with
// single-client delivery, even intercept the message stream).
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  const reject = () => {
    try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch {}
    socket.destroy();
  };

  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { return reject(); }
  if (url.pathname !== '/ws') return reject();
  if (HOST_IS_LOOPBACK && !isLoopbackHost(req.headers.host)) return reject();
  if (!isAllowedOrigin(req.headers.origin)) return reject();
  // Browser WebSockets cannot set custom headers, so the extension
  // authenticates with a `?token=` query parameter instead. Header-based auth
  // is accepted too (for non-browser WS clients). Ignored when TOKEN is empty.
  if (TOKEN && url.searchParams.get('token') !== TOKEN && req.headers['x-bridge-token'] !== TOKEN) {
    return reject();
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[relay] extension connected (${clients.size} client(s))`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'hello') {
      // v1.2.11: the extension reports its own version (and the capture
      // protocol it expects) on connect, so /health can answer "which build
      // is running". Old extensions send {type:'hello'} only — fields stay null.
      extInfo = {
        version: typeof msg.version === 'string' ? msg.version : null,
        protocol: msg.protocol == null ? null : String(msg.protocol),
        seenAt: Date.now()
      };
      console.log(`[relay] extension hello: version=${extInfo.version} protocol=${extInfo.protocol}`);
      return;
    }

    if (msg.type === 'result' || msg.type === 'error') {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.type === 'result') {
          p.resolve({
            ok: true,
            markdown: msg.markdown || '',
            attachments: msg.attachments || [],
            failed: msg.failed || [],
            // N-14: ChatGPT-side feature blocks (e.g. attachment quota) —
            // always forwarded so callers can detect refusals without debug.
            blockedFeatures: msg.blockedFeatures || [],
            // only present when the caller asked for debug
            rawSample: msg.rawSample,
            rawLen: msg.rawLen
          });
        } else {
          p.resolve({ ok: false, error: msg.error || 'unknown error' });
        }
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[relay] extension disconnected');
    // Give the extension a few seconds to reconnect (service workers restart)
    // before failing any in-flight requests, so a brief blip doesn't kill them.
    if (clients.size === 0) {
      setTimeout(() => {
        if (clients.size === 0) failAllPending('extension disconnected');
      }, 5000);
    }
  });

  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`[relay] WebSocket: ws://${HOST}:${PORT}/ws`);
  console.log(`[relay] HTTP API:  http://${HOST}:${PORT}/api/chat`);
});

// Graceful shutdown: answer every pending caller with a clear error instead of
// dropping them, then close.
function shutdown() {
  console.log('[relay] shutting down…');
  failAllPending('relay is shutting down');
  for (const ws of clients) {
    try { ws.close(1001); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
