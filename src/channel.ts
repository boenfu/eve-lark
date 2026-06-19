import {
  defineChannel,
  POST,
  type Channel,
  type RouteHandlerArgs,
} from "eve/channels";

import { LarkClient } from "./lark-client.js";
import { DedupMap } from "./dedup.js";
import { decryptPayload, verifySignature } from "./crypto.js";
import { parseInbound } from "./parse.js";
import { StreamingCardController } from "./streaming-controller.js";
import { buildTextCard } from "./card.js";
import { resolveOptions } from "./options.js";
import { startLongConnection } from "./long-connection.js";
import type {
  LarkChannelOptions,
  LarkContinuationToken,
  LarkEncryptedBody,
  LarkEventBody,
  LarkInboundFile,
  ResolvedLarkOptions,
} from "./types.js";

/**
 * Continuation token format: `${chatId}:${rootMessageId ?? "_"}`.
 * The framework prepends the channel file stem before handing the token to
 * the runtime; consumers should call this helper rather than concatenate.
 */
export function larkContinuationToken(
  chatId: string,
  rootMessageId: string | null,
): LarkContinuationToken {
  return `${chatId}:${rootMessageId ?? "_"}` as LarkContinuationToken;
}

interface LarkSessionMeta {
  chatId: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
}

/**
 * Extract the chat metadata we stashed on `auth.initiator.attributes` when
 * starting the session. We can't keep this in a closure-scoped Map because eve
 * may run channel event handlers across a process/worker boundary from the
 * webhook handler — closure state doesn't survive. The auth attributes are
 * persisted with the session and surface cleanly through `ctx.session.auth`.
 */
function metaFromCtx(ctx: { session?: { auth?: { initiator?: { attributes?: unknown } | null } | null } | null }): LarkSessionMeta | null {
  const attrs = (ctx.session?.auth?.initiator?.attributes ?? {}) as {
    chatId?: unknown;
    rootMessageId?: unknown;
    parentId?: unknown;
  };
  if (typeof attrs.chatId !== "string" || !attrs.chatId) return null;
  return {
    chatId: attrs.chatId,
    rootId: typeof attrs.rootMessageId === "string" ? attrs.rootMessageId : undefined,
    parentId: typeof attrs.parentId === "string" ? attrs.parentId : undefined,
  };
}

function ackOk(): Response {
  return Response.json({ code: 0 });
}

/**
 * Resolve the configured `ackReaction` to a single emoji type for this event,
 * or `false` if reactions are disabled. Picks randomly when given an array.
 */
function pickAckEmoji(reaction: string | readonly string[] | false): string | false {
  if (typeof reaction === "string") return reaction;
  if (Array.isArray(reaction)) {
    if (reaction.length === 0) return false;
    const idx = Math.floor(Math.random() * reaction.length);
    return reaction[idx] ?? false;
  }
  return false;
}

function resourceUrl(
  options: ResolvedLarkOptions,
  file: LarkInboundFile,
  messageId: string,
): string {
  const type = file.kind === "image" ? "image" : "file";
  return `${options.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(file.fileKey)}?type=${type}`;
}

/**
 * Build the eve UserContent payload from a parsed inbound event. Text comes
 * first; each inbound image/file becomes a `file` part carrying a URL pointing
 * at the Lark resource endpoint. The channel's `fetchFile` hook will stage
 * those URLs to bytes when the model runs.
 */
function buildUserContent(
  text: string,
  files: LarkInboundFile[],
  options: ResolvedLarkOptions,
  messageId: string,
): unknown[] {
  const parts: unknown[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const f of files) {
    parts.push({
      type: "file",
      data: new URL(resourceUrl(options, f, messageId)),
      mediaType: f.mediaType,
    });
  }
  return parts;
}

/**
 * Create a Lark/Feishu channel for the eve agent framework.
 *
 * The channel mounts a single POST webhook that verifies the request,
 * decrypts the body when an encrypt key is configured, deduplicates events
 * by id, parses the inbound message, and starts or resumes an eve session.
 *
 * Streaming happens via eve's native channel events: `message.appended`
 * drives live card patches, `message.completed` finalizes the card, and
 * `turn.failed` aborts it. In `replyMode: "static"` the controller is
 * skipped and `message.completed` delivers a single card.
 */
export function createLarkChannel(
  optionsInput: LarkChannelOptions,
): Channel<undefined, Record<string, unknown>, Record<string, unknown>> {
  const options = resolveOptions(optionsInput);
  const client = new LarkClient(options);
  const dedup = new DedupMap(options.dedupTtlMs, options.dedupMaxEntries);

  // Long-connection side effect: when mode is "long-connection" (the
  // default), start a Feishu WSClient in the background. Each inbound event
  // is re-signed and POSTed to this channel's webhook on localhost, where
  // the standard handler runs with full access to send() etc.
  //
  // Fire-and-forget: the channel factory returns synchronously, eve dev
  // continues to boot, and the WSClient connects in the background. Errors
  // during startup are logged but don't crash the agent.
  if (options.mode === "long-connection") {
    const eveWebhookUrl = `http://127.0.0.1:${options.port}${options.webhookPath}`;
    void startLongConnection({ resolved: options, eveWebhookUrl }).catch((e) => {
      console.error("[eve-lark] long-connection startup failed:", e);
    });
  }

  // Channel-scoped (closure) state — shared across sessions on the same
  // process. Each session has its own controller + chat metadata, keyed by
  // session.id.
  const controllers = new Map<string, StreamingCardController>();
  const sessionMeta = new Map<string, LarkSessionMeta>();

  function getController(sessionId: string, meta: LarkSessionMeta): StreamingCardController {
    let ctrl = controllers.get(sessionId);
    if (!ctrl) {
      ctrl = new StreamingCardController(client, {
        chatId: meta.chatId,
        rootId: meta.rootId,
        parentId: meta.parentId,
        patchIntervalMs: options.streamPatchIntervalMs,
        createThresholdMs: options.streamCreateThresholdMs,
      });
      controllers.set(sessionId, ctrl);
    }
    return ctrl;
  }

  function dropController(sessionId: string): void {
    controllers.delete(sessionId);
    sessionMeta.delete(sessionId);
  }

  const webhookHandler = async (
    req: Request,
    helpers: RouteHandlerArgs["send"] extends never ? never : RouteHandlerArgs,
  ): Promise<Response> => {
    const rawBody = Buffer.from(await req.arrayBuffer());

    // 1) Skew check (only enforced when a real timestamp header is present)
    const tsHeader = req.headers.get("x-lark-request-timestamp") ?? "";
    const ts = Number(tsHeader);
    if (
      tsHeader &&
      Number.isFinite(ts) &&
      ts > 0 &&
      Math.abs(Date.now() / 1000 - ts) > options.signatureSkewMs / 1000
    ) {
      return new Response("request timestamp out of skew window", { status: 408 });
    }

    // 2) Signature verify + AES decrypt when encryptKey configured
    let workingBody: Buffer = rawBody;
    if (options.encryptKey) {
      const nonce = req.headers.get("x-lark-request-nonce") ?? "";
      const sigHeader = req.headers.get("x-lark-signature");
      if (!sigHeader) return new Response("missing signature", { status: 401 });
      const ok = verifySignature({
        timestamp: tsHeader,
        nonce,
        encryptKey: options.encryptKey,
        rawBody,
        signatureHeader: sigHeader,
      });
      if (!ok) return new Response("bad signature", { status: 401 });

      try {
        const envelope = JSON.parse(rawBody.toString("utf8")) as LarkEncryptedBody;
        if (envelope.encrypt) {
          workingBody = decryptPayload(envelope.encrypt, options.encryptKey) as Buffer;
        }
      } catch {
        return new Response("decrypt failed", { status: 400 });
      }
    }

    // 3) Parse body
    let body: LarkEventBody;
    try {
      body = JSON.parse(workingBody.toString("utf8")) as LarkEventBody;
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    // 4) url_verification short-circuit
    if (body.type === "url_verification") {
      return Response.json({ challenge: body.challenge ?? "" });
    }

    // 5) Schema check
    if (body.schema !== "2.0") {
      return ackOk();
    }

    // 6) Verification-token check
    if (body.header?.token !== options.verificationToken) {
      return new Response("verification token mismatch", { status: 401 });
    }

    // 7) Dedup
    const dedupKey = body.header?.event_id ?? body.event?.message?.message_id;
    if (dedupKey) {
      if (dedup.has(dedupKey)) return ackOk();
      dedup.set(dedupKey);
    }

    // 8) Event filter — only handle text messages in v1
    if (body.header?.event_type !== "im.message.receive_v1") {
      return ackOk();
    }
    if (!body.event) return ackOk();

    // 9) Parse
    const parsed = parseInbound(body.event, options.botOpenId);

    // 10) Self-message suppression
    if (parsed.senderType === "app") {
      return ackOk();
    }

    // 11) Skip unsupported message types
    if (parsed.text === "" && parsed.files.length === 0) {
      return ackOk();
    }

    // 12) Build session inputs
    const userContent = buildUserContent(parsed.text, parsed.files, options, parsed.messageId);
    const continuationToken = larkContinuationToken(parsed.chatId, parsed.parentId ?? parsed.rootId);
    const auth = {
      authenticator: "lark",
      principalType: "user",
      principalId: parsed.senderOpenId,
      attributes: {
        chatId: parsed.chatId,
        rootMessageId: parsed.rootId,
        messageId: parsed.messageId,
        chatType: parsed.chatType,
      },
    };

    // 13) Start/resume session. Cast userContent because eve's UserContent
    // comes from the `ai` package and we intentionally don't depend on it;
    // our shape is structurally compatible (string | Array<TextPart|FilePart>).
    const session = await helpers.send(userContent as never, {
      auth: auth as never,
      continuationToken,
    });

    // 14) Remember chat metadata keyed by session.id so event handlers below
    // can look up where to deliver replies.
    sessionMeta.set(session.id, {
      chatId: parsed.chatId,
      rootId: parsed.rootId ?? undefined,
      parentId: parsed.parentId ?? undefined,
    });
    console.log("[eve-lark] session registered", session.id, "chat:", parsed.chatId);

    // 15) Ack reaction — fire-and-forget in the background so the webhook
    // returns immediately. Best-effort: a failed reaction is logged and
    // swallowed (the user will still see the streaming card eventually).
    const emoji = pickAckEmoji(options.ackReaction);
    if (emoji) {
      helpers.waitUntil(
        client
          .addReaction({ messageId: parsed.messageId, emojiType: emoji })
          .catch((e) => {
            console.warn("[eve-lark] ack reaction failed", e);
          }),
      );
    }

    return ackOk();
  };

  return defineChannel({
    routes: [POST(options.webhookPath, webhookHandler as never)],

    fetchFile: async (url: string) => {
      if (!url.startsWith(options.baseUrl)) return null;
      const m = url.match(/\/messages\/([^/]+)\/resources\/([^?]+)\?type=(image|file)/);
      if (!m || !m[1] || !m[2] || !m[3]) return null;
      return client.downloadResource({
        messageId: m[1],
        fileKey: m[2],
        type: m[3] as "image" | "file",
      });
    },

    events: {
      // Streaming delta — patch the card.
      "message.appended"(data, _channel, ctx) {
        console.log("[eve-lark] message.appended", ctx.session.id);
        if (options.replyMode !== "streaming") return;
        const sessionId = ctx.session.id;
        const meta = metaFromCtx(ctx);
        if (!meta) {
          console.log("[eve-lark] message.appended: no meta for", sessionId);
          return;
        }
        const d = data as { messageDelta?: string; messageSoFar?: string };
        const ctrl = getController(sessionId, meta);
        if (typeof d.messageDelta === "string") {
          ctrl.appendDelta(d.messageDelta);
        }
      },

      // Terminal — finalize the card OR deliver a fresh one in static mode.
      async "message.completed"(data, _channel, ctx) {
        console.log("[eve-lark] message.completed", ctx.session.id);
        const sessionId = ctx.session.id;
        const meta = metaFromCtx(ctx);
        if (!meta) {
          console.log("[eve-lark] message.completed: no meta for", sessionId);
          return;
        }
        const d = data as { message?: string | null };
        const text = typeof d.message === "string" ? d.message : "";

        if (options.replyMode === "streaming") {
          const ctrl = getController(sessionId, meta);
          try {
            await ctrl.finalize(text);
            console.log("[eve-lark] finalize done for", sessionId);
          } catch (e) {
            console.log("[eve-lark] finalize failed for", sessionId, e);
          }
          dropController(sessionId);
          return;
        }

        // Static mode: single shot delivery.
        try {
          await client.sendCard({
            chatId: meta.chatId,
            card: buildTextCard(text),
            rootId: meta.rootId,
            parentId: meta.parentId,
          });
          console.log("[eve-lark] static sendCard done for", sessionId);
        } catch (e) {
          console.log("[eve-lark] static sendCard failed:", e);
          await client.sendText({
            chatId: meta.chatId,
            content: text,
            rootId: meta.rootId,
            parentId: meta.parentId,
          });
        }
        dropController(sessionId);
      },

      async "turn.failed"(data, _channel, ctx) {
        console.log("[eve-lark] turn.failed", ctx?.session?.id);
        const sessionId = ctx?.session?.id;
        if (!sessionId) return;
        const meta = metaFromCtx(ctx);
        if (!meta) return;
        const d = data as { error?: { message?: string } | string };
        const errMsg = typeof d === "object" && d !== null && "error" in d
          ? typeof d.error === "string"
            ? d.error
            : d.error?.message ?? "turn failed"
          : "turn failed";

        if (options.replyMode === "streaming") {
          const ctrl = controllers.get(sessionId);
          if (ctrl) {
            try {
              await ctrl.abort(errMsg);
            } catch {
              // best-effort
            }
          }
        }
        dropController(sessionId);
      },

      async "session.failed"(data, _channel) {
        // No ctx for this event — we can't look up by session.id. Use the
        // continuationToken from channel ops to find the session by meta
        // match would be unreliable; instead log and move on.
        const d = data as { error?: { message?: string } };
        const errMsg = d?.error?.message ?? "session failed";
        // Best-effort: drop any controllers we know about. In practice this
        // event is rare and a missed cleanup just GCs on next process restart.
        for (const [, ctrl] of controllers) {
          try {
            await ctrl.abort(errMsg);
          } catch {
            // best-effort
          }
        }
        controllers.clear();
        sessionMeta.clear();
      },
    },
  });
}
