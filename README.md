# eve-lark

English | [简体中文](./README.zh-CN.md)

A [Lark](https://www.larksuite.com) / [Feishu](https://www.feishu.cn) channel for the [eve](https://eve.dev) agent framework. Drop the factory into `agent/channels/lark.ts` and eve will mount a Lark webhook that turns inbound DMs and group messages into agent replies.

## Features

**Inbound**
- Text, rich-text (`post`), and `@` mentions, including bot mention stripping and `@all`
- Image/file attachments; audio, video, stickers, shared cards, locations, todo, vote, system messages, interactive cards, and merge-forward messages are converted into readable placeholders or summaries. Interactive cards and merge-forward children are expanded through the message API when available. Audio/media are transcribed first when an `asrProvider` is configured
- Message reactions as synthetic user input
- Threading via `root_id` / `parent_id`, per-chat serialization, and quote replies to the triggering message
- DM sender allowlists, group chat allowlists, per-group sender allowlists, `requireMention`, and `systemPrompt` injection
- `event_id` deduplication and stale-event rejection

**Outbound**
- CardKit v2 streaming replies — default, using CardKit entities, `card_id` delivery, element sequence updates, and terminal streaming-mode shutdown
- `post` rich-text replies and static one-shot card replies — configurable
- `createLarkSender()` outbound sender: chat/open_id/user_id targets, encoded reply targets, text chunking, native `channelData.feishu.card` cards, image/file/audio/video upload + send, ordered multi-media orchestration, paged/cached chat-member mention normalization, and required peer mention injection
- `createLarkMessageActions()` action adapter for agent/tool calls: `send`, `react`, `reactions`, `delete`, `unsend`, and `forward`
- Low-level `LarkClient` APIs: upload/send media, forward, delete, chat metadata/member management, chat member listing, CardKit, resources, and reaction listing
- Inbound ack reactions, plus message reaction add/remove/list APIs
- Custom business card action handling via `cardActionHandler`, with reply/follow-up/edit helpers

**Security**
- `X-Lark-Signature` verification (`sha256(timestamp + nonce + encrypt_key + body)`, constant-time)
- AES-256-CBC decryption of the `encrypt` envelope when `encryptKey` is configured
- Timestamp skew window (5 min default) and event-age window (10 min default)
- Event `app_id` ownership validation
- Bot self-message suppression
- Outbound remote media URL safety checks for localhost/private IP/DNS results, plus local media file root allowlists

**Interactive ask_question** — when the model calls eve's built-in `ask_question` tool, eve-lark renders the prompt as a Feishu interactive card. Single questions use button/select-style cards; multiple simultaneous questions are rendered as one submit form, including multi-select fields. Clicks come back via `card.action.trigger` and resume the parked session. `allowFreeform: true` lets the user reply with a normal chat message instead of clicking. Pending cards show a submitting state, expire after `askInputTtlMs`, can restrict submission to a specific `submitterOpenId`, and failed synthetic resume attempts restore the card so it remains retryable.

**Custom card actions** — pass `cardActionHandler` to handle `card.action.trigger` callbacks that are not produced by eve-lark's built-in ask cards. The handler receives the raw event, `action.value`, chat/message/user ids, and `respond.reply`, `respond.followUp`, and `respond.editMessage` helpers. This is a lightweight channel hook; it is not openclaw-lark's plugin-wide interactive registry.

**Commands and diagnostics** — `/lark help`, `/lark start`, `/lark doctor`, `/lark auth`, `/lark trace <message_id>`, and the legacy `/lark-diagnose` are handled by the channel and are not forwarded to the agent. `/lark doctor` reports token status, channel runtime config, and required IM/CardKit/media/reaction scopes and events.

**Both Feishu and Lark** are supported via a single `baseUrl` switch.

### Out of scope (v1)

These are intentionally **not** shipped, or are outside the IM-channel v1 scope — file an issue if you need them:
- Non-IM channel surfaces such as Drive comments and VC meeting invitations.
- Full streaming image URL resolver with async upload placeholders.
- Full i18n for all HITL/diagnostic copy.
- Multi-account configuration
- Per-user OAuth (`user_access_token` device flow)
- Feishu API tools (docs / bitable / calendar / tasks / drive)

## Quick start

Two steps. One file, one command.

**1. Declare the channel:**

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

**2. Run `eve dev`:**

```bash
pnpm add eve-lark eve
eve dev
```

That's it. The channel starts a Feishu `WSClient` as a side effect of construction — Feishu only sees the outbound WebSocket, so **no public webhook URL is needed** for local dev. Every event is re-signed and re-encrypted, then POSTed to the channel's own webhook on `localhost` where the standard handler runs (with full `send()` access).

In the [Feishu developer console](https://open.feishu.cn/app):
1. Create a **Custom App**. Note the `App ID` and `App Secret`.
2. Under **Event Subscriptions**, select **「使用长连接接收事件」** mode (not HTTP callback).
3. Generate a **Verification Token** and an **Encrypt Key** — copy both into your env.
4. Subscribe to `im.message.receive_v1`.
5. Add the bot to a chat or DM it directly.

Both transport modes work in production; the right one depends on your deployment topology. See [Production deploy](#production-deploy).

## Configuration reference

All fields can be supplied as options or read from the matching env var (options win).

| Field | Type | Required | Default | Env var |
|---|---|---|---|---|
| `appId` | `string` | yes | — | `LARK_APP_ID` |
| `appSecret` | `string` | yes | — | `LARK_APP_SECRET` |
| `verificationToken` | `string` | yes | — | `LARK_VERIFICATION_TOKEN` |
| `encryptKey` | `string` | no | — | `LARK_ENCRYPT_KEY` |
| `baseUrl` | `string` | no | `https://open.feishu.cn` | `LARK_BASE_URL` |
| `botOpenId` | `string` | no | — | `LARK_BOT_OPEN_ID` |
| `mode` | `"long-connection" \| "webhook"` | no | `"long-connection"` | `LARK_MODE` |
| `port` | `number` | no | `$PORT` or `2000` | `PORT` |
| `webhookPath` | `string` | no | `/lark/webhook` | — |
| `replyMode` | `"post" \| "streaming" \| "streaming-v2" \| "static"` | no | `"streaming-v2"` | `LARK_REPLY_MODE` |
| `streamPatchIntervalMs` | `number` | no | `1000` | — |
| `streamCreateThresholdMs` | `number` | no | `400` | — |
| `dedupTtlMs` | `number` | no | `1_800_000` (30 min) | — |
| `dedupMaxEntries` | `number` | no | `5_000` | — |
| `requestTimeoutMs` | `number` | no | `15_000` | — |
| `maxRetries` | `number` | no | `2` | — |
| `tokenRefreshBufferMs` | `number` | no | `300_000` (5 min) | — |
| `signatureSkewMs` | `number` | no | `300_000` (5 min) | — |
| `eventMaxAgeMs` | `number` | no | `600_000` (10 min) | — |
| `askInputTtlMs` | `number` | no | `300_000` (5 min) | — |
| `ackReaction` | `string \| readonly string[] \| false` | no | `"Typing"` | — |
| `allowFrom` | `readonly string[]` | no | all DMs allowed | — |
| `groupAllowFrom` | `readonly string[]` | no | all groups allowed | — |
| `groupConfigs` | `readonly { chatId: string; allowFrom?: readonly string[]; requireMention?: boolean; respondToMentionAll?: boolean; systemPrompt?: string }[]` | no | — | — |
| `asrProvider` | `{ transcribe(bytes, mediaType): Promise<string> }` | no | — | — |
| `cardActionHandler` | `(ctx) => unknown \| Promise<unknown>` | no | — | — |
| `mediaLocalRoots` | `readonly string[]` | no | local file media disabled | — |
| `mediaHostResolver` | `(hostname) => Promise<readonly string[]>` | no | Node DNS lookup | — |
| `fetch` | `typeof fetch` | no | `globalThis.fetch` | — |

## Outbound helpers

`createLarkSender()` is the direct channel sender. It accepts either the legacy `chatId` or a richer `to` target:

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

Target forms:

- `oc_xxx` or `chat:oc_xxx` → `receive_id_type=chat_id`
- `ou_xxx`, `open_id:ou_xxx`, or `feishu:ou_xxx` → `receive_id_type=open_id`
- `user:employee_id` or `{ id: "employee_id", idType: "user_id" }` → `receive_id_type=user_id`
- `#__feishu_reply_to=om_xxx` encodes a quote-reply target

`createLarkMessageActions()` exposes the same sending layer as a small agent/tool action adapter with `send`, `react`, `reactions`, `delete`, `unsend`, and `forward`.

## Feishu vs Lark (international)

The two deployments speak the same API. Switch with `baseUrl`:

```ts
createLarkChannel({
  baseUrl: "https://open.larksuite.com", // international
  // ...
});
```

Or via env: `LARK_BASE_URL=https://open.larksuite.com`.

## Reply modes

- **`streaming-v2`** (default): the channel creates a CardKit v2 entity on the first delta, sends the IM message by `card_id`, streams text through CardKit element sequence updates, then closes `streaming_mode` before writing the terminal card. It tracks reasoning text separately, renders tool trace rows, includes optional footer metrics, and stops intermediate streaming on CardKit unavailable/table-limit errors while keeping the terminal CardKit update. Best live UX this channel ships. `ask_question` prompts are still sent as separate ask cards/forms.
- **`streaming`**: same live-patch UX as `streaming-v2` but on the older v1 card schema. Slightly smaller font than v2. Opt in only if you have a specific reason to avoid CardKit v2.
- **`post`**: the channel waits for `message.completed` and delivers the reply as a `msg_type: "post"` rich-text message. **Renders at native chat-message size** with full markdown support (bold, links, code, `<font>` color tags). No live streaming — the user sees the reply only when the turn completes.
- **`static`**: same wait-for-completion delivery as `post`, but uses an interactive card instead of a post. Useful if you need card features (buttons, multi-column layout) and don't mind the smaller text.

Tune the streaming throttle with `streamPatchIntervalMs` (lower = smoother, more API calls).

```bash
LARK_REPLY_MODE=post   # opt into native-size markdown replies (no streaming)
```

## Continuation tokens & threading

eve-lark uses the chat id plus the threaded root message id as the session continuation token:

```
<chat_id>:<root_message_id>
```

For top-level conversations the root is `_`:

```
oc_xxx:_       — top-level
oc_xxx:om_yyy  — reply inside the om_yyy thread
```

A reply inside a thread keeps the thread anchor across turns. The token is namespaced by the channel id (eve's framework prepends the channel file stem), so it's safe to ship multiple custom channels alongside `lark`.

## Security model

- **Signature verification**: when `encryptKey` is set, every inbound webhook must carry a valid `X-Lark-Signature` header. Mismatch returns HTTP 401.
- **AES decryption**: with `encryptKey` set, the `encrypt` envelope is decrypted using AES-256-CBC with `key = SHA256(encrypt_key)` and the first 16 bytes as IV.
- **Timestamp skew**: requests older than `signatureSkewMs` are rejected with HTTP 408.
- **Dedup**: `event_id` is remembered for `dedupTtlMs`. Replays return 200 without re-starting a turn.
- **Serverless caveat**: dedup is in-process. Multi-instance deployments may double-process an event under rare timing windows — make your tools idempotent.

## File & image inbound

Inbound image/file messages are converted into eve `UserContent` file parts. The `data` field is a `URL` pointing at the Lark resource endpoint, so eve's pipeline calls the channel's `fetchFile` hook (which uses the bot's `tenant_access_token`) to stage the bytes for the model.

If you want URL parts to pass through without staged bytes (e.g., when running outside eve's sandbox), don't set `encryptKey` and inspect `attributes` in your tools instead.

## Group controls

Use `allowFrom` for DM sender allowlists and `groupAllowFrom` for group chat allowlists. Group messages are accepted with or without an `@` mention by default; if `botOpenId` is configured, a leading bot mention is stripped before the text reaches the agent.

`groupConfigs` lets you attach per-group sender and mention policy plus `systemPrompt`:

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
      systemPrompt: "You are the support assistant for this group. Be concise.",
    },
  ],
});
```

When `requireMention` is true, only direct bot mentions wake the agent. `@all` only wakes the agent when `respondToMentionAll` is also true. The prompt is passed to eve as `send()` context for matching group messages only. DMs ignore `groupConfigs`.

## Errors

eve-lark throws a small typed hierarchy:

```
LarkChannelError
├── LarkConfigError        — missing required option
├── LarkSignatureError     — signature verify failed (rarely thrown; usually a 401 Response)
├── LarkDecryptError       — AES decrypt failed
└── LarkApiError           — Lark API call failed (carries .code, .status, .body)
```

The webhook handler returns structured HTTP responses for predictable server-side handling:

| Status | Cause |
|---|---|
| 200 | Ack (success or intentionally ignored event) |
| 400 | Invalid JSON / decrypt failure |
| 401 | Signature missing/invalid or verification token mismatch |
| 408 | Timestamp skew window exceeded |
| 413 | Request body exceeds the 1 MB limit |

## Limitations & roadmap

**v1 limitations**: see [Out of scope](#out-of-scope-v1).

**Planned for v2** (open an issue if you'd like to prioritize any):
- Streaming image URL resolver
- Broader HITL i18n
- Optional Redis-backed dedup for multi-instance deployments
- Per-user OAuth (`user_access_token`) for Feishu API tools

## Development

```bash
pnpm install
pnpm test           # run the vitest suite
pnpm test:watch     # interactive watch mode
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm build          # tsup build → dist/
```

## Real Lark E2E tests

`pnpm test:e2e` loads `.env.e2e.local`, but the real Lark cases only run when `E2E_LARK=1` is set. Without that flag, Vitest collects the file and skips the suite.

Use a disposable test chat. The suite sends real messages, cards, reactions, and files to `E2E_LARK_CHAT_ID`, and posts a start/end summary message in that chat.

Required local setup:

- `lark-cli` is installed and logged in as a user that belongs to the test chat. The tests use it with `--as user` to send text/files, list messages, add/delete/list reactions, and discover the bot member.
- The app bot is installed in the same chat.
- The app is in **long-connection** event mode and subscribes to `im.message.receive_v1`, `card.action.trigger`, `im.message.reaction.created_v1`, and `im.message.reaction.deleted_v1`.
- The app's bot token can send/reply to IM messages, send interactive cards, use CardKit v2 card APIs, add/remove/list message reactions, upload IM images/files, download message resources, forward/delete messages sent by the bot, and list chat members. In the Feishu console this means enabling the corresponding IM/CardKit permissions; for file resource APIs the current console permission is `im:resource`.
- The default E2E suite does not rename chats or add/remove chat members. `updateChat`, `addChatMembers`, and `removeChatMembers` are covered by unit tests to avoid mutating the shared test chat.
- Local ports starting at `E2E_LARK_PORT` are free. The default base is `23080`, and the suite increments from there.

`.env.e2e.local` is gitignored. A minimal file looks like:

```bash
E2E_LARK=1
E2E_LARK_CHAT_ID=oc_xxx

LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_VERIFICATION_TOKEN=xxx
LARK_ENCRYPT_KEY=xxx          # optional unless your app has encryption enabled
LARK_BASE_URL=https://open.feishu.cn

# Optional. If omitted, the suite uses lark-cli to find the single bot in the chat.
E2E_LARK_BOT_OPEN_ID=ou_xxx

# Optional. Defaults to 23080.
E2E_LARK_PORT=23080
```

Run:

```bash
pnpm test:e2e
```

The suite currently covers outbound text/post/card/reaction/media APIs, `createLarkSender().sendPayload()` text + native card + media orchestration, non-destructive forward/delete/list-member actions, CardKit v2 streaming, long-connection inbound replies, ack reaction, per-chat queueing, quote replies, group `@` and non-`@` messages, group `requireMention`, group-level `systemPrompt`, group allowlist behavior, slash commands, custom card action reply/follow-up/edit handling, HITL text/select/multi-select form/freeform/retry/TTL flows, reaction events as synthetic input, and file inbound/resource download. Unit tests additionally cover open_id/user_id targets, encoded reply targets, the message action adapter, private media URL rejection, merge-forward expansion hooks, full-card fetch hooks, doctor scope/event output, and streaming metrics/unavailable guards.

## Smoke testing against a real Feishu app

See [`examples/README.md`](./examples/README.md) for a complete walkthrough. The TL;DR matches the [Quick start](#quick-start) above: install deps, fill `.env`, run `eve dev`. Send `ping` to the bot; expect `pong` as a streaming card.

## Production deploy

Both transport modes are supported in production — pick the one that fits your deployment topology.

- **`long-connection`** (default, WebSocket): the channel opens an outbound WS to Feishu, so **no public URL is needed**. Best fit for single-instance deployments (one container, one process). The WSClient singleton guard only dedupes within a single process — running N replicas means N independent WebSockets with every event delivered to all of them, so this mode does **not** work behind a multi-replica load balancer.
- **`webhook`** (HTTP callback): Feishu POSTs events to your public `/lark/webhook`. The load balancer routes each event to one replica, so it **scales horizontally**. Requires a publicly reachable URL.

To opt into webhook:

```ts
// agent/channels/lark.ts
export default createLarkChannel({
  // ... credentials ...
  mode: "webhook",
});
```

In the Feishu console, set **Event Subscription** to **HTTP callback**, URL = your deployed agent's `/lark/webhook`. Then:

```bash
eve build
eve deploy          # or: eve start on a server with a public URL
```

Everything else (signing, AES, streaming, ask_question) works the same in both modes. Dedup is in-process either way — see the [Serverless caveat](#security-model) for the multi-instance implication.

Test layout:

```
test/
├── allowlist.spec.ts           # DM/group allowlists, requireMention, and per-group systemPrompt
├── ask-card.spec.ts            # ask_question card builders
├── ask-flow.spec.ts            # ask_question render/callback/freeform/retry/TTL flows
├── asr.spec.ts                 # optional audio/media transcription
├── authorization.spec.ts       # eve authorization cards
├── cardkit-v2.spec.ts          # CardKit v2 builders
├── crypto.spec.ts              # signature & AES vectors (including a round-trip helper)
├── dedup.spec.ts               # TTL, FIFO eviction, lazy sweep
├── diagnose.spec.ts            # /lark command interception and diagnostics
├── event-policy.spec.ts        # app ownership, event expiry, abort text, reactions
├── options.spec.ts             # env fallback, defaults, validation
├── outbound.spec.ts            # outbound sender/media/payload/mention/action helpers
├── parse.spec.ts               # text/image/file/post/mention fixtures
├── lark-client.spec.ts         # token mutex, retry policy, CardKit, reactions, resources
├── streaming-controller.spec.ts # FSM transitions, throttle, fallback
├── channel.spec.ts             # webhook handling, queueing, abort, ack reaction
├── e2e/lark-real.spec.ts       # opt-in real Feishu/Lark E2E suite
└── helpers/
    ├── encrypt.ts              # test-only AES cipher mirror
    └── mock-fetch.ts           # tiny mock fetch used in place of nock for native-fetch compat
```

## License

MIT — see [LICENSE](./LICENSE).
