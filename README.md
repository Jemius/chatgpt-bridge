# ChatGPT Bridge

Let CLI AI tools — **Claude Code**, **Codex**, **WorkBuddy**, and any MCP client —
send messages to **ChatGPT in your browser** and receive the Markdown reply back.
No API key required: it reuses your existing logged-in ChatGPT session.

A typical use is a **planner–executor loop**: the AI asks ChatGPT for a project
plan, gets it back as Markdown, does the work, submits the result for review,
and gets the next task — all through the browser.

```
AI tool (Claude Code / Codex / WorkBuddy)
   │  MCP (tools: chatgpt_send, chatgpt_bridge_status)
   ▼
MCP server (mcp/index.js, stdio)      ← reads .md files, saves results
   │  HTTP POST /api/chat
   ▼
Relay (relay/server.js, 127.0.0.1:8742)  ← WebSocket /ws + HTTP /api/chat
   │  WebSocket
   ▼
Browser extension (extension/, MV3)     ← background WS client, content script automation
   │  DOM automation + fetch interception
   ▼
ChatGPT web (chatgpt.com)              ← paste/send, read reply from the network
```

## Why "bridge the browser" instead of the API

ChatGPT's web UI has features that aren't always available (or are differently
priced) via the API, and it reuses a session you already have. The trade-off is
that it's a DOM/network automation against a frequently-changing frontend, and it
carries the usual automation risks (see **Disclaimer**).

## Architecture

| Component | Path | Role |
|-----------|------|------|
| Relay | `relay/server.js` | Local HTTP + WebSocket server that queues requests and matches replies. |
| MCP server | `mcp/index.js` | Stdio MCP server exposing `chatgpt_send` and `chatgpt_bridge_status`. |
| Extension background | `extension/background.js` | WebSocket client; routes requests to the ChatGPT tab. |
| Extension content | `extension/content.js` | DOM automation: paste message, submit, capture attachments. |
| Extension injected | `extension/injected.js` | MAIN-world script that hooks `fetch` to read the streaming reply. |

The key design decision: the **reply is read from the network layer** (by
intercepting ChatGPT's `fetch` calls) rather than by scraping page class names,
which ChatGPT changes frequently and broke repeatedly during development.

## Quick start

### 1. Install and start the relay

```bash
cd chatgpt-bridge
npm install        # installs the single dependency (ws)
npm start          # or double-click start-relay.cmd on Windows
```

Keep it running. You should see:

```
[relay] WebSocket: ws://127.0.0.1:8742/ws
[relay] HTTP API:  http://127.0.0.1:8742/api/chat
```

### 2. Load the extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Open https://chatgpt.com and log in.

The relay should now log `extension connected`.

> **Tip — dedicated browser profile.** To keep the AI's conversation from
> mixing with your own, load the extension in a **separate browser profile** (or
> a separate browser), ideally with its own ChatGPT account. The bridge also
> remembers the conversation it is working in and navigates back to it on
> `continue`, so it won't pollute your other chats.

### 3. Wire the MCP into your AI tool

The MCP server is `mcp/index.js` (Node, stdio, zero dependencies).

- **WorkBuddy** — add to `~/.workbuddy/mcp.json`:
  ```json
  {
    "mcpServers": {
      "chatgpt-bridge": {
        "command": "node",
        "args": ["C:\\path\\to\\chatgpt-bridge\\mcp\\index.js"]
      }
    }
  }
  ```
- **Claude Code** — `claude mcp add chatgpt-bridge -- node "C:\path\to\chatgpt-bridge\mcp\index.js"`
- **Codex** — `codex mcp add chatgpt-bridge -- node "C:\path\to\chatgpt-bridge\mcp\index.js"`

> If `node` isn't on PATH for the tool, use an absolute path such as
> `C:\Program Files\nodejs\node.exe`.

### 4. Test

```bash
curl -s http://127.0.0.1:8742/api/chat -H "Content-Type: application/json" -d '{"message":"hello"}'
```

You should get back `{"ok":true,"markdown":"Hello! ..."}`.

## Tools

### `chatgpt_send(message, file?, conversation?, timeoutMs?, saveTo?)`

Sends a message and returns a JSON object:

```json
{
  "reply": "ChatGPT's reply as Markdown",
  "attachments": [{ "filename": "plan.md", "content": "# Plan\n..." }],
  "failed": [{ "filename": "x.md", "error": "attachment read timed out" }],
  "savedPaths": ["C:/docs/result.md", "C:/docs/plan.md"]
}
```

| Arg | Description |
|-----|-------------|
| `message` (required) | The message to send. |
| `file` | Optional absolute path to a `.md` file to upload (e.g. a result for review). Only `.md`. |
| `conversation` | `new` to start a fresh chat (first message of a work session), `continue` (default) to keep the bound conversation. |
| `timeoutMs` | Max wait in ms (default 240000). |
| `saveTo` | Optional path; saves the reply there and any attachments into the same folder (collision-safe). |

### `chatgpt_bridge_status()`

Checks whether the relay is running and whether an extension is connected —
**without sending anything to ChatGPT**. Use this instead of probing with a test
message. If the relay is down, it returns the exact command to start it.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `8742` | Relay port (WebSocket + HTTP). |
| `HOST` | `127.0.0.1` | Bind address. **Keep it localhost.** |
| `BRIDGE_RELAY` | `http://127.0.0.1:8742` | Relay URL the MCP server calls. |

If you change the port, update the extension too (see `background.js`
`DEFAULT_RELAY_URL`, or set `chrome.storage.local` `relayUrl`).

## Security

⚠️ **The relay has no authentication and must stay bound to `127.0.0.1`.** On a
single-user machine the main risk is a malicious *local* process (or a webpage
that talks to localhost) sending messages on your behalf. Do **not** expose the
port to the network, and do not use this on a multi-user/shared machine without
understanding that risk.

## Troubleshooting

- **`no browser extension connected`** — the relay has no WebSocket client. Load
  the extension and open/log in to chatgpt.com; confirm the relay logged
  `extension connected`.
- **`no ChatGPT tab open`** — open a chatgpt.com tab (logged in) and retry.
- **`content script not ready`** — after an extension reload the tab may lack the
  script; the bridge auto-injects and retries. If it still fails, reload the tab.
- **Reply is missing / parse failed** — the backend's streaming format changed.
  The error will include a raw sample; see `extension/injected.js` `parseReply`.
- **`EADDRINUSE`** — an old relay is still running; stop it first (the relay now
  prints the exact command).

## Known limitations

- **`.md` file upload** (`file` arg) relies on the `DataTransfer` trick, which
  some ChatGPT versions reject. Prefer sending results as text.
- **Canvas document attachments** (when ChatGPT generates a real `.md` file) are
  captured best-effort by reading the canvas editor; this can also break when
  ChatGPT changes its DOM. For a robust loop, ask ChatGPT to output the plan as
  plain text.
- ChatGPT's frontend changes often; the reply path is network-based and stable,
  but the DOM-automation parts (paste, submit, upload) may need selector updates.

## Disclaimer

Automating the ChatGPT web UI may violate OpenAI's Terms of Service and carries
account-risk. Use at your own risk, keep request frequency low, and prefer this
for personal/experimental use.
