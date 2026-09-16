// chatgpt-bridge · MCP server (stdio transport)
//
// A minimal Model Context Protocol (MCP) server that AI tools (Claude Code,
// Codex, WorkBuddy, ...) connect to over stdio. It exposes two tools:
//
//   - `chatgpt_send`          — send a message to ChatGPT in the browser and get
//                               the Markdown reply (+ optional .md file upload,
//                               + optional save-to-disk).
//   - `chatgpt_bridge_status` — check whether the relay is running and whether a
//                               browser extension is connected, WITHOUT sending
//                               anything to ChatGPT.
//
// It implements just enough of JSON-RPC 2.0 over stdio for MCP to work:
// `initialize`, `tools/list`, `tools/call`, plus a couple of no-op notifications.
// No external dependencies beyond Node's built-ins (fs/path/readline/fetch).
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// The relay HTTP endpoint. Override with BRIDGE_RELAY if you changed the port.
const RELAY = process.env.BRIDGE_RELAY || 'http://127.0.0.1:8742';

// Absolute path to the relay entrypoint. Used to tell the AI tool the exact
// command to run when the relay is not running (self-service startup).
const RELAY_PATH = path.join(__dirname, '..', 'relay', 'server.js');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const CHAT_TOOL = {
  name: 'chatgpt_send',
  description:
    'Send a message to ChatGPT open in your browser and get its reply. ' +
    'Returns JSON: { reply, attachments:[{filename,content}], failed:[{filename,error}], savedPaths:[...] }. ' +
    'Useful for a planner-executor loop: send a task/result, get back a Markdown plan or next task. ' +
    'Notes: ' +
    '(1) attachments[].content already contains the FULL file content — do NOT ask ChatGPT to also paste it inline; keep the reply text short. ' +
    '(2) Verify connectivity with chatgpt_bridge_status BEFORE sending — do NOT send test messages. ' +
    '(3) If the relay is not running, start it yourself first with: node "' + RELAY_PATH + '" (or npm start in that folder).',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message/prompt to send to ChatGPT.' },
      file: {
        type: 'string',
        description: 'Optional absolute path to a .md file to upload to ChatGPT (e.g. your work result for review). Only .md is supported.'
      },
      conversation: {
        type: 'string',
        enum: ['continue', 'new'],
        description: "new: start a fresh chat (use for the first message of a new work session); continue: keep the bound conversation (default)."
      },
      timeoutMs: { type: 'number', description: 'Max wait time in ms (default 240000).' },
      saveTo: {
        type: 'string',
        description: 'Optional absolute path. If set, saves the reply to this file and any attachments into the same folder (collision-safe: same-name files get a numeric suffix).'
      }
    },
    required: ['message']
  }
};

const STATUS_TOOL = {
  name: 'chatgpt_bridge_status',
  description:
    'Check bridge connectivity WITHOUT sending anything to ChatGPT: whether the local relay is running and whether a browser extension is connected. ' +
    'Use this instead of sending test messages. If the relay is not running, it returns the exact command to start it.',
  inputSchema: { type: 'object', properties: {} }
};

// Query the relay's /health endpoint. Never touches ChatGPT.
async function checkStatus() {
  try {
    const res = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(5000) });
    const data = await res.json().catch(() => ({}));
    return {
      relayRunning: true,
      extensionConnected: !!(data && data.clients > 0),
      clientCount: (data && data.clients) || 0
    };
  } catch {
    return {
      relayRunning: false,
      extensionConnected: false,
      hint: 'relay not running. Start it with: node "' + RELAY_PATH + '" (or npm start in that folder)',
      startCommand: 'node "' + RELAY_PATH + '"'
    };
  }
}

// The main chat operation: optionally read an .md file, POST to the relay,
// and (optionally) save the reply + attachments to disk.
async function callChatgpt(args) {
  // Optional .md file upload (e.g. submitting a work result for review).
  let file = null;
  if (args.file) {
    try {
      file = { filename: path.basename(args.file), content: fs.readFileSync(args.file, 'utf8') };
    } catch (e) {
      return { isError: true, text: 'cannot read upload file: ' + (e.message || e) };
    }
    if (!/\.md$/i.test(file.filename)) {
      return { isError: true, text: 'only .md files can be uploaded, got: ' + file.filename };
    }
  }

  let res;
  // Give the relay a little more time than it gives ChatGPT, so a slow reply
  // times out cleanly on the relay side first and we always get a response.
  const chatTimeout = Math.max(30000, (Number(args.timeoutMs) || 240000) + 30000);
  try {
    res = await fetch(RELAY + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: args.message,
        file,
        conversation: args.conversation,
        timeoutMs: args.timeoutMs
      }),
      signal: AbortSignal.timeout(chatTimeout)
    });
  } catch (e) {
    return { isError: true, text: 'cannot reach relay at ' + RELAY + ' — start it with: node "' + RELAY_PATH + '" (or npm start). error: ' + (e.message || e) };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { isError: true, text: data.error || ('HTTP ' + res.status) };

  const reply = data.markdown || '';
  const attachments = data.attachments || [];
  const failed = data.failed || [];
  const savedPaths = [];

  // Optionally persist the reply and any attachments to disk.
  if (args.saveTo) {
    const target = path.resolve(args.saveTo);
    try {
      const dir = path.dirname(target);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

      // Track written paths to avoid collisions: if an attachment has the same
      // name as the reply file (or another attachment), append a numeric suffix.
      const used = new Set();
      fs.writeFileSync(target, reply, 'utf8');
      used.add(target);
      savedPaths.push(target);

      for (const att of attachments) {
        if (!att || !att.filename || att.content == null) continue;
        let attPath = path.join(dir, path.basename(att.filename));
        let n = 1;
        while (used.has(attPath)) {
          const ext = path.extname(att.filename);
          const base = path.basename(att.filename, ext);
          attPath = path.join(dir, `${base} (${n++})${ext}`);
        }
        fs.writeFileSync(attPath, att.content, 'utf8');
        used.add(attPath);
        savedPaths.push(attPath);
      }
    } catch (e) {
      return { isError: true, text: 'ChatGPT replied but saving files failed: ' + (e.message || e) };
    }
  }

  return { isError: false, reply, attachments, failed, savedPaths };
}

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chatgpt-bridge', version: '1.0.0' }
      }
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [CHAT_TOOL, STATUS_TOOL] } });
  }

  if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const toolName = params && params.name;

    // Explicitly handle the status tool; unknown tools are rejected rather than
    // silently falling through to chatgpt_send.
    if (toolName === 'chatgpt_bridge_status') {
      const s = await checkStatus();
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }], isError: false } });
    }
    if (toolName && toolName !== 'chatgpt_send') {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + toolName } });
    }

    const r = await callChatgpt(args);
    const text = r.isError
      ? r.text
      : JSON.stringify({ reply: r.reply, attachments: r.attachments, failed: r.failed, savedPaths: r.savedPaths }, null, 2);
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], isError: r.isError }
    });
  }

  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });

  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
});
