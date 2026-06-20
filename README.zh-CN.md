# eve-lark

[English](./README.md) | 简体中文

一个为 [eve](https://eve.dev) agent 框架打造的 [Lark](https://www.larksuite.com) / [Feishu](https://www.feishu.cn) 通道。把工厂函数放到 `agent/channels/lark.ts`，eve 就会挂载一个 Lark webhook，把收到的私聊消息和群组 @ 提及转成回复。

## 特性

**入站**
- 文本、富文本（`post`）、`@`-提及（包括 `@all`）
- 图片和文件附件（服务端下载并 stage 给模型）
- 通过 `root_id` / `parent_id` 跟踪线程
- `event_id` 去重（应对飞书 at-least-once 重试）

**出站**
- 流式交互卡片（对话过程中实时 patch）—— 可选模式
- `post` 富文本消息（**默认**，渲染为原生聊天消息大小，支持 markdown）
- 静态一次性卡片 —— 可选
- 线程回复保留原始 `root_id`

**安全**
- `X-Lark-Signature` 校验（`sha256(timestamp + nonce + encrypt_key + body)`，constant-time）
- 当配置了 `encryptKey` 时，AES-256-CBC 解密 `encrypt` 信封
- 时间戳偏差窗口（默认 5 分钟）
- 抑制 bot 自己发的消息

**交互式 ask_question**——当模型调用 eve 内置的 `ask_question` 工具时，eve-lark 会把提示渲染成一张飞书交互卡片，每个选项对应一个按钮（option.style `primary` / `default` / `danger` 直接映射到飞书 button type）。用户点击触发 `card.action.trigger` 回调，channel 把答案作为 `InputResponse` 发回 eve，parked session 恢复。`allowFreeform: true` 允许用户直接回复普通聊天消息代替点击——下一条同 chat 内的消息会被拦截为答案。回答后卡片原地更新（移除按钮，选中项以绿色 ✓ 标记）。

**Feishu（飞书）和 Lark（国际版）** 通过单一的 `baseUrl` 切换支持。

### 不在 v1 范围内

以下功能**未实现**——需要的话请提 issue：
- 图片 / 文件 / 音频以外的非文本入站：sticker / share_chat / share_user / 交互卡片（ack-and-skip）。音频入站在配置了 `asrProvider` 时会转写；没配置则同样是 ack-and-skip。
- 多账号配置
- 用户级 OAuth（`user_access_token` device flow）
- 飞书 API 工具（docs / bitable / calendar / tasks / drive）
- agent 自渲染的完全自定义卡片 schema（交互表单——`ask_question` 的卡片按钮已在 0.3.0+ 发出，这里指的是超出这个范围的）

## 快速开始

两步。一个文件，一条命令。

**1. 声明 channel：**

```ts
// agent/channels/lark.ts
import { createLarkChannel } from "eve-lark";

export default createLarkChannel({
  appId:             process.env.LARK_APP_ID!,
  appSecret:         process.env.LARK_APP_SECRET!,
  verificationToken: process.env.LARK_VERIFICATION_TOKEN!,
  encryptKey:        process.env.LARK_ENCRYPT_KEY,
  botOpenId:         process.env.LARK_BOT_OPEN_ID,
});
```

**2. 跑 `eve dev`：**

```bash
pnpm add eve-lark eve
eve dev
```

完事。channel 在构造时副作用启动一个飞书 `WSClient`——飞书只看到这条出站 WebSocket，**本地开发不需要公网 webhook URL**。每个事件被重新签名 + 重新加密，POST 到 channel 自己在 `localhost` 的 webhook，由标准 handler 处理（完整 `send()` 访问权限）。

在 [飞书开发者后台](https://open.feishu.cn/app)：
1. 创建**自建应用**。记下 `App ID` 和 `App Secret`。
2. 进入**事件订阅**，选择**「使用长连接接收事件」**模式（不是 HTTP 回调）。
3. 生成**Verification Token** 和**Encrypt Key**——都填进你的 env。
4. 订阅 `im.message.receive_v1`。
5. 把 bot 拉进群或直接私聊。

两种传输模式在生产环境都可以用，选哪个取决于你的部署拓扑。详见[生产部署](#生产部署)。

## 配置参考

所有字段既能作为选项传入，也能从对应 env var 读取（选项优先）。

| 字段 | 类型 | 必填 | 默认 | env var |
|---|---|---|---|---|
| `appId` | `string` | 是 | — | `LARK_APP_ID` |
| `appSecret` | `string` | 是 | — | `LARK_APP_SECRET` |
| `verificationToken` | `string` | 是 | — | `LARK_VERIFICATION_TOKEN` |
| `encryptKey` | `string` | 否 | — | `LARK_ENCRYPT_KEY` |
| `baseUrl` | `string` | 否 | `https://open.feishu.cn` | `LARK_BASE_URL` |
| `botOpenId` | `string` | 否 | — | `LARK_BOT_OPEN_ID` |
| `mode` | `"long-connection" \| "webhook"` | 否 | `"long-connection"` | `LARK_MODE` |
| `port` | `number` | 否 | `$PORT` 或 `2000` | `PORT` |
| `webhookPath` | `string` | 否 | `/lark/webhook` | — |
| `replyMode` | `"post" \| "streaming" \| "streaming-v2" \| "static"` | 否 | `"streaming-v2"` | `LARK_REPLY_MODE` |
| `streamPatchIntervalMs` | `number` | 否 | `1000` | — |
| `streamCreateThresholdMs` | `number` | 否 | `400` | — |
| `dedupTtlMs` | `number` | 否 | `1_800_000`（30 分钟） | — |
| `dedupMaxEntries` | `number` | 否 | `5_000` | — |
| `requestTimeoutMs` | `number` | 否 | `15_000` | — |
| `maxRetries` | `number` | 否 | `2` | — |
| `tokenRefreshBufferMs` | `number` | 否 | `300_000`（5 分钟） | — |
| `signatureSkewMs` | `number` | 否 | `300_000`（5 分钟） | — |
| `ackReaction` | `string \| readonly string[] \| false` | 否 | `"Typing"` | — |
| `fetch` | `typeof fetch` | 否 | `globalThis.fetch` | — |

## Feishu vs Lark（国际版）

两个部署用同一套 API。通过 `baseUrl` 切换：

```ts
createLarkChannel({
  baseUrl: "https://open.larksuite.com", // 国际版
  // ...
});
```

或通过 env：`LARK_BASE_URL=https://open.larksuite.com`。

## 回复模式

- **`streaming-v2`**（默认）：channel 在第一个 delta 时创建交互卡片，通过飞书 CardKit v2（`schema: "2.0"` + `streaming_mode`）实时 patch。**是这个 channel 能提供的最好的实时 UX**。卡片文字比原生消息字号小（飞书把卡片当作「结构化内容」）。
- **`streaming`**：和 `streaming-v2` 一样的实时 patch UX，但走老的 v1 卡片 schema，字号比 v2 略小。仅在你有特定原因想避开 CardKit v2 时才选。
- **`post`**：channel 等 `message.completed`，把回复作为 `msg_type: "post"` 富文本消息发出。**渲染为原生聊天消息大小**，完整支持 markdown（粗体、链接、代码、`<font>` 颜色 tag）。代价：不能流式——用户在 turn 完成时才看到回复。
- **`static`**：和 `post` 一样等完成再发，但用交互卡片而非 post。适合需要卡片特性（按钮、多列布局）且不在乎字号小的场景。

流式节流通过 `streamPatchIntervalMs` 调整（值越小越平滑，但 API 调用越多）。

```bash
LARK_REPLY_MODE=post   # 切到原生字号 + markdown（无流式）
```

## Continuation token 与线程

eve-lark 用 chat id 加线程 root message id 作为 session continuation token：

```
<chat_id>:<root_message_id>
```

对于顶层对话，root 是 `_`：

```
oc_xxx:_       — 顶层
oc_xxx:om_yyy  — 在 om_yyy 线程里的回复
```

线程内的回复跨 turn 保留 thread anchor。token 由 channel id 命名空间隔离（eve 框架在前面拼上 channel 文件名），所以可以同时挂多个自定义 channel。

## 安全模型

- **签名校验**：设置了 `encryptKey` 时，每个入站 webhook 必须带有效的 `X-Lark-Signature` 头。不匹配返回 HTTP 401。
- **AES 解密**：设置了 `encryptKey` 时，`encrypt` 信封用 AES-256-CBC 解密，`key = SHA256(encrypt_key)`，前 16 字节作为 IV。
- **时间戳偏差**：超过 `signatureSkewMs` 的请求返回 HTTP 408。
- **去重**：`event_id` 记忆 `dedupTtlMs` 时长。重放返回 200，不重新启动 turn。
- **Serverless 注意**：去重是进程内的。多实例部署在极少数 timing 窗口下可能 double-process 事件——让你的工具幂等。

## 文件 & 图片入站

入站的图片/文件消息会被转成 eve `UserContent` 的 file part。`data` 字段是指向飞书 resource endpoint 的 `URL`，所以 eve 的 pipeline 会调用 channel 的 `fetchFile` 钩子（用 bot 的 `tenant_access_token`）把字节 stage 给模型。

如果你想让 URL 部分直接透传（比如在 eve sandbox 外运行），不要设 `encryptKey`，改在工具里读 `attributes`。

## 错误

eve-lark 抛出一组类型化错误：

```
LarkChannelError
├── LarkConfigError        — 缺必填选项
├── LarkSignatureError     — 签名校验失败（很少抛；通常返回 401）
├── LarkDecryptError       — AES 解密失败
└── LarkApiError           — Lark API 调用失败（带 .code、.status、.body）
```

webhook handler 返回结构化 HTTP 响应，方便服务端处理：

| Status | 原因 |
|---|---|
| 200 | Ack（成功或有意忽略的事件） |
| 400 | 无效 JSON / 解密失败 |
| 401 | 签名缺失/无效或 verification token 不匹配 |
| 408 | 时间戳偏差超过窗口 |
| 413 | 请求 body 超过 1 MB 上限 |

## 限制 & roadmap

**v1 限制**：见[不在范围内](#不在-v1-范围内)。

**v2 计划**（想优先哪个就开 issue）：
- 完全自定义的卡片交互（agent 自渲染表单、确认流）
- 音频 / 媒体入站转写
- 可选的 Redis 后端去重，支持多实例部署
- 用户级 OAuth（`user_access_token`）用于飞书 API 工具

## 开发

```bash
pnpm install
pnpm test           # 跑 vitest 测试套件
pnpm test:watch     # 交互式 watch
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm build          # tsup build → dist/
```

## 真实飞书应用冒烟测试

完整流程见 [`examples/README.md`](./examples/README.md)。TL;DR 跟[快速开始](#快速开始)一样：装依赖、填 `.env`、跑 `eve dev`。给 bot 发 `ping`，应该收到 `pong` 回复。

## 生产部署

两种传输模式在生产环境都支持——根据你的部署拓扑选择。

- **`long-connection`**（默认，WebSocket）：channel 主动向飞书发起出站 WS 连接，**不需要公网 URL**。适合单实例部署（一个容器、一个进程）。WSClient 单例守卫只在单个进程内去重——跑 N 个副本就会有 N 条独立的 WebSocket，每个事件被投递到所有副本，所以这个模式**不**适用于多副本负载均衡场景。
- **`webhook`**（HTTP 回调）：飞书把事件 POST 到你部署的 agent 的公网 `/lark/webhook`。负载均衡把每个事件路由到一个副本，**可以水平扩展**。需要有公网可达的 URL。

切到 webhook：

```ts
// agent/channels/lark.ts
export default createLarkChannel({
  // ... 凭据 ...
  mode: "webhook",
});
```

在飞书后台，把**事件订阅**设为 **HTTP 回调**，URL 设为你部署的 agent 的 `/lark/webhook`。然后：

```bash
eve build
eve deploy          # 或：在有公网 URL 的服务器上跑 eve start
```

其他逻辑（签名、AES、流式、ask_question）在两种模式下都一样。去重在两种模式下都是进程内的——多实例场景的影响见[安全模型](#安全模型)里的 serverless 说明。

测试目录：

```
test/
├── crypto.spec.ts              # 签名 & AES 测试向量（含 round-trip helper）
├── dedup.spec.ts               # TTL、FIFO 淘汰、惰性 sweep
├── options.spec.ts             # env 回退、默认值、校验
├── parse.spec.ts               # text/image/file/post/mention fixtures
├── lark-client.spec.ts         # token mutex、retry policy（429/5xx/401）、mock fetch
├── streaming-controller.spec.ts # FSM 状态转换、节流、降级
├── card.spec.ts                # 卡片构造器
├── feishu-emoji.spec.ts        # 飞书 emoji 白名单
├── launcher-detection.spec.ts  # eve start launcher 进程识别
├── long-connection.spec.ts     # WSClient 单例守卫、转发签名/AES
├── channel.spec.ts             # 端到端 webhook：校验、解密、去重、session 启动、ack reaction
├── ask-card.spec.ts            # ask_question 卡片构造器
├── ask-flow.spec.ts            # ask_question 端到端：渲染、点击回调、freeform 拦截
└── helpers/
    ├── encrypt.ts              # 仅测试用的 AES cipher 镜像
    └── mock-fetch.ts           # 替代 nock 的迷你 mock fetch
```

## License

MIT —— 见 [LICENSE](./LICENSE)。
