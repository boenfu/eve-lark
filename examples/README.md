# eve-lark smoke test

Reference eve agent. Once you've filled in `.env`, the full dev experience is one command — `eve dev` — because the channel itself starts the Feishu WSClient.

```
┌─────────────┐  WS (outbound)  ┌─────────────────────────────────────────┐
│  Feishu     │ <────────────── │  eve dev (single process)               │
│  cloud      │  server push    │  ├─ eve runtime + agent/channels/lark   │
└─────────────┘                 │  │   └─ createLarkChannel() side effect │
                                │  │       └─ WSClient → POST localhost   │
                                │  └─ HTTP webhook handler (in-process)   │
                                └─────────────────────────────────────────┘
```

## Prerequisites

- **Node 24+** (eve requires it). If you have nvm: `nvm use 24`.
- A Feishu custom app with **Event Subscriptions** in **「使用长连接接收事件」mode** (not HTTP callback). Subscribe to `im.message.receive_v1`.
- `App ID`, `App Secret`, `Verification Token`, and `Encrypt Key` from the Feishu developer console.
- An LLM API key. Two supported paths:
  - **OpenAI-compatible** (DeepSeek, Kimi, 智谱, Ollama, vLLM…): set `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `MODEL`.
  - **Vercel AI Gateway** (default): set `MODEL=anthropic/claude-sonnet-4.6` + `ANTHROPIC_API_KEY`, or `MODEL=openai/gpt-4o` + `OPENAI_API_KEY`.

## One-time setup

From the eve-lark repo root:

```bash
pnpm build                                  # build eve-lark so the agent can import it
cp examples/agent/.env.example examples/agent/.env
$EDITOR examples/agent/.env                 # fill in Feishu + LLM credentials
cd examples/agent && pnpm install
```

In `examples/agent/.env`:

```
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_VERIFICATION_TOKEN=xxx
LARK_ENCRYPT_KEY=xxx                # strongly recommended

# OpenAI-compatible example (DeepSeek):
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-xxx
MODEL=deepseek-chat

# Or AI-Gateway-routed model:
# MODEL=anthropic/claude-sonnet-4.6
# ANTHROPIC_API_KEY=sk-ant-xxx
```

## Run

One command:

```bash
cd examples/agent
pnpm dev            # = eve dev on port 2000
```

You should see something like:

```
 eve  v0.11.1
[DEV] server listening at http://127.0.0.1:2000/
[eve-lark] WS connected to Feishu (https://open.feishu.cn)
…
```

The `[eve-lark] WS connected` line is the side effect from `createLarkChannel()`. From here, every Feishu event flows: WSClient → re-sign + POST `localhost:2000/lark/webhook` → channel handler runs with full `send()` access → eve turn.

## Verify

1. In Feishu, DM your bot with the text `ping`.
2. The bot reacts to your message with 👍 within ~100 ms (ack-reaction).
3. A streaming card appears, gets patched live as the model streams, and finalizes with `pong`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `eve-lark: long-connection startup failed: ... requires @larksuiteoapi/node-sdk` | Forgot to install the SDK: `pnpm add @larksuiteoapi/node-sdk` |
| `eve-lark: WS error: app_id or app_secret invalid` | Wrong credentials in `.env` |
| Forwarder connects but no events arrive | Bot not added to the chat, or `im.message.receive_v1` not subscribed, or long-connection mode not selected in Feishu console |
| Bot reacts but no card reply | LLM credentials missing or wrong; check the eve dev logs for `AI_APICallError` |
| Want public-URL mode instead | Pass `mode: "webhook"` to `createLarkChannel` and configure HTTP callback in Feishu console |
