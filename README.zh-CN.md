# eve-lark

[English](./README.md) | 简体中文

一个为 [eve](https://eve.dev) agent 框架打造的 [Lark](https://www.larksuite.com) / [Feishu](https://www.feishu.cn) 通道。把工厂函数放到 `agent/channels/lark.ts`，eve 就会挂载一个 Lark webhook，把收到的私聊消息和群组 @ 提及转换成流式交互卡片回复。

## 特性

**入站**
- 文本、富文本（`post`）、`@` 提及（包括 `@all`）
- 图片和文件附件（服务端下载并暂存给模型使用）
- 通过 `root_id` / `parent_id` 实现的话题回复
- `event_id` 去重（处理 Feishu 的 at-least-once 重试）

**出站**
- 流式交互卡片（在对话过程中实时 patch 更新）—— 默认模式
- 静态一次性卡片回复 —— 可配置
- 话题回复保留原始 `root_id`

**安全**
- `X-Lark-Signature` 签名校验（`sha256(timestamp + nonce + encrypt_key + body)`，恒定时间比较）
- 当配置了 `encryptKey` 时，对 `encrypt` 信封进行 AES-256-CBC 解密
- 时间戳偏移窗口（默认 5 分钟）
- 抑制 bot 自身发出的消息

**Feishu 和 Lark 都支持**，只需切换一个 `baseUrl` 即可。

### v1 暂不支持

以下能力**有意**没有发布 —— 如果需要请提 issue：
- 入站的音频 / 媒体 / 贴纸 / share_chat / share_user（仅 ack 并跳过）
- 多账号配置
- 用户级 OAuth（`user_access_token` 设备流程）
- Feishu API 工具（文档 / 多维表格 / 日历 / 任务 / 云盘）
- 卡片动作按钮（不支持交互式表单）

## 快速开始

安装：

```bash
pnpm add eve-lark
# 或者：npm install eve-lark / yarn add eve-lark
```

在你的 eve agent 中创建通道：

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

然后在 [Feishu 开发者后台](https://open.feishu.cn/app)（或 [Lark 开发者后台](https://open.larksuite.com/app)）中：

1. 创建一个**自建应用**，记录 `App ID` 和 `App Secret`。
2. 在**事件订阅**中，把请求 URL 设置为你的 agent 的 `/lark/webhook`（可通过 `webhookPath` 选项覆盖）。
3. 生成 **Verification Token** 和 **Encrypt Key** —— 都复制到你的环境变量里。
4. 订阅 `im.message.receive_v1` 事件。
5. 把 bot 拉进群组或直接私聊。

## 配置参考

所有字段都可以通过选项传入，或从对应的环境变量读取（选项优先）。

| 字段 | 类型 | 必填 | 默认值 | 环境变量 |
|---|---|---|---|---|
| `appId` | `string` | 是 | — | `LARK_APP_ID` |
| `appSecret` | `string` | 是 | — | `LARK_APP_SECRET` |
| `verificationToken` | `string` | 是 | — | `LARK_VERIFICATION_TOKEN` |
| `encryptKey` | `string` | 否 | — | `LARK_ENCRYPT_KEY` |
| `baseUrl` | `string` | 否 | `https://open.feishu.cn` | `LARK_BASE_URL` |
| `botOpenId` | `string` | 否 | — | `LARK_BOT_OPEN_ID` |
| `webhookPath` | `string` | 否 | `/lark/webhook` | — |
| `replyMode` | `"streaming" \| "static"` | 否 | `"streaming"` | — |
| `streamPatchIntervalMs` | `number` | 否 | `1000` | — |
| `streamCreateThresholdMs` | `number` | 否 | `400` | — |
| `dedupTtlMs` | `number` | 否 | `1_800_000`（30 分钟） | — |
| `dedupMaxEntries` | `number` | 否 | `5_000` | — |
| `requestTimeoutMs` | `number` | 否 | `15_000` | — |
| `maxRetries` | `number` | 否 | `2` | — |
| `tokenRefreshBufferMs` | `number` | 否 | `300_000`（5 分钟） | — |
| `signatureSkewMs` | `number` | 否 | `300_000`（5 分钟） | — |
| `fetch` | `typeof fetch` | 否 | `globalThis.fetch` | — |

## Feishu 与 Lark（国际版）

两套部署使用相同的 API。通过 `baseUrl` 切换：

```ts
createLarkChannel({
  baseUrl: "https://open.larksuite.com", // 国际版
  // ...
});
```

或通过环境变量：`LARK_BASE_URL=https://open.larksuite.com`。

## 流式 vs 静态模式

- **`streaming`**（默认）：通道在第一个 delta 时创建交互卡片，节流地实时 patch（约 1 秒一次），并在回合结束时收尾。用户体验最好。
- **`static`**：通道等待 `message.completed`，然后一次性发送包含完整答案的卡片。API 调用量更低；当你撞上 Feishu 的 PATCH 限流时有用。

通过 `streamPatchIntervalMs` 调节节流间隔（值越小越平滑，API 调用越多）。

## 续接 token 与话题

eve-lark 使用 chat id 加上话题根消息 id 作为会话续接 token：

```
<chat_id>:<root_message_id>
```

对于顶层会话，root 是 `_`：

```
oc_xxx:_       — 顶层对话
oc_xxx:om_yyy  — om_yyy 话题中的回复
```

话题中的回复会跨回合保持话题锚点。该 token 按通道 id 命名空间化（eve 框架会前置通道文件名），所以同时部署多个自定义通道与 `lark` 共存是安全的。

## 安全模型

- **签名校验**：当设置了 `encryptKey` 时，每个入站 webhook 必须携带有效的 `X-Lark-Signature` 头。不匹配返回 HTTP 401。
- **AES 解密**：设置了 `encryptKey` 时，使用 AES-256-CBC 解密 `encrypt` 信封，其中 `key = SHA256(encrypt_key)`，IV 取前 16 字节。
- **时间戳偏移**：早于 `signatureSkewMs` 的请求会以 HTTP 408 拒绝。
- **去重**：`event_id` 会被记住 `dedupTtlMs` 时间。重放返回 200 但不会重新启动回合。
- **Serverless 注意事项**：去重是进程内的。多实例部署在极端时序窗口下可能会重复处理同一事件 —— 请把你的工具做成幂等的。

## 文件与图片入站

入站的图片/文件消息会被转换成 eve 的 `UserContent` 文件 part。其 `data` 字段是一个指向 Lark 资源端点的 `URL`，所以 eve 的管道会调用通道的 `fetchFile` 钩子（使用 bot 的 `tenant_access_token`）把字节暂存给模型。

如果你希望 URL part 直接透传而不暂存字节（例如在 eve sandbox 之外运行），不要设置 `encryptKey`，并在你的工具里检查 `attributes`。

## 错误

eve-lark 抛出一个小的有类型层次结构：

```
LarkChannelError
├── LarkConfigError        — 缺少必填选项
├── LarkSignatureError     — 签名校验失败（很少抛出；通常返回 401 Response）
├── LarkDecryptError       — AES 解密失败
└── LarkApiError           — Lark API 调用失败（携带 .code、.status、.body）
```

webhook 处理器返回结构化的 HTTP 响应，方便服务端处理：

| 状态码 | 原因 |
|---|---|
| 200 | Ack（成功或故意忽略的事件） |
| 400 | JSON 无效 / 解密失败 |
| 401 | 签名缺失/无效，或 verification token 不匹配 |
| 408 | 超出时间戳偏移窗口 |

## 限制与路线图

**v1 限制**：见 [暂不支持](#v1-暂不支持)。

**v2 规划**（如果你希望优先实现某项，欢迎提 issue）：
- 卡片动作按钮处理（交互式表单、确认流程）
- 音频 / 媒体入站转写
- 可选的 Redis 支持的多实例去重
- 用户级 OAuth（`user_access_token`），用于 Feishu API 工具

## 开发

```bash
pnpm install
pnpm test           # 运行 vitest 测试套件
pnpm test:watch     # 交互式 watch 模式
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm build          # tsup 构建 → dist/
```

## 对接真实 Feishu 应用做冒烟测试

参见 [`examples/README.md`](./examples/README.md)，其中介绍了一种双进程的搭建方式，使用 Feishu 的长连接传输（无需公网 webhook URL）。简单来说：

```bash
pnpm build                                  # 构建 eve-lark，让 agent 能 import
cp examples/agent/.env.example examples/agent/.env
$EDITOR examples/agent/.env                 # 填入凭据
cd examples/agent && pnpm install
# 终端 A：
cd examples/agent && pnpm dev               # eve dev server
# 终端 B（在 repo 根目录）：
pnpm tsx examples/ws-forwarder.ts           # Feishu WS → localhost HTTP
```

在 Feishu 中向 bot 发送 `ping`，应该能收到 `pong` 的流式卡片回复。

测试布局：

```
test/
├── crypto.spec.ts              # 签名 & AES 向量（包含一个 round-trip 辅助函数）
├── dedup.spec.ts               # TTL、FIFO 淘汰、惰性清理
├── options.spec.ts             # env 回退、默认值、校验
├── parse.spec.ts               # text/image/file/post/mention fixture
├── lark-client.spec.ts         # token 互斥锁、重试策略（429/5xx/401）、nock 等价的 mock
├── streaming-controller.spec.ts # FSM 状态转换、节流、降级
├── card.spec.ts                # 卡片构建器
├── channel.spec.ts             # 端到端 webhook：校验、解密、去重、会话启动、流式串联
└── helpers/
    ├── encrypt.ts              # 仅测试用的 AES 加密镜像
    └── mock-fetch.ts           # 替代 nock 的微型 mock fetch（兼容原生 fetch）
```

## 协议

MIT —— 见 [LICENSE](./LICENSE)。
