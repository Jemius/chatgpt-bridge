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
// Security note: this relay has NO authentication and listens on 127.0.0.1 by
// default. It is intended for personal, single-machine use only. Do not bind it
// to a public interface (see the README "Security" section).
const http = require('http');
const { WebSocketServer } = require('ws');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8742);

// Maximum accepted request body size (10 MB). Protects the relay from a local
// process (or webpage) that floods it with a huge body.
const MAX_BODY = 10 * 1024 * 1024;

// Maximum wait time for a single chat request (10 minutes). Prevents a stuck
// request from holding memory/connections forever.
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

// Connected extension WebSocket clients. The relay only needs ONE client (the
// browser extension), but multiple may connect briefly (e.g. several browser
// profiles). Requests are delivered to the first connected client only.
const clients = new Set();

// In-flight requests: requestId -> { resolve, timer }.
const pending = new Map();

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Reject every pending request with the given error. Called when the last
// extension disconnects and does not reconnect within the grace period.
function failAllPending(error) {
  for (const [id, p] of pending) {
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ ok: false, error });
  }
}

const server = http.createServer((req, res) => {
  // Prevent an aborted/invalid client connection from crashing the process.
  req.on('error', () => {});
  res.on('error', () => {});

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, clients: clients.size, pending: pending.size });
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
        req.destroy();
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

      console.log(`[relay] chat request: ${JSON.stringify(message).slice(0, 80)} (clients=${clients.size})`);
      if (clients.size === 0) {
        return sendJson(res, 503, {
          ok: false,
          error: 'no browser extension connected — load the extension and open chatgpt.com'
        });
      }

      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = Math.min(Number(input.timeoutMs) || 240000, MAX_TIMEOUT_MS);

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
          file: input.file, // optional .md file to upload (see MCP `file` arg)
          conversation: input.conversation === 'new' ? 'new' : 'continue'
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

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[relay] extension connected (${clients.size} client(s))`);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

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
            failed: msg.failed || []
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
