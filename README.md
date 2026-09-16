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
| Tools | `tools/` | `test-parse.js` + `test-artifacts.js` + `test-protocol.js` + `test-netdiag.js` (unit tests incl. the cross-file protocol-version pair check, `npm test`), `ask.js` / `ask-debug.js` (CLI helpers for testing the bridge end-to-end). |

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

⚠️ **Do NOT validate the bridge with a short message** (`ping` → `Pong!`). Short
replies only ever produce one stream fragment, so they look fine even when the
reply path is broken. Always validate with a request that forces a LONG reply:

```bash
curl -s http://127.0.0.1:8742/api/chat -H "Content-Type: application/json" -d '{"message":"从1数到30，用逗号分隔，只输出数字。"}'
```

You should get back all of `1,2,...,30`. If the reply comes back truncated,
re-run with `"debug":true` added to the body — the result then also includes
`rawSample` (the first 20k chars of the raw captured stream) and `rawLen`, which
show exactly what the network layer saw.

Offline unit tests for the parser (no browser needed):

```bash
npm test
```

## Tools

### `chatgpt_send(message, file?, conversation?, timeoutMs?, saveTo?, debug?)`

Sends a message and returns a JSON object:

```json
{
  "reply": "ChatGPT's reply as Markdown",
  "attachments": [{ "filename": "plan.md", "content": "# Plan\n..." }],
  "failed": [{ "filename": "x.md", "error": "attachment read timed out after 15000ms (canvas did not open or showed no new content; canvases before=1 after=1 newOrChanged=0)" }],
  "blockedFeatures": [{ "name": "file_upload", "resetsAfter": "2026-09-18T01:03:13Z", "description": "你目前已用完附件额度。" }],
  "savedPaths": ["C:/docs/result.md", "C:/docs/plan.md"]
}
```

`blockedFeatures` is non-empty when ChatGPT itself blocked a feature for the
account (typically the attachment quota: `"name": "file_upload"` with a
`resetsAfter` timestamp and a human-readable `description`). Check it before
assuming the model ignored an uploaded file or declined to produce one — the
reply text alone looks like a normal answer in that case.

| Arg | Description |
|-----|-------------|
| `message` (required) | The message to send. |
| `file` | Optional absolute path to a `.md` file to upload (e.g. a result for review). Only `.md`. |
| `conversation` | `new` to start a fresh chat (first message of a work session), `continue` (default) to keep the bound conversation. |
| `timeoutMs` | Max wait in ms (default 240000, hard cap 10 minutes). |
| `saveTo` | Optional path; saves the reply there and any attachments into the same folder. Collision-safe: a file that already exists on disk (or repeats within one run) gets a numeric suffix — `plan.md` → `plan (1).md` — instead of being overwritten. |
| `debug` | Diagnostic mode: the result also contains `rawSample` (first 20k chars of the raw captured stream) and `rawLen`. Use only when debugging reply truncation or parsing. |

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
| `BRIDGE_TOKEN` | _(unset)_ | Optional shared secret. When set, HTTP clients must send it as the `x-bridge-token` header and the extension must store it (see Security below). |

If you change the port, update the extension too (see `background.js`
`DEFAULT_RELAY_URL`, or set `chrome.storage.local` `relayUrl`).

## Security

The relay binds to `127.0.0.1` and enforces three defenses out of the box:

1. **Host check** — the `Host` header must be loopback, which blocks
   DNS-rebinding attacks.
2. **Origin check** — requests carrying a browser `Origin` header are only
   accepted from browser extensions (`chrome-extension://`). Ordinary web pages
   can therefore neither call the HTTP API nor open the WebSocket — even though
   browsers don't apply CORS to WebSockets or "simple" POSTs. Non-browser
   clients (curl, Node) send no `Origin` and are unaffected.
3. **Optional token** — set `BRIDGE_TOKEN` to require a shared secret:
   - MCP / HTTP: start the relay **and** the MCP server with the same
     `BRIDGE_TOKEN` value; the MCP sends it as `x-bridge-token`.
   - Extension: in the extension's service-worker console run
     `chrome.storage.local.set({ bridgeToken: 'your-secret' })` — it is
     appended to the WebSocket URL as `?token=`.

Remaining risk: any process running under **your own user account** on the same
machine can still talk to the relay (it has no OS-level identity). That is the
standard localhost trust boundary; don't run untrusted local software alongside
it, and never expose the port to the network.

Test with a token enabled:

```bash
curl -s http://127.0.0.1:8742/api/chat -H "Content-Type: application/json" -H "x-bridge-token: your-secret" -d '{"message":"hello"}'
```

## Troubleshooting

- **`no browser extension connected`** — the relay has no WebSocket client. Load
  the extension and open/log in to chatgpt.com; confirm the relay logged
  `extension connected`.
- **`no ChatGPT tab open`** — open a chatgpt.com tab (logged in) and retry.
- **`content script not ready`** — after an extension reload the tab may lack the
  script; the bridge auto-injects and retries. If it still fails, reload the tab.
- **Reply is missing / parse failed** — the backend's streaming format changed.
  The error will include a raw sample; the parser lives in `extension/injected.js`
  (`mergeInto` / `collectText` / `assemble`), with unit tests in `tools/test-parse.js`.
- **`injected.js is an old version` / MAIN world not active** — the extension was
  reloaded without refreshing the ChatGPT tab; refresh the tab (F5). The content
  script fails loudly on this protocol-version mismatch instead of silently
  parsing with stale capture code.
- **`EADDRINUSE`** — an old relay is still running; stop it first (the relay now
  prints the exact command).
- **`message was not sent — no conversation request observed`** — the submit
  confirmation gave up, usually because a file upload settled slowly (the
  confirmation window now scales with the remaining request budget, 12–60s).
  The message MAY actually have been delivered after the check gave up — do
  not blindly resend. The composer (text + file chips) is cleared
  automatically after this error, and defensively at the start of the next
  request, so half-composed state cannot leak into the next conversation.
- **`timed out waiting for network reply (Ns)`** — the reply stream never
  completed within the budget. The message may carry a `bridge diagnostics:`
  suffix (from the page-side network scratchpad). Four states are
  distinguishable:
  - `saw HTTP 403 (text/html) … likely a challenge/limit page` — the
    conversation endpoint answered with a challenge/limit page instead of the
    stream: refresh the tab, wait, retry later.
  - `accepted the request (HTTP 200) but sent no chunk at all — the stream
    went silent` — sent, accepted, then silent (this state used to be
    indistinguishable from "extension older than v1.2.9").
  - `N reply chunk(s) received, last Xs ago` — the stream is alive: N large
    with X small means slow; N frozen with X growing means it stopped.
  - no suffix — nothing was observed, or the extension is older than v1.2.9.
- **HTTP 403 from the relay** — a `BRIDGE_TOKEN` is set on the relay but the
  client didn't send it. Match the token on the MCP (`BRIDGE_TOKEN` env var)
  and in the extension (`chrome.storage.local.set({ bridgeToken: ... })`).

## Known limitations

- **`.md` file upload** (`file` arg) relies on the `DataTransfer` trick, which
  some ChatGPT versions reject. Prefer sending results as text.
- **Canvas document attachments** (when ChatGPT generates a real `.md` file) are
  captured best-effort by reading the canvas editor; this can also break when
  ChatGPT changes its DOM. Each file is clicked once (targets are deduplicated
  by normalized filename — a "下载 x.md" / "Download x.md" download link and
  its "x.md" chip are the same file), cards inside your own message — i.e.
  files you uploaded — are
  skipped, and every read is bound to its click: only a canvas that is new or
  changed relative to the pre-click snapshot counts, so a canvas left open by
  an earlier request can never shadow a later capture. Card selection is bound
  to the submit too: only cards that appear AFTER the message was submitted are
  captured, so document cards from earlier turns of a continued conversation
  are never re-read as this reply's attachments. For a robust loop, ask
  ChatGPT to output the plan as plain text.
- ChatGPT-internal citation markers (`filecite …` phrases wrapped in private-use
  sentinel characters) are stripped from replies before delivery. The same
  applies to the `:::writing{variant="document" …}` … `:::` canvas directive
  wrapper that leaks into raw stream text when the answer is produced in
  document/canvas mode: the wrapper lines are removed and the body is kept
  (an edge case remains — a bare `:::writing{…}` line inside a fenced code
  block in the reply body would be stripped too, which is not known to occur).
- ChatGPT's frontend changes often. The reply path is network-based and more
  robust than DOM scraping — it survives class-name changes and handles both
  full-snapshot and `delta_encoding: v1` incremental streams — but any protocol
  change can still require parser updates. After unusual truncation, run
  `npm test` and re-check with `debug: true` to capture a raw stream sample.

## Disclaimer

Automating the ChatGPT web UI may violate OpenAI's Terms of Service and carries
account-risk. Use at your own risk, keep request frequency low, and prefer this
for personal/experimental use.
