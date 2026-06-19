/**
 * Long-connection transport: when `mode: "long-connection"` is set on
 * {@link createLarkChannel} (the default), the channel starts a Feishu
 * `@larksuiteoapi/node-sdk` WSClient as a side effect of construction. Each
 * inbound event is re-encrypted + re-signed and POSTed to the channel's own
 * webhook on localhost, where the standard webhook handler runs (with full
 * access to `send()` etc.). This lets users run the bot against a real Feishu
 * app from `eve dev` alone — no public webhook URL, no second process.
 *
 * The SDK is a hard runtime dependency of this package (declared in
 * `dependencies`), so `pnpm add eve-lark` brings it in automatically. The
 * `import()` below is dynamic only so `mode: "webhook"` code paths don't
 * eagerly load the SDK at module import time.
 */

import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { ResolvedLarkOptions } from "./types.js";

/** A Feishu v2 envelope we forward to the channel webhook. */
export type LarkEvent = {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: Record<string, unknown>;
  event?: unknown;
  [k: string]: unknown;
};

export interface PostEventOptions {
  eveWebhookUrl: string;
  /** When set, the body is AES-encrypted and the request is signed. */
  encryptKey?: string | undefined;
  /** Override for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch | undefined;
}

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

/**
 * Forward one Feishu event to the local eve webhook. Re-encrypts and signs
 * when an `encryptKey` is set, so the channel handler exercises its own
 * signature + AES pipeline on every event.
 */
export async function postEventToWebhook(
  event: LarkEvent,
  opts: PostEventOptions,
): Promise<void> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const plain = Buffer.from(JSON.stringify(event), "utf8");
  let body: Buffer;
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (opts.encryptKey) {
    const encrypted = aesEncrypt(plain, opts.encryptKey).toString("base64");
    body = Buffer.from(JSON.stringify({ encrypt: encrypted }), "utf8");
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(8).toString("hex");
    const sig = signBody(ts, nonce, body, opts.encryptKey);
    headers["x-lark-request-timestamp"] = ts;
    headers["x-lark-request-nonce"] = nonce;
    headers["x-lark-signature"] = `sha256=${sig}`;
  } else {
    body = plain;
  }

  const res = await fetchImpl(opts.eveWebhookUrl, {
    method: "POST",
    headers,
    body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) as never,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `eve-lark: forward to ${opts.eveWebhookUrl} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}

/**
 * Post-event wrapper with a single exponential-backoff retry. Catches the
 * common case where `eve dev` is momentarily unavailable (between HMR
 * reloads, mid-restart, GC pause). Without this the event would be dropped
 * on the floor with just a log line — bad UX during dev.
 */
export async function postEventToWebhookRetry(
  event: LarkEvent,
  opts: PostEventOptions,
): Promise<void> {
  try {
    await postEventToWebhook(event, opts);
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 300));
    // Regenerate signature: timestamp/nonce moved on by ~300ms, and the
    // skew check at the channel handler would reject a stale signature.
    await postEventToWebhook(event, opts).catch((retryErr) => {
      throw retryErr instanceof Error
        ? retryErr
        : new Error(String(retryErr), { cause: firstErr });
    });
  }
}

/**
 * The Feishu SDK's EventDispatcher passes handlers a payload that may or may
 * not include the outer envelope. Rebuild a v2-shaped envelope so the channel
 * webhook can parse it the same way it parses a raw Feishu POST.
 */
export function rebuildEnvelopeFromSdkEvent(
  eventType: string,
  data: unknown,
  ctx: { appId: string; verificationToken: string },
): LarkEvent {
  const maybeHeader = (data as { header?: Record<string, unknown> })?.header;
  const header =
    maybeHeader && typeof maybeHeader === "object"
      ? maybeHeader
      : {
          event_id: `lc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          event_type: eventType,
          create_time: String(Math.floor(Date.now() / 1000)),
          token: ctx.verificationToken,
          app_id: ctx.appId,
        };
  const maybeEvent = (data as { event?: unknown })?.event;
  return {
    schema: "2.0",
    header,
    event: maybeEvent ?? data,
  };
}

export interface StartLongConnectionArgs {
  resolved: ResolvedLarkOptions;
  eveWebhookUrl: string;
  /** Override logger. */
  log?: ((msg: string) => void) | undefined;
  logError?: ((msg: string, err?: unknown) => void) | undefined;
  /** Test seam: inject a custom SDK module. */
  sdk?: unknown;
}

/**
 * Active connections keyed by `${appId}:${eveWebhookUrl}`.
 *
 * Eve's lifecycle can construct the channel module more than once (e.g.,
 * build-time scan + serve-time import, or HMR reload). Each construction
 * would naively start a fresh WSClient — Feishu then delivers every event
 * to BOTH connections, and the user sees double replies.
 *
 * Guard: if a connection for the same key is already running (or starting),
 * the second call resolves immediately without touching the SDK. On
 * failure, the slot is cleared so a retry can succeed.
 *
 * The map lives on `globalThis` so it survives module reloads (HMR, build
 * then serve) — otherwise a reloaded module instance would have its own
 * fresh map and the guard would silently fail.
 *
 * Single-process, so no lock is needed — `Map.has` + `Map.set` from the
 * same synchronous block is atomic in JS's single-threaded runtime.
 */
const GLOBAL_KEY = "__eveLarkActiveConnections";
type GlobalWithLark = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, Promise<void>>;
};
function getActiveConnections(): Map<string, Promise<void>> {
  const g = globalThis as GlobalWithLark;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/** @internal — test-only seam for resetting module state between cases. */
export function __resetLongConnectionSingletonsForTests(): void {
  getActiveConnections().clear();
}

/**
 * Start the Feishu WSClient side effect. Connects via the official SDK,
 * registers a handler that re-signs each event and POSTs it to the local eve
 * webhook. Resolves once the connection is established; the WSClient then
 * runs in the background for the lifetime of the process.
 *
 * Idempotent: a second call with the same `appId` + `eveWebhookUrl` is a
 * no-op (see {@link getActiveConnections}). Different keys (different app,
 * or different webhook URL — e.g. different `--port`) get separate WSClients.
 *
 * @throws if @larksuiteoapi/node-sdk is not installed, or the WSClient
 *         fails to establish its first connection.
 */
export async function startLongConnection(args: StartLongConnectionArgs): Promise<void> {
  const key = `${args.resolved.appId}:${args.eveWebhookUrl}`;
  const activeConnections = getActiveConnections();
  const existing = activeConnections.get(key);
  if (existing) {
    console.log(
      `[eve-lark] startLongConnection: skip (already running) key=${key} pid=${process.pid}`,
    );
    return;
  }
  console.log(
    `[eve-lark] startLongConnection: start new WSClient key=${key} pid=${process.pid}`,
  );

  const promise = (async () => {
    await doStartLongConnection(args);
  })().catch((e) => {
    // On failure, clear the slot so a future call can retry.
    activeConnections.delete(key);
    throw e;
  });

  // Synchronous set after the synchronous has-check above — atomic in JS's
  // single-threaded runtime. No race with another concurrent caller.
  activeConnections.set(key, promise);
  await promise;
}

async function doStartLongConnection(args: StartLongConnectionArgs): Promise<void> {
  const log = args.log ?? ((m: string) => console.log(`[eve-lark] ${m}`));
  const logError = args.logError ?? ((m: string, e?: unknown) => console.error(`[eve-lark] ${m}`, e ?? ""));

  const sdk = (args.sdk ?? (await loadLarkSdk())) as LarkSdk;

  const dispatcher = new sdk.EventDispatcher({
    verificationToken: args.resolved.verificationToken,
    encryptKey: args.resolved.encryptKey,
  });

  dispatcher.register({
    "im.message.receive_v1": async (data: unknown) => {
      try {
        const envelope = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", data, {
          appId: args.resolved.appId,
          verificationToken: args.resolved.verificationToken,
        });
        await postEventToWebhookRetry(envelope, {
          eveWebhookUrl: args.eveWebhookUrl,
          encryptKey: args.resolved.encryptKey,
        });
      } catch (e) {
        logError(`forward failed (event dropped)`, e);
      }
    },
  });

  const domain = args.resolved.baseUrl.includes("larksuite.com")
    ? sdk.Domain.Lark
    : sdk.Domain.Feishu;

  const wsClient = new sdk.WSClient({
    appId: args.resolved.appId,
    appSecret: args.resolved.appSecret,
    domain,
    onReady: () => log(`WS connected to Feishu (${args.resolved.baseUrl})`),
    onError: (err: Error) => logError(`WS error`, err),
    onReconnecting: () => log(`WS reconnecting…`),
    onReconnected: () => log(`WS reconnected`),
    autoReconnect: true,
  });

  await wsClient.start({ eventDispatcher: dispatcher });
}

/* eslint-disable @typescript-eslint/consistent-type-imports */
// The `import()` type query is the canonical way to express "the runtime
// namespace of this dynamic import" without making the SDK a hard dep.
type LarkSdk = typeof import("@larksuiteoapi/node-sdk");
/* eslint-enable @typescript-eslint/consistent-type-imports */

async function loadLarkSdk(): Promise<LarkSdk> {
  try {
    return await import("@larksuiteoapi/node-sdk");
  } catch {
    throw new Error(
      "eve-lark: mode:\"long-connection\" requires @larksuiteoapi/node-sdk. Install it: pnpm add @larksuiteoapi/node-sdk (or npm/yarn equivalent).",
    );
  }
}
