# eve-lark

English | [简体中文](./README.zh-CN.md)

A [Lark](https://www.larksuite.com) / [Feishu](https://www.feishu.cn) channel for the [eve](https://eve.dev) agent framework. Drop the factory into `agent/channels/lark.ts` and eve will mount a Lark webhook that turns inbound DMs and group mentions into streamed interactive-card replies.

## Features

**Inbound**
- Text, rich-text (`post`), `@`-mentions (including `@all`)
- Image and file attachments (downloaded server-side and staged for the model)
- Threading via `root_id` / `parent_id`
- `event_id` deduplication (handles Feishu's at-least-once retries)

**Outbound**
- Streaming interactive card (patched live during the turn) — default
- Static single-shot card reply — configurable
- Threaded replies preserve the original `root_id`

**Security**
- `X-Lark-Signature` verification (`sha256(timestamp + nonce + encrypt_key + body)`, constant-time)
- AES-256-CBC decryption of the `encrypt` envelope when `encryptKey` is configured
- Timestamp skew window (5 min default)
- Bot self-message suppression

**Interactive ask_question** — when the model calls eve's built-in `ask_question` tool, eve-lark renders the prompt as a Feishu interactive card with one button per option (`primary` / `default` / `danger` styles map to Feishu button types). Clicks come back via `card.action.trigger` and resume the parked session. `allowFreeform: true` lets the user reply with a normal chat message instead of clicking — the next inbound message in the same chat is intercepted as the answer. After an answer, the card is patched in place (buttons removed, selected option shown with a green ✓).

**Both Feishu and Lark** are supported via a single `baseUrl` switch.

### Out of scope (v1)

These are intentionally **not** shipped — file an issue if you need them:
- Audio / media / sticker / share_chat / share_user inbound (ack-and-skip only)
- Multi-account configuration
- Per-user OAuth (`user_access_token` device flow)
- Feishu API tools (docs / bitable / calendar / tasks / drive)

> Card action buttons from ask_question ARE shipped (0.3.0+). The remaining
> "card action buttons" gap in the list below refers to fully custom card
> schemas authored by the agent itself.
- Card action buttons (no interactive form handling)

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

For production, switch to HTTP-callback mode in the Feishu console and pass `mode: "webhook"` to `createLarkChannel`. See [Production](#production-deploy).

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
| `replyMode` | `"post" \| "streaming" \| "static"` | no | `"post"` | `LARK_REPLY_MODE` |
| `streamPatchIntervalMs` | `number` | no | `1000` | — |
| `streamCreateThresholdMs` | `number` | no | `400` | — |
| `dedupTtlMs` | `number` | no | `1_800_000` (30 min) | — |
| `dedupMaxEntries` | `number` | no | `5_000` | — |
| `requestTimeoutMs` | `number` | no | `15_000` | — |
| `maxRetries` | `number` | no | `2` | — |
| `tokenRefreshBufferMs` | `number` | no | `300_000` (5 min) | — |
| `signatureSkewMs` | `number` | no | `300_000` (5 min) | — |
| `ackReaction` | `string \| readonly string[] \| false` | no | `"TYPING"` | — |
| `fetch` | `typeof fetch` | no | `globalThis.fetch` | — |

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

- **`post`** (default): the channel waits for `message.completed` and delivers the reply as a `msg_type: "post"` rich-text message. **Renders at native chat-message size** with full markdown support (bold, links, code, `<font>` color tags). Tradeoff: no live streaming — the user sees the reply only when the turn completes.
- **`streaming`**: the channel creates an interactive card on the first delta, throttles live patches (~1s), and finalizes when the turn completes. **Live UX**, but card text renders smaller than native chat messages (Feishu treats cards as "structured content").
- **`static`**: same wait-for-completion delivery as `post`, but uses an interactive card instead of a post. Useful if you need card features (buttons, multi-column layout) and don't mind the smaller text.

Tune the streaming throttle with `streamPatchIntervalMs` (lower = smoother, more API calls).

```bash
LARK_REPLY_MODE=streaming   # opt into live patches
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

## Limitations & roadmap

**v1 limitations**: see [Out of scope](#out-of-scope-v1).

**Planned for v2** (open an issue if you'd like to prioritize any):
- Card action button handling (interactive forms, confirmation flows)
- Audio / media inbound transcription
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

## Smoke testing against a real Feishu app

See [`examples/README.md`](./examples/README.md) for a complete walkthrough. The TL;DR matches the [Quick start](#quick-start) above: install deps, fill `.env`, run `eve dev`. Send `ping` to the bot; expect `pong` as a streaming card.

## Production deploy

For production, switch to HTTP-callback mode:

```ts
// agent/channels/lark.ts
export default createLarkChannel({
  // ... credentials ...
  mode: "webhook",   // disables the WSClient side effect
});
```

In the Feishu console, switch **Event Subscription** from 「长连接」back to **HTTP callback**, and set the URL to your deployed agent's `/lark/webhook`. Then:

```bash
eve build
eve deploy          # or: eve start on a server with a public URL
```

Everything else (signing, AES, dedup, streaming) works unchanged.

Test layout:

```
test/
├── crypto.spec.ts              # signature & AES vectors (including a round-trip helper)
├── dedup.spec.ts               # TTL, FIFO eviction, lazy sweep
├── options.spec.ts             # env fallback, defaults, validation
├── parse.spec.ts               # text/image/file/post/mention fixtures
├── lark-client.spec.ts         # token mutex, retry policy (429/5xx/401), nock-equivalent mock
├── streaming-controller.spec.ts # FSM transitions, throttle, fallback
├── card.spec.ts                # card builders
├── channel.spec.ts             # end-to-end webhook: verify, decrypt, dedup, session start, streaming wire-up
└── helpers/
    ├── encrypt.ts              # test-only AES cipher mirror
    └── mock-fetch.ts           # tiny mock fetch used in place of nock for native-fetch compat
```

## License

MIT — see [LICENSE](./LICENSE).
