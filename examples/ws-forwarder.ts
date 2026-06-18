/**
 * WS forwarder for eve-lark smoke tests.
 *
 * Connects to Feishu via the official long-connection transport
 * (`@larksuiteoapi/node-sdk` WSClient), receives decrypted events from the
 * EventDispatcher, re-encrypts + signs each one with the same scheme eve-lark
 * expects on its HTTP webhook, and POSTs the result to a local eve agent.
 *
 * Effect: you can run the agent on localhost with no public URL — Feishu only
 * sees the outbound WebSocket. The full crypto path (signature verify + AES
 * decrypt + dedup + parse) is exercised on every event.
 *
 * Usage:
 *   1. Fill .env (LARK_APP_ID, LARK_APP_SECRET, LARK_VERIFICATION_TOKEN,
 *      LARK_ENCRYPT_KEY, optionally LARK_BASE_URL for international Lark).
 *   2. Start your eve agent (`pnpm dev` or `eve dev`) — defaults to port 2000.
 *   3. Set EVE_WEBHOOK_URL to point at it (default
 *      http://localhost:2000/lark/webhook).
 *   4. Run: `pnpm tsx examples/ws-forwarder.ts`
 *
 * The forwarder runs forever. Ctrl-C to stop.
 */

import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import {
  Domain,
  EventDispatcher,
  WSClient,
} from "@larksuiteoapi/node-sdk";

loadDotenv();

const APP_ID = required("LARK_APP_ID");
const APP_SECRET = required("LARK_APP_SECRET");
const VERIFICATION_TOKEN = required("LARK_VERIFICATION_TOKEN");
const ENCRYPT_KEY = process.env.LARK_ENCRYPT_KEY; // optional but recommended
const BASE_URL = process.env.LARK_BASE_URL ?? "https://open.feishu.cn";
const EVE_WEBHOOK_URL =
  process.env.EVE_WEBHOOK_URL ?? "http://localhost:2000/lark/webhook";

// SDK's domain field is an enum (Feishu = 0 | Lark = 1), not a URL.
const DOMAIN_ENUM = BASE_URL.includes("larksuite.com") ? Domain.Lark : Domain.Feishu;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[ws-forwarder] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// --- AES-256-CBC encrypt (mirror of eve-lark/src/crypto.ts decryptPayload) ---
function aesEncrypt(plaintext: Buffer, key: string): Buffer {
  const keyBuf = createHash("sha256").update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", keyBuf, iv);
  return Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);
}

function signBody(timestamp: string, nonce: string, body: Buffer, key: string): string {
  return createHash("sha256")
    .update(timestamp + nonce + key)
    .update(body)
    .digest("hex");
}

async function postToEve(envelope: object): Promise<void> {
  const plain = Buffer.from(JSON.stringify(envelope), "utf8");
  let body: Buffer;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (ENCRYPT_KEY) {
    const encrypted = aesEncrypt(plain, ENCRYPT_KEY).toString("base64");
    body = Buffer.from(JSON.stringify({ encrypt: encrypted }), "utf8");
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(8).toString("hex");
    const sig = signBody(ts, nonce, body, ENCRYPT_KEY);
    headers["x-lark-request-timestamp"] = ts;
    headers["x-lark-request-nonce"] = nonce;
    headers["x-lark-signature"] = `sha256=${sig}`;
  } else {
    body = plain;
  }

  const bodyInit: BodyInit = new Uint8Array(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ) as BodyInit;
  const res = await fetch(EVE_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: bodyInit,
  });
  const text = await res.text();
  console.log(
    `[ws-forwarder] → eve ${res.status} ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
  );
}

function buildEnvelope(eventType: string, data: unknown): object {
  // data is the decrypted v2 event payload. We rebuild the full envelope
  // the way Feishu would have POSTed it.
  const header = (data as { header?: Record<string, unknown> })?.header ?? {
    event_type: eventType,
    event_id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    token: VERIFICATION_TOKEN,
    create_time: String(Math.floor(Date.now() / 1000)),
    app_id: APP_ID,
  };
  return {
    schema: "2.0",
    header,
    event: (data as { event?: unknown })?.event ?? data,
  };
}

async function main(): Promise<void> {
  console.log(`[ws-forwarder] base URL: ${BASE_URL}`);
  console.log(`[ws-forwarder] eve webhook target: ${EVE_WEBHOOK_URL}`);
  console.log(`[ws-forwarder] encrypt+sign: ${ENCRYPT_KEY ? "on" : "off"}`);

  const dispatcher = new EventDispatcher({
    verificationToken: VERIFICATION_TOKEN,
    encryptKey: ENCRYPT_KEY,
  });

  dispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      console.log("[ws-forwarder] ← feishu im.message.receive_v1");
      console.log(
        `  ${JSON.stringify(data).slice(0, 200)}${JSON.stringify(data).length > 200 ? "…" : ""}`,
      );
      try {
        await postToEve(buildEnvelope("im.message.receive_v1", data));
      } catch (e) {
        console.error("[ws-forwarder] post to eve failed:", e);
      }
    },
  });

  const wsClient = new WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    domain: DOMAIN_ENUM,
    onReady: () => console.log("[ws-forwarder] ✅ WS connected to Feishu"),
    onError: (err: Error) => console.error("[ws-forwarder] ❌ WS error:", err),
    onReconnecting: () => console.log("[ws-forwarder] 🔄 WS reconnecting…"),
    onReconnected: () => console.log("[ws-forwarder] ✅ WS reconnected"),
    autoReconnect: true,
  });

  await wsClient.start({ eventDispatcher: dispatcher });

  console.log("[ws-forwarder] listening. Ctrl-C to stop.");

  // Keep the process alive.
  await new Promise(() => {
    /* never */
  });
}

main().catch((e) => {
  console.error("[ws-forwarder] fatal:", e);
  process.exit(1);
});
