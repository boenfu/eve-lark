# eve-lark

[English](./README.md) | 简体中文

一个为 [eve](https://eve.dev) agent 框架打造的 [Lark](https://www.larksuite.com) / [Feishu](https://www.feishu.cn) 通道。把工厂函数放到 `agent/channels/lark.ts`，eve 就会挂载一个 Lark webhook，把收到的私聊消息和群消息转成 agent 回复。

## 特性

**入站**
- 文本、富文本（`post`）、`@` 提及，包括 bot mention stripping 和 `@all`
- 图片/文件附件；音频、视频、sticker、分享卡片、位置、todo、vote、system、交互卡片和 merge-forward 消息会被转成可读占位或摘要；可用消息 API 时会展开完整交互卡片内容和 merge-forward 子消息；配置 `asrProvider` 后音频/媒体优先转写成文本
- 消息 reaction 作为 synthetic user input
- 通过 `root_id` / `parent_id` 跟踪线程、同 chat 串行队列、引用触发消息回复
- DM 发送人白名单、群白名单、群内 sender 白名单、`requireMention` 和群级 `systemPrompt` 注入
- `event_id` 去重和过期事件丢弃

**出站**
- CardKit v2 流式回复 —— 默认，走 CardKit entity、`card_id` 发送、element sequence 更新和终态关闭 streaming mode
- `post` 富文本回复和静态一次性卡片 —— 可配置
- `createLarkSender()` 出站发送器：chat/open_id/user_id target、encoded reply target、text chunk、`channelData.feishu.card` 原生卡片、图片/文件/音频/视频 upload + send、多媒体顺序编排、分页缓存的群成员 mention normalization、强制 peer mention 注入
- `createLarkMessageActions()` agent/tool action adapter：`send`、`react`、`reactions`、`delete`、`unsend`、`forward`
- `LarkClient` 低层 API：upload/send media、forward、delete、chat metadata/member 管理、chat member list、CardKit、resource、reaction list
- 入站 ack reaction，以及消息 reaction 添加/删除/列出 API
- 通过 `cardActionHandler` 处理自定义业务卡片 action，并提供 reply/follow-up/edit helper

**安全**
- `X-Lark-Signature` 校验（`sha256(timestamp + nonce + encrypt_key + body)`，constant-time）
- 当配置了 `encryptKey` 时，AES-256-CBC 解密 `encrypt` 信封
- 时间戳偏差窗口（默认 5 分钟）和事件年龄窗口（默认 10 分钟）
- 事件 `app_id` 归属校验
- 抑制 bot 自己发的消息
- 出站 remote media URL 的 localhost/私网 IP/DNS 结果校验，以及 local media file root allowlist

**交互式 ask_question**——当模型调用 eve 内置的 `ask_question` 工具时，eve-lark 会把提示渲染成飞书交互卡片。单问题走按钮/选择卡片；同一轮多个问题会渲染成一张统一提交表单，也支持 multi-select 字段。用户点击触发 `card.action.trigger` 回调，channel 把答案作为 `InputResponse` 发回 eve，parked session 恢复。`allowFreeform: true` 允许用户直接回复普通聊天消息代替点击。pending 卡片会显示提交中状态，在 `askInputTtlMs` 后过期，可通过 `submitterOpenId` 限定提交者；synthetic resume 失败时会恢复原卡片保持可重试。

**自定义卡片 action**——传入 `cardActionHandler` 后，eve-lark 会把非内置 ask 卡片产生的 `card.action.trigger` 回调交给它处理。handler 能拿到原始事件、`action.value`、chat/message/user id，并可用 `respond.reply`、`respond.followUp`、`respond.editMessage` 回复或改卡。这是轻量 channel hook，不是 openclaw-lark 那套插件级 interactive registry。

**命令与诊断**——`/lark help`、`/lark start`、`/lark doctor`、`/lark auth`、`/lark trace <message_id>` 和兼容保留的 `/lark-diagnose` 由 channel 直接处理，不转发给 agent。`/lark doctor` 会输出 token 状态、channel 运行配置，以及 IM/CardKit/media/reaction 所需权限和事件清单。

**Feishu（飞书）和 Lark（国际版）** 通过单一的 `baseUrl` 切换支持。

### 不在 v1 范围内

以下功能**未实现或不作为 channel v1 默认范围**——需要的话请提 issue：
- Drive comment、VC meeting invited 等非 IM channel 入口。
- 完整 streaming image URL resolver 与异步上传占位。
- HITL / diagnostics 的完整 i18n 文案。
- 多账号配置
- 用户级 OAuth（`user_access_token` device flow）
- 飞书 API 工具（docs / bitable / calendar / tasks / drive）

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
| `eventMaxAgeMs` | `number` | 否 | `600_000`（10 分钟） | — |
| `askInputTtlMs` | `number` | 否 | `300_000`（5 分钟） | — |
| `ackReaction` | `string \| readonly string[] \| false` | 否 | `"Typing"` | — |
| `allowFrom` | `readonly string[]` | 否 | 允许所有 DM | — |
| `groupAllowFrom` | `readonly string[]` | 否 | 允许所有群 | — |
| `groupConfigs` | `readonly { chatId: string; allowFrom?: readonly string[]; requireMention?: boolean; respondToMentionAll?: boolean; systemPrompt?: string }[]` | 否 | — | — |
| `asrProvider` | `{ transcribe(bytes, mediaType): Promise<string> }` | 否 | — | — |
| `cardActionHandler` | `(ctx) => unknown \| Promise<unknown>` | 否 | — | — |
| `mediaLocalRoots` | `readonly string[]` | 否 | 禁用本地文件媒体路径 | — |
| `mediaHostResolver` | `(hostname) => Promise<readonly string[]>` | 否 | Node DNS lookup | — |
| `fetch` | `typeof fetch` | 否 | `globalThis.fetch` | — |

## 出站 helper

`createLarkSender()` 是直接 channel sender。它兼容旧的 `chatId`，也支持更完整的 `to` target：

```ts
const sender = createLarkSender({ appId, appSecret, verificationToken });

await sender.sendPayload({
  to: "open_id:ou_xxx",
  text: "hello",
});

await sender.sendPayload({
  to: "oc_xxx#__feishu_reply_to=om_xxx",
  channelData: { feishu: { card: { schema: "2.0", body: { elements: [] } } } },
});
```

target 形式：

- `oc_xxx` 或 `chat:oc_xxx` → `receive_id_type=chat_id`
- `ou_xxx`、`open_id:ou_xxx` 或 `feishu:ou_xxx` → `receive_id_type=open_id`
- `user:employee_id` 或 `{ id: "employee_id", idType: "user_id" }` → `receive_id_type=user_id`
- `#__feishu_reply_to=om_xxx` 表示引用回复目标

`createLarkMessageActions()` 把同一套发送层暴露成轻量 agent/tool action adapter，支持 `send`、`react`、`reactions`、`delete`、`unsend`、`forward`。

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

- **`streaming-v2`**（默认）：channel 在第一个 delta 时创建 CardKit v2 entity，通过 `card_id` 发送 IM 消息，再用 CardKit element sequence 更新正文；终态会先关闭 `streaming_mode` 再更新完整卡片。它会独立展示 reasoning、渲染 tool trace、支持可选 footer metrics，并在 CardKit unavailable/table-limit 错误后停止中间帧流式但保留终态 CardKit 更新。**是这个 channel 能提供的最好的实时 UX**。`ask_question` 会单独发送问题卡/表单。
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

## 群控制

`allowFrom` 用于 DM 发送人白名单，`groupAllowFrom` 用于群 chat_id 白名单。被允许的群里默认 `@ bot` 和不 `@ bot` 的消息都会进入 agent；配置了 `botOpenId` 时，文本开头的 bot mention 会在进入 agent 前被去掉。

`groupConfigs` 可以为不同群配置 sender 白名单、mention 策略和 `systemPrompt`：

```ts
createLarkChannel({
  // ...credentials...
  groupAllowFrom: ["oc_xxx"],
  groupConfigs: [
    {
      chatId: "oc_xxx",
      allowFrom: ["ou_alice"],
      requireMention: true,
      respondToMentionAll: false,
      systemPrompt: "你是这个群的支持助手，回答要简洁。",
    },
  ],
});
```

`requireMention` 为 true 时，只有直接 @ bot 才会唤醒 agent。`@all` 只有在 `respondToMentionAll` 也为 true 时才会唤醒。提示词会作为 eve `send()` 的 `context` 传给匹配的群消息。DM 不会读取 `groupConfigs`。

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
- streaming image URL resolver
- 更完整的 HITL i18n
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

## 真实 Lark/飞书 E2E 测试

`pnpm test:e2e` 会加载 `.env.e2e.local`，但只有设置 `E2E_LARK=1` 时才会真正跑飞书 E2E。没设置这个开关时，Vitest 只收集文件并跳过 suite。

请使用一次性的测试群。这个 suite 会往 `E2E_LARK_CHAT_ID` 发送真实消息、卡片、reaction 和文件，并在测试开始/结束时往群里发摘要消息。

本地前置条件：

- 已安装 `lark-cli`，并且当前 user 身份已登录、在测试群内。测试会用 `--as user` 发文本/文件、拉取消息、添加/删除/列出 reaction、发现群内 bot。
- 应用 bot 已加入同一个测试群。
- 应用事件订阅使用**长连接**模式，并订阅 `im.message.receive_v1`、`card.action.trigger`、`im.message.reaction.created_v1` 和 `im.message.reaction.deleted_v1`。
- 应用 bot token 需要能发送/回复 IM 消息、发送交互卡片、调用 CardKit v2 卡片 API、添加/删除/列出消息 reaction、上传 IM 图片/文件、下载消息资源、转发/删除 bot 自己的消息、列群成员。飞书后台里打开对应的 IM/CardKit 权限即可；文件资源相关当前是 `im:resource`，不是 `im:resource:upload`。
- 默认 E2E 不会改群名、拉人或踢人；`updateChat`、`addChatMembers`、`removeChatMembers` 只做单元测试，避免破坏测试群状态。
- 从 `E2E_LARK_PORT` 开始的一组本地端口需要空闲。默认基准端口是 `23080`，suite 会从这里递增使用。

`.env.e2e.local` 已加入 gitignore。最小配置示例：

```bash
E2E_LARK=1
E2E_LARK_CHAT_ID=oc_xxx

LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_VERIFICATION_TOKEN=xxx
LARK_ENCRYPT_KEY=xxx          # 如果应用后台启用了加密就填；否则可不填
LARK_BASE_URL=https://open.feishu.cn

# 可选。不填时 suite 会用 lark-cli 在群里寻找唯一 bot。
E2E_LARK_BOT_OPEN_ID=ou_xxx

# 可选。默认 23080。
E2E_LARK_PORT=23080
```

运行：

```bash
pnpm test:e2e
```

当前 suite 覆盖：出站 text/post/card/reaction/media API、`createLarkSender().sendPayload()` 的 text + 原生卡片 + media 编排、forward/delete/list members 的非破坏性动作、CardKit v2 streaming、长连接入站回复、ackReaction、同 chat 连续消息排队、引用回复、群聊 `@` 和非 `@` 消息、群 `requireMention`、群级 `systemPrompt`、群白名单、slash 命令、自定义卡片 action 的 reply/follow-up/edit、HITL text/select/multi-select 表单、freeform/重试/TTL、reaction 事件作为 synthetic input、文件入站和 resource download。单元测试额外覆盖 open_id/user_id target、encoded reply target、message action adapter、私网 media URL 拒绝、merge-forward 展开 hook、完整卡片 fetch hook、doctor 权限/事件输出、streaming metrics/unavailable guard。

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
├── allowlist.spec.ts           # DM/群白名单、requireMention 和群级 systemPrompt
├── ask-card.spec.ts            # ask_question 卡片构造器
├── ask-flow.spec.ts            # ask_question 渲染、回调、freeform、重试、TTL
├── asr.spec.ts                 # 可选音频/媒体转写
├── authorization.spec.ts       # eve 授权卡片
├── cardkit-v2.spec.ts          # CardKit v2 构造器
├── crypto.spec.ts              # 签名 & AES 测试向量（含 round-trip helper）
├── dedup.spec.ts               # TTL、FIFO 淘汰、惰性 sweep
├── diagnose.spec.ts            # /lark 命令拦截和诊断
├── event-policy.spec.ts        # app 归属、事件过期、abort 文本、reaction
├── options.spec.ts             # env 回退、默认值、校验
├── outbound.spec.ts            # 出站 sender/media/payload/mention/action helper
├── parse.spec.ts               # text/image/file/post/mention fixtures
├── lark-client.spec.ts         # token mutex、retry policy、CardKit、reaction、resource
├── streaming-controller.spec.ts # FSM 状态转换、节流、降级
├── channel.spec.ts             # webhook 处理、队列、abort、ack reaction
├── e2e/lark-real.spec.ts       # opt-in 真实飞书/Lark E2E suite
└── helpers/
    ├── encrypt.ts              # 仅测试用的 AES cipher 镜像
    └── mock-fetch.ts           # 替代 nock 的迷你 mock fetch
```

## License

MIT —— 见 [LICENSE](./LICENSE)。
