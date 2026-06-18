# eve-lark smoke test

Two-process setup to verify eve-lark against a real Feishu app **without exposing a public webhook URL**. The forwarder connects to Feishu via the official long-connection transport and relays each event to your local eve agent.

```
┌─────────────┐  WS (outbound)  ┌──────────────────┐  HTTP POST (localhost)  ┌────────────────┐
│  Feishu     │ ──────────────> │  ws-forwarder    │ ──────────────────────> │  eve agent     │
│  cloud      │ <────────────── │  (this process)  │ <────────────────────── │  (eve dev)     │
└─────────────┘  server push    └──────────────────┘     200 { code: 0 }     └────────────────┘
```

## Prerequisites

- **Node 24+** (eve requires it). If you have nvm: `nvm use 24`.
- A Feishu custom app with **Event Subscriptions** enabled and the **long-connection mode** selected (not the HTTP callback mode). Subscribe to `im.message.receive_v1`.
- The app's `App ID`, `App Secret`, `Verification Token`, and `Encrypt Key` from the Feishu developer console.
- An LLM API key. The agent supports two paths:
  - **OpenAI-compatible** (DeepSeek, Kimi, 智谱, Ollama, vLLM, …): set `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `MODEL`.
  - **Vercel AI Gateway** (default): set `MODEL=anthropic/claude-sonnet-4.6` + `ANTHROPIC_API_KEY`, or `MODEL=openai/gpt-4o` + `OPENAI_API_KEY`.

## One-time setup

From the eve-lark repo root:

```bash
# 1. Build the eve-lark library so the agent can import it
pnpm build

# 2. Copy the env template and fill in credentials
cp examples/agent/.env.example examples/agent/.env
$EDITOR examples/agent/.env
```

In `examples/agent/.env`, fill at least:

```
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_VERIFICATION_TOKEN=xxx
LARK_ENCRYPT_KEY=xxx                # strongly recommended
LARK_BOT_OPEN_ID=ou_xxx             # optional, improves mention gating

# OpenAI-compatible endpoint example (DeepSeek):
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-xxx
MODEL=deepseek-chat

# Or, AI-Gateway-routed model (default path):
# MODEL=anthropic/claude-sonnet-4.6
# ANTHROPIC_API_KEY=sk-ant-xxx
```

Then install the agent's deps:

```bash
cd examples/agent
pnpm install
```

## Running

You need two terminals.

**Terminal A — eve agent (HTTP server):**

```bash
cd examples/agent
pnpm dev           # = eve dev, listens on http://localhost:2000
```

**Terminal B — WS forwarder (Feishu → localhost):**

```bash
# from eve-lark repo root
pnpm tsx examples/ws-forwarder.ts
```

You should see:

```
[ws-forwarder] base URL: https://open.feishu.cn
[ws-forwarder] eve webhook target: http://localhost:2000/lark/webhook
[ws-forwarder] encrypt+sign: on
[ws-forwarder] ✅ WS connected to Feishu
[ws-forwarder] listening. Ctrl-C to stop.
```

## Verifying

1. Open Feishu, find your bot, send it a DM with the text `ping`.
2. In the forwarder log you should see `← feishu im.message.receive_v1` followed by `→ eve 200 {"code":0}`.
3. In the eve dev TUI you should see a new turn start, model output streaming, and turn completion.
4. In Feishu, the bot should reply with `pong` (per `agent/instructions.md`). For streaming mode the reply arrives as an interactive card that updates live.

If signature or decryption fails, the forwarder's `→ eve` line will show `401` or `400`. Double-check that `LARK_ENCRYPT_KEY`, `LARK_VERIFICATION_TOKEN`, and `LARK_APP_SECRET` in `.env` exactly match the Feishu console.

## What this exercises

End-to-end through the eve-lark library:

- WSClient connection + Feishu's auto-reconnect
- EventDispatcher signature verify + AES decrypt (done by the SDK on the inbound side)
- Re-encryption + re-signing in the forwarder (so the channel handler exercises its own verify + decrypt)
- `event_id` dedup
- `im.message.receive_v1` parse (text, mentions, image, file)
- Continuation token minting and session start via `send()`
- Streaming card FSM via `message.appended` → `message.completed` events
- Thread reply via `root_id` / `parent_id`

## What this does NOT exercise

- Real webhook URL configuration in Feishu (you'd switch the app to HTTP callback mode for that — see the main README).
- Production deployment to Vercel (use `eve deploy` once the smoke test passes).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `WS error: app_id or app_secret invalid` | Wrong credentials in `.env` |
| `→ eve 401 verification token mismatch` | `LARK_VERIFICATION_TOKEN` differs between forwarder and agent `.env` |
| `→ eve 400 decrypt failed` | `LARK_ENCRYPT_KEY` differs between forwarder and agent |
| Forwarder connects but no events arrive | Bot not added to the chat, or event subscription not enabled, or long-connection mode not selected in Feishu console |
| eve agent starts but no reply in Feishu | Check `OPENAI_API_KEY` / `OPENAI_BASE_URL` (or `ANTHROPIC_API_KEY` for AI-Gateway mode); watch the eve TUI for errors |
