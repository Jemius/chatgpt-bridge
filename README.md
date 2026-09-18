# ChatGPT Bridge

让命令行 AI 工具——**Claude Code**、**Codex**、**WorkBuddy** 以及任何 MCP 客户端——
把消息发送到**你浏览器里的 ChatGPT**，并取回 Markdown 格式的回复。
无需 API key：它复用你已有的 ChatGPT 登录会话。

典型用法是**规划–执行循环**：AI 向 ChatGPT 要一份项目计划，拿到 Markdown 回复，
本地完成工作后把结果交回给它审阅，再领下一个任务——全程通过浏览器完成。

```
AI 工具 (Claude Code / Codex / WorkBuddy)
   │  MCP (工具: chatgpt_send, chatgpt_bridge_status)
   ▼
MCP 服务 (mcp/index.js, stdio)          ← 读取 .md 文件、保存结果
   │  HTTP POST /api/chat
   ▼
中继 Relay (relay/server.js, 127.0.0.1:8742)  ← WebSocket /ws + HTTP /api/chat
   │  WebSocket
   ▼
浏览器扩展 (extension/, MV3)             ← background 是 WS 客户端，content script 负责 DOM 自动化
   │  DOM 自动化 + fetch 拦截
   ▼
ChatGPT 网页 (chatgpt.com)              ← 粘贴/发送，从网络层读取回复
```

## 为什么「桥接浏览器」而不走 API

ChatGPT 网页版的部分功能在 API 上并不总是可用（或定价不同），而且它复用你
已有的会话。代价是：这是一套针对频繁变化前端的 DOM/网络自动化，带有自动化
操作的固有风险（见**免责声明**）。

## 架构

| 组件 | 路径 | 职责 |
|------|------|------|
| 中继 Relay | `relay/server.js` | 本地 HTTP + WebSocket 服务，排队请求并匹配回复。 |
| MCP 服务 | `mcp/index.js` | stdio MCP 服务，暴露 `chatgpt_send` 和 `chatgpt_bridge_status`。 |
| 扩展 background | `extension/background.js` | WebSocket 客户端；把请求路由到 ChatGPT 标签页。 |
| 扩展 content | `extension/content.js` | DOM 自动化：粘贴消息、提交、抓取附件。 |
| 扩展 injected | `extension/injected.js` | MAIN world 脚本，挂钩 `fetch` 以读取流式回复。 |
| 工具 | `tools/` | `test-parse.js` + `test-artifacts.js` + `test-protocol.js` + `test-netdiag.js` + `test-health.js`（单元测试，含跨文件协议版本配对检查和一个会拉起中继进程的 `/health` 集成测试，`npm test`），`ask.js` / `ask-debug.js`（端到端联调 CLI 工具）。 |

关键设计决策：**回复从网络层读取**（拦截 ChatGPT 的 `fetch` 调用），而不是
扒页面 class 名——后者 ChatGPT 经常改，开发期间已经反复弄坏过。

## 快速开始

### 1. 安装并启动中继

```bash
cd chatgpt-bridge
npm install        # 安装唯一依赖 (ws)
npm start          # Windows 下也可双击 start-relay.cmd
```

保持它运行。你应该看到：

```
[relay] WebSocket: ws://127.0.0.1:8742/ws
[relay] HTTP API:  http://127.0.0.1:8742/api/chat
```

### 2. 加载扩展

1. 打开 `chrome://extensions`（或 `edge://extensions`）。
2. 开启**开发者模式**。
3. 点**加载已解压的扩展程序**，选择 `extension/` 文件夹。
4. 打开 https://chatgpt.com 并登录。

中继此时应记录 `extension connected`。

> **建议——使用独立浏览器配置。** 为了避免 AI 的对话混入你自己的聊天，
> 请在**单独的浏览器配置文件**（或单独的浏览器）里加载扩展，最好用独立的
> ChatGPT 账号。桥接也会记住它正在使用的会话，`continue` 时会自动导航回
> 那个会话，不会污染你的其他聊天。

### 3. 把 MCP 接入你的 AI 工具

MCP 服务是 `mcp/index.js`（Node，stdio，零依赖）。

- **WorkBuddy** — 加入 `~/.workbuddy/mcp.json`：
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

> 如果该工具的 PATH 里没有 `node`，请用绝对路径，例如
> `C:\Program Files\nodejs\node.exe`。

### 4. 测试

⚠️ **不要用短消息验证桥接**（`ping` → `Pong!`）。短回复只会产生一个流片段，
即使回复链路已经断了看起来也一切正常。请始终用强制**长回复**的请求验证：

```bash
curl -s http://127.0.0.1:8742/api/chat -H "Content-Type: application/json" -d '{"message":"从1数到30，用逗号分隔，只输出数字。"}'
```

你应该取回完整的 `1,2,...,30`。如果回复被截断，在请求体里加上 `"debug":true`
重跑——结果会额外包含 `rawSample`（原始捕获流的前 2 万字符）和 `rawLen`，
能看出网络层到底看到了什么。

解析器的离线单元测试（无需浏览器）：

```bash
npm test
```

## 工具

### `chatgpt_send(message, file?, conversation?, timeoutMs?, saveTo?, debug?)`

发送一条消息并返回 JSON 对象：

```json
{
  "reply": "ChatGPT 的回复（Markdown）",
  "attachments": [{ "filename": "plan.md", "content": "# Plan\n..." }],
  "failed": [{ "filename": "x.md", "error": "attachment read timed out after 15000ms (canvas did not open or showed no new content; canvases before=1 after=1 newOrChanged=0)" }],
  "blockedFeatures": [{ "name": "file_upload", "resetsAfter": "2026-09-18T01:03:13Z", "description": "你目前已用完附件额度。" }],
  "savedPaths": ["C:/docs/result.md", "C:/docs/plan.md"]
}
```

`blockedFeatures` 非空表示 ChatGPT 自己对该账号屏蔽了某项功能（通常是附件
额度：`"name": "file_upload"`，带 `resetsAfter` 时间戳和人类可读的
`description`）。在断定「模型无视了上传的文件」或「拒绝产出附件」之前先看
它——这种情况下仅看回复文本像一条正常回答。

| 参数 | 说明 |
|------|------|
| `message`（必填） | 要发送的消息。 |
| `file` | 可选，要上传的 `.md` 文件的绝对路径（例如待审阅的结果）。仅支持 `.md`。 |
| `conversation` | `new` 开新会话（工作阶段的第一条消息），`continue`（默认）沿用已绑定的会话。 |
| `timeoutMs` | 最长等待毫秒数（默认 240000，钳制到 5 秒 – 10 分钟）。 |
| `saveTo` | 可选路径；把回复保存到该路径，附件存入同一文件夹。防覆盖：磁盘上已存在的文件（或同一次运行内重复的文件名）会加数字后缀——`plan.md` → `plan (1).md`——而不是被覆盖。 |
| `debug` | 诊断模式：结果额外包含 `rawSample`（原始捕获流前 2 万字符）和 `rawLen`。仅在排查回复截断或解析问题时使用。 |

### `chatgpt_bridge_status()`

检查中继是否在运行、扩展是否已连接——**不向 ChatGPT 发送任何东西**。用这个
代替测试消息探测。中继未启动时，它直接返回启动命令。它还转发版本可见性
字段（`relayVersion`，以及 `extension` 的 `version` / `protocol` /
`wireProtocol` / `seenAt` / `ageMs`），「实际跑的是哪个构建」在 status 工具
里就能回答。

自 v1.2.18 起，`driftWarning`（版本漂移告警）由 **relay 轴线协议号**
（中继侧的 `RELAY_WIRE_PROTOCOL` 对比扩展侧的 `BRIDGE_WIRE_PROTOCOL`）驱动，
而不是 semver：号相等即帧兼容，版本字符串说了不算——线协议兼容的构建之间
版本不同只会产生提示性的 `versionNotice`，不是告警。只有号真的不同（真正的
帧形状不兼容——重启中继**并且**重载扩展）、某一侧早于线协议号标记、或扩展
完全无法自报身份时才告警。维护者规则：relay↔extension 帧形状发生不兼容变更
时，两个线协议号必须一起 bump。

## 推荐的 agent 工作流（默认）

规划–执行循环两轮往返就够。不要每一步都和网页 UI 打乒乓——每一轮都消耗
真实时间和 token。

1. **要计划** — 用 `chatgpt_send` 发需求（不传 `conversation`；默认
   `continue` 会绑定会话）。
2. **本地干活。**
3. **交结果** — 再次 `chatgpt_send`，仍用默认 `continue`，进同一个会话：
   消息里放简短总结，长内容用 `.md` 文件附件。ChatGPT 审阅。完成。

经验法则：

- **第 1 步和第 3 步之间绝不传 `conversation: "new"`。** `new` 开新聊天，
  丢掉计划上下文，还要再花一遍 token。只有真正换任务、或用户明确要求新
  会话时才用 `new`。
- `continue` 会自动重新打开绑定的会话，即使标签页被关闭或导航走了。
- 不要发 `hello`/`test` 探测——`chatgpt_bridge_status` 免费且能回答连通性
  （还有版本漂移告警）。
- 请求失败并报会话重绑（session-rebinding）错误时，直接重试即可；桥接宁可
  拒绝提交也不会悄悄发进错误的页面另起新会话。

## 自动恢复（整页刷新重试，v1.2.17）

当请求在**提交步骤之前**死掉——页面协议过时、composer（输入框）始终没出现、
文件上传入口缺失——扩展现在会自愈：重载 ChatGPT 标签页（`injected.js` 随
页面重新加载、composer 重新创建），确认标签页仍在绑定的会话上，然后重试
提交**一次**。调用方什么都感知不到，除非重试也失败。

有意设置的硬性限制：

- **每个请求最多重试一次，绝不循环刷新。**
- **只重试「提交前」的失败。** 这些是桥接能证明「什么都没发出去」的失败。
  一旦提交按钮可能已经生效，错误就按「可能已发送」处理，**绝不**自动重试
  ——盲发可能把同一条消息发两遍。
- **预算门。** 只有请求 deadline 还剩至少 45 秒时才重试（刷新 + 页面加载 +
  等 composer 可能吃掉约 40 秒）；否则原样返回原始错误。
- **会话门。** 刷新后标签页必须回到绑定的会话（`/c/<id>`）；没回去就放弃
  重试，错误信息会说明。

重试过且仍失败的超时错误会带后缀 "(auto-recovery: the page was reloaded and
retried once — same error recurred)"，方便与未重试的失败区分。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `8742` | 中继端口（WebSocket + HTTP）。 |
| `HOST` | `127.0.0.1` | 绑定地址。**保持 localhost。** |
| `BRIDGE_RELAY` | `http://127.0.0.1:8742` | MCP 服务调用的中继 URL。 |
| `BRIDGE_TOKEN` | _(未设)_ | 可选共享密钥。设置后，HTTP 客户端必须以 `x-bridge-token` 头发送，扩展侧也要存它（见下方 Security）。 |
| `BRIDGE_LOG_BODY` | `1` | 设为 `0` 让中继日志只保留消息*长度*而不是前 80 字符（消息内容不允许出现在日志里时有用）。 |

中继强制的请求限额：请求体最大 **10 MB**，composer 消息最多 **9,999 字符**
——这是实测的 ChatGPT 网页端硬墙（2026-09-18 审计测得，边界经复核）：粘贴
**>= 10,000** 字符时 composer 静默拒绝并报误导性的 "composer is empty"，所以
中继直接快速失败返回 413 和真实原因（ChatGPT 若改了限制，可用
`BRIDGE_COMPOSER_LIMIT` 覆盖；更长的内容应放 `.md` 文件附件；非法的环境变量
值会响亮警告并回退默认值）。另外：`timeoutMs` 钳制到 **5 秒 – 10 分钟**，
并发在途请求最多 **50** 个，WebSocket 消息最大 **10 MB**，以及 **30 秒**的
服务端心跳——停止应答 ping 的连接会被终止（`BRIDGE_HEARTBEAT_MS=0` 可禁用）
——半开的 TCP 连接再也不能一边挂着绿灯一边把请求黑洞掉。

`/api/chat` 语义说明：传输层成功一律返回 HTTP **200**——业务结果在 JSON 体
的 `ok` 字段里（`false` = 超时 / 未发出 / 抓取失败）。请读 `ok`，别只看状态
码。非 200 保留给中继级拒绝：403 鉴权、413 超限、503 无扩展 / 忙碌。

改端口的话，扩展也要同步改（见 `background.js` 的 `DEFAULT_RELAY_URL`，或设
`chrome.storage.local` 的 `relayUrl`）。

## 安全

中继绑定 `127.0.0.1`，开箱即带三道防线：

1. **Host 检查** — `Host` 头必须是 loopback，可阻断 DNS-rebinding 攻击。
2. **Origin 检查** — 带浏览器 `Origin` 头的请求只接受浏览器扩展来源
   （`chrome-extension://`）。普通网页因此既调不了 HTTP API 也开不了
   WebSocket——即使浏览器对 WebSocket 和「简单」POST 不应用 CORS。非浏览器
   客户端（curl、Node）不带 `Origin`，不受影响。如实的边界说明：这证明的是
   「某个扩展」，不是「我们的扩展」——你浏览器里装的任何扩展都能过这道检查。
   若需要超出 localhost 信任边界的隔离，用下面的 token。
3. **可选 token** — 设置 `BRIDGE_TOKEN` 要求共享密钥：
   - MCP / HTTP：中继**和** MCP 服务用同一个 `BRIDGE_TOKEN` 值启动；MCP 会
     以 `x-bridge-token` 头发送。
   - 扩展：在扩展的 service-worker 控制台执行
     `chrome.storage.local.set({ bridgeToken: 'your-secret' })`——它会以
     `?token=` 追加到 WebSocket URL 上。

剩余风险：同一台机器上**你自己用户账户**下的任何进程仍能与中继通信（它没有
操作系统级身份）。这是标准的 localhost 信任边界；不要在旁边运行不受信任的
本地软件，也绝不要把端口暴露到网络上。

开启 token 后的测试：

```bash
curl -s http://127.0.0.1:8742/api/chat -H "Content-Type: application/json" -H "x-bridge-token: your-secret" -d '{"message":"hello"}'
curl -s http://127.0.0.1:8742/health -H "x-bridge-token: your-secret"
```

## 故障排查

- **「实际跑的是哪个构建？」** — `curl http://127.0.0.1:8742/health` 直接回答
  （v1.2.11+）。`relay.version` 是中继构建（启动时从 package.json 读取）；
  `extension.version` / `extension.protocol` / `extension.seenAt` 是扩展在
  WS `hello` 握手里最后上报的身份。扩展字段为 null 表示中继启动后连上的是
  pre-1.2.11 扩展（或什么都没连过）。该身份在断开后有意保留——「最后已知」
  优于「未知」——重载扩展（并重连）即可刷新。`extension.ageMs`（v1.2.13）
  是这条 hello 的**年龄**——有心跳在，长期连接的大 ageMs 完全健康。新鲜度
  信号是 `extension.lastPongMs`（v1.2.15）：距最近一次 WebSocket pong 的
  毫秒数，活链路上应保持很小。中继每 30 秒 ping 一次连接并终止不再应答的
  连接，半开 socket 会响亮失败而不是挂着绿灯。
- **组件间版本漂移** — 中继、扩展和 MCP 服务各自只加载一次版本，会各自漂
  移。`curl .../health` 能看两边的构建加线协议号；`chatgpt_bridge_status`
  只在**真兼容性信号**上发 `driftWarning`——线协议号不同、构建早于线协议号
  标记（v1.2.18）、或扩展无法自报身份。线协议兼容构建之间的版本差异只是
  `versionNotice`（提示），不是告警——v1.2.16 中继 + v1.2.17 扩展曾误报过
  一次。改完代码：重启中继（`start-relay.cmd` 现在会先杀掉占用端口的旧进程）
  并重载扩展。
- **`no browser extension connected`** — 中继没有 WebSocket 客户端。加载扩
  展并打开/登录 chatgpt.com；确认中继记录了 `extension connected`。
- **`no ChatGPT tab open`** — 打开一个（已登录的）chatgpt.com 标签页重试。
- **`content script not ready`** — 扩展重载后标签页可能缺脚本；桥接会自动
  注入并重试。仍失败就刷新标签页。
- **回复缺失 / 解析失败** — 后端流格式变了。错误里会带原始流样本；解析器在
  `extension/injected.js`（`mergeInto` / `collectText` / `assemble`），单元
  测试在 `tools/test-parse.js`。
- **`injected.js is an old version` / MAIN world 未激活** — 扩展重载了但
  ChatGPT 标签页没刷新；刷新标签页（F5）。content script 会在这种协议版本
  不匹配上响亮失败，而不是用过时的抓取代码静默解析。
- **`EADDRINUSE`** — 旧中继还在跑；先停掉（中继现在会打印确切命令）。
- **`message was not sent — no conversation request observed`** — 提交确认
  放弃了，通常是文件上传落定太慢（确认窗口现在会按剩余请求预算伸缩，
  12–60 秒）。消息**可能**实际已在检查放弃后送达——不要盲目重发。composer
  （文本 + 文件 chip）在此错误后会自动清空，并在下个请求开始时防御性再清一
  次，半成稿状态不会泄漏进下个会话。
- **`timed out waiting for network reply (Ns)`** — 回复流没能在预算内完成。
  消息可能带 `bridge diagnostics:` 后缀（来自页面侧网络暂存区）。四种状态
  可区分：
  - `saw HTTP 403 (text/html) … likely a challenge/limit page` — 会话端点回
    的是质询/限额页而不是流：刷新标签页，等一等，稍后重试。
  - `accepted the request (HTTP 200) but sent no chunk at all — the stream
    went silent` — 已发送、已接受、然后静默（这个状态曾经与「扩展低于
    v1.2.9」无法区分）。
  - `N reply chunk(s) received, last Xs ago` — 流还活着：N 大且 X 小 = 慢；
    N 冻结且 X 增长 = 停了。
  - 无后缀 — 什么都没观测到，或扩展低于 v1.2.9。
- **中继返回 HTTP 403** — 中继设了 `BRIDGE_TOKEN` 但客户端没带。让 MCP
  （`BRIDGE_TOKEN` 环境变量）和扩展（`chrome.storage.local.set({ bridgeToken: ... })`）
  两边的 token 一致。

## 已知限制

- **`.md` 文件上传**（`file` 参数）依赖 `DataTransfer` 技巧，部分 ChatGPT
  版本会拒绝。尽量以纯文本发送结果。
- **Canvas 文档附件**（ChatGPT 生成真 `.md` 文件时）通过读取 canvas 编辑器
  尽力抓取；ChatGPT 改 DOM 时同样可能失效。每个文件只点一次（目标按规范化
  文件名去重——「下载 x.md」/「Download x.md」下载链接和它的 "x.md" chip 是
  同一个文件），你自己消息里的卡片——即你上传的文件——会被跳过，且每次读
  取都绑定到它的点击：只有相对点击前快照是新增或变更的 canvas 才算数，先前
  请求留下的 canvas 永远不会顶替后面的抓取。卡片选择也绑定到提交：只有消
  息提交**之后**出现的卡片才被抓取，续接会话中早前轮次的文档卡片绝不会被打
  成本次回复的附件。要稳的循环，请让 ChatGPT 以纯文本输出计划。
- ChatGPT 内部的引用标记（包在私用区哨兵字符里的 `filecite …` 短语）会在交
  付前剥除。答案以文档/canvas 模式产出时泄漏进原始流文本的
  `:::writing{variant="document" …}` … `:::` 包裹指令同样处理：剥掉包裹行、
  保留正文（遗留一个边界情况——正文代码围栏里的裸 `:::writing{…}` 行也会被
  剥掉，目前未知有真实出现）。
- ChatGPT 前端经常变。回复链路走网络层、比 DOM 扒取健壮——扛得住 class 名
  变化，同时处理全量快照和 `delta_encoding: v1` 增量流——但协议一变仍可能
  需要更新解析器。出现异常截断后，跑 `npm test` 并用 `debug: true` 重查以
  抓一份原始流样本。

## 免责声明

自动化 ChatGPT 网页 UI 可能违反 OpenAI 服务条款并带来账号风险。自担风险使
用，保持低请求频率，建议仅用于个人/实验用途。
