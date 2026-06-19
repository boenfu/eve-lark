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
import { isEveStartLauncher, startLongConnection } from "./long-connection.js";
import { isValidFeishuEmojiType } from "./feishu-emoji.js";
import type {
  LarkChannelOptions,
  LarkContinuationToken,
  LarkEncryptedBody,
  LarkEventBody,
  LarkInboundFile,
  ResolvedLarkOptions,
} from "./types.js";

/** Hard cap on inbound webhook body size. Feishu payloads are <10 KB; this
 *  is purely defense against a malicious or buggy peer OOMing the process. */
const MAX_BODY_BYTES = 1_000_000;

/** Drop a session's controller if it's been inactive this long. Bounds the
 *  closure-scoped `controllers`/`sessionMeta` Maps against crashes that
 *  prevent `message.completed`/`turn.failed` from firing. */
const STALE_SESSION_MS = 30 * 60 * 1000;

/** How often to sweep stale controllers. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Reply text used when the model returns null/empty — guarantees the user
 *  always sees *something* so they're not left looking at a typing emoji. */
const EMPTY_REPLY_TEXT = "(model returned no content)";

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
  /** The user message we ack-reacted to; needed to remove the reaction
   *  after delivery. Same value as `ctx.session.auth.initiator.attributes.messageId`,
   *  mirrored here so terminal handlers don't have to re-extract it. */
  messageId?: string | undefined;
  /** Reaction id returned by `addReaction`. Present once the ack-reaction
   *  POST resolves, which may be after the first terminal event fires. */
  ackReactionId?: string | undefined;
  /** When the controller was last touched. Used by the stale-sweep. */
  touchedAt: number;
}

interface ResolvedSessionInfo {
  chatId: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
  messageId?: string | undefined;
}

/**
 * Extract chat + message metadata stashed on `auth.initiator.attributes` at
 * session start. This is the canonical place to read it: closure state
 * doesn't reliably cross eve's process/worker boundary, but auth attributes
 * are persisted with the session.
 */
function sessionInfoFromCtx(ctx: { session?: { auth?: { initiator?: { attributes?: unknown } | null } | null } | null }): ResolvedSessionInfo | null {
  const attrs = (ctx.session?.auth?.initiator?.attributes ?? {}) as {
    chatId?: unknown;
    rootMessageId?: unknown;
    parentId?: unknown;
    messageId?: unknown;
  };
  if (typeof attrs.chatId !== "string" || !attrs.chatId) return null;
  return {
    chatId: attrs.chatId,
    rootId: typeof attrs.rootMessageId === "string" ? attrs.rootMessageId : undefined,
    parentId: typeof attrs.parentId === "string" ? attrs.parentId : undefined,
    messageId: typeof attrs.messageId === "string" ? attrs.messageId : undefined,
  };
}

function ackOk(): Response {
  return Response.json({ code: 0 });
}

/**
 * Resolve the configured `ackReaction` to a single valid emoji type for this
 * event, or `false` if reactions are disabled (or the configured value is
 * invalid). Picks randomly when given an array.
 *
 * Validates against {@link VALID_FEISHU_EMOJI_TYPES} because Feishu rejects
 * unknown emoji types with HTTP 400 code=231001. The validation is
 * case-sensitive — `TYPING` is invalid but `Typing` is. Without this check a
 * typo in the default or a user-supplied value fails silently on every
 * inbound message.
 */
function pickAckEmoji(reaction: string | readonly string[] | false): string | false {
  if (reaction === false) return false;
  if (typeof reaction === "string") {
    if (!isValidFeishuEmojiType(reaction)) {
      console.warn(
        `[eve-lark] ackReaction "${reaction}" is not a valid Feishu emoji type ` +
          `(case-sensitive; e.g. "Typing" not "TYPING"). Skipping ack reaction. ` +
          `See VALID_FEISHU_EMOJI_TYPES for the full list.`,
      );
      return false;
    }
    return reaction;
  }
  if (Array.isArray(reaction)) {
    const valid = reaction.filter(isValidFeishuEmojiType);
    if (valid.length === 0) {
      const sample = reaction.slice(0, 3).join(", ");
      console.warn(
        `[eve-lark] ackReaction array contains no valid Feishu emoji types ` +
          `(got [${sample}${reaction.length > 3 ? ", …" : ""}]). Skipping ack reaction.`,
      );
      return false;
    }
    if (valid.length < reaction.length) {
      const dropped = reaction.filter((e) => !isValidFeishuEmojiType(e));
      console.warn(
        `[eve-lark] ackReaction array dropped ${dropped.length} invalid emoji type(s): ` +
          `${dropped.slice(0, 3).join(", ")}`,
      );
    }
    const idx = Math.floor(Math.random() * valid.length);
    return valid[idx] ?? false;
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

function errMsgFrom(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const err = (data as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return fallback;
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
 *
 * **Delivery guarantee**: every terminal event (`message.completed` or
 * `turn.failed`) delivers *something* to the user. If the streaming card
 * path fails, we fall back to a fresh card; if that fails, plain text; if
 * even that fails, the error is logged. The user is never left looking at
 * a typing-emoji reaction with no reply.
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
  // Skip when running inside the `eve start` launcher process: eve forks
  // a nitro server child to actually serve HTTP, and both processes load
  // the channel module. Without this guard each process spawns its own
  // WSClient and Feishu delivers every event twice.
  if (options.mode === "long-connection" && !isEveStartLauncher()) {
    const eveWebhookUrl = `http://127.0.0.1:${options.port}${options.webhookPath}`;
    void startLongConnection({ resolved: options, eveWebhookUrl }).catch((e) => {
      console.error("[eve-lark] long-connection startup failed:", e);
    });
  } else if (options.mode === "long-connection" && isEveStartLauncher()) {
    console.log("[eve-lark] skipping WSClient start in eve-start launcher process; the spawned server will start it");
  }

  // Channel-scoped (closure) state. Each session has its own controller +
  // chat metadata, keyed by session.id. Bounded by the stale-sweep below.
  const controllers = new Map<string, StreamingCardController>();
  const sessionMeta = new Map<string, LarkSessionMeta>();

  function getController(sessionId: string, meta: ResolvedSessionInfo): StreamingCardController {
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
    if (sessionMeta.has(sessionId)) {
      sessionMeta.get(sessionId)!.touchedAt = Date.now();
    } else {
      sessionMeta.set(sessionId, {
        chatId: meta.chatId,
        rootId: meta.rootId,
        parentId: meta.parentId,
        messageId: meta.messageId,
        touchedAt: Date.now(),
      });
    }
    return ctrl;
  }

  function dropController(sessionId: string): void {
    controllers.delete(sessionId);
    sessionMeta.delete(sessionId);
  }

  /** Best-effort ack-reaction cleanup. Called from terminal handlers. */
  async function cleanupAckReaction(sessionId: string): Promise<void> {
    const meta = sessionMeta.get(sessionId);
    if (!meta?.ackReactionId || !meta.messageId) return;
    try {
      await client.removeReaction({
        messageId: meta.messageId,
        reactionId: meta.ackReactionId,
      });
    } catch (e) {
      console.warn(
        "[eve-lark] ack reaction cleanup failed:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  /**
   * Cascade-deliver a reply to the user. Tries (in order):
   *
   *   post mode (default — native chat size + markdown):
   *     1. sendPost                (msg_type: "post", renders at native size)
   *     2. sendText                (post POST rejected)
   *
   *   streaming mode (live card patches during the turn):
   *     1. streaming finalize      (patches existing card OR creates one)
   *     2. sendCard                (finalize failed)
   *     3. sendText                (card POST rejected)
   *
   *   static mode (one-shot card):
   *     1. sendCard                (single card with the full text)
   *     2. sendText                (card POST rejected)
   *
   * Each failure logs; we never throw out of here.
   */
  async function deliverReply(sessionId: string, info: ResolvedSessionInfo, text: string): Promise<void> {
    if (options.replyMode === "post") {
      try {
        await client.sendPost({
          chatId: info.chatId,
          content: text,
          rootId: info.rootId,
          parentId: info.parentId,
        });
        console.log(`[eve-lark] delivered via sendPost (sessionId=${sessionId})`);
        return;
      } catch (postErr) {
        console.warn(
          `[eve-lark] sendPost failed; falling back to plain text (sessionId=${sessionId}):`,
          postErr instanceof Error ? postErr.message : postErr,
        );
        // Fall through to sendText.
      }
      // post-specific fallback (skip the card cascade below).
      try {
        await client.sendText({
          chatId: info.chatId,
          content: text,
          rootId: info.rootId,
          parentId: info.parentId,
        });
        console.log(`[eve-lark] delivered via sendText fallback (sessionId=${sessionId})`);
      } catch (textErr) {
        console.error(
          `[eve-lark] sendText fallback ALSO failed; the user will not see this reply (sessionId=${sessionId}):`,
          textErr instanceof Error ? textErr.message : textErr,
        );
      }
      return;
    }

    if (options.replyMode === "streaming") {
      const ctrl = controllers.get(sessionId) ?? getController(sessionId, info);
      try {
        await ctrl.finalize(text);
        console.log(`[eve-lark] delivered via streaming finalize (sessionId=${sessionId})`);
        return;
      } catch (e) {
        console.warn(
          `[eve-lark] streaming finalize failed; falling back to fresh card (sessionId=${sessionId}):`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    try {
      await client.sendCard({
        chatId: info.chatId,
        card: buildTextCard(text),
        rootId: info.rootId,
        parentId: info.parentId,
      });
      console.log(`[eve-lark] delivered via sendCard (sessionId=${sessionId})`);
      return;
    } catch (cardErr) {
      console.warn(
        `[eve-lark] sendCard failed; falling back to plain text (sessionId=${sessionId}):`,
        cardErr instanceof Error ? cardErr.message : cardErr,
      );
    }

    try {
      await client.sendText({
        chatId: info.chatId,
        content: text,
        rootId: info.rootId,
        parentId: info.parentId,
      });
      console.log(`[eve-lark] delivered via sendText fallback (sessionId=${sessionId})`);
    } catch (textErr) {
      console.error(
        `[eve-lark] sendText fallback ALSO failed; the user will not see this reply (sessionId=${sessionId}):`,
        textErr instanceof Error ? textErr.message : textErr,
      );
    }
  }

  // Lazy sweep: drop controllers whose session hasn't been touched in
  // STALE_SESSION_MS. Guards against the case where eve crashes mid-turn.
  let lastSweepAt = 0;
  function maybeSweep(): void {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    const cutoff = now - STALE_SESSION_MS;
    for (const [id, meta] of sessionMeta) {
      if (meta.touchedAt < cutoff) {
        controllers.delete(id);
        sessionMeta.delete(id);
      }
    }
  }

  const webhookHandler = async (
    req: Request,
    helpers: RouteHandlerArgs["send"] extends never ? never : RouteHandlerArgs,
  ): Promise<Response> => {
    maybeSweep();

    // 0) Body size cap — refuse gigantic bodies before allocating.
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return new Response("request body too large", { status: 413 });
    }
    const rawBody = Buffer.from(await req.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) {
      return new Response("request body too large", { status: 413 });
    }

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

    // 13) Start/resume session.
    const session = await helpers.send(userContent as never, {
      auth: auth as never,
      continuationToken,
    });

    // 14) Remember chat metadata keyed by session.id so terminal handlers
    // can look up where to deliver replies and which reaction to clean up.
    sessionMeta.set(session.id, {
      chatId: parsed.chatId,
      rootId: parsed.rootId ?? undefined,
      parentId: parsed.parentId ?? undefined,
      messageId: parsed.messageId,
      touchedAt: Date.now(),
    });

    // 15) Ack reaction — fire-and-forget. Stash the resulting reaction id
    // so terminal handlers can remove it once the reply has been delivered.
    const emoji = pickAckEmoji(options.ackReaction);
    if (emoji) {
      const sessionId = session.id;
      helpers.waitUntil(
        client
          .addReaction({ messageId: parsed.messageId, emojiType: emoji })
          .then(({ reactionId }) => {
            const m = sessionMeta.get(sessionId);
            if (m) m.ackReactionId = reactionId;
          })
          .catch((e) => {
            console.warn(
              "[eve-lark] ack reaction failed:",
              e instanceof Error ? e.message : e,
            );
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
        if (options.replyMode !== "streaming") return;
        const sessionId = ctx.session.id;
        const info = sessionInfoFromCtx(ctx);
        if (!info) return;
        const d = data as { messageDelta?: string };
        if (typeof d.messageDelta !== "string") return;
        const ctrl = getController(sessionId, info);
        ctrl.appendDelta(d.messageDelta);
      },

      // Terminal — deliver the final reply, then clean up the ack reaction.
      async "message.completed"(data, _channel, ctx) {
        const sessionId = ctx.session.id;
        const info = sessionInfoFromCtx(ctx);
        if (!info) {
          console.warn(`[eve-lark] message.completed: no session info, cannot deliver (sessionId=${sessionId})`);
          return;
        }
        const d = data as { message?: string | null };
        const rawText = typeof d.message === "string" ? d.message : "";
        console.log(
          `[eve-lark] message.completed sessionId=${sessionId} chatId=${info.chatId} msgLen=${rawText.length}`,
        );
        const text = rawText.length > 0 ? rawText : EMPTY_REPLY_TEXT;

        try {
          await deliverReply(sessionId, info, text);
        } finally {
          await cleanupAckReaction(sessionId);
          dropController(sessionId);
        }
      },

      async "turn.failed"(data, _channel, ctx) {
        const sessionId = ctx?.session?.id;
        if (!sessionId) {
          console.warn("[eve-lark] turn.failed: no sessionId on ctx");
          return;
        }
        const info = sessionInfoFromCtx(ctx);
        if (!info) {
          console.warn(`[eve-lark] turn.failed: no session info (sessionId=${sessionId})`);
          return;
        }
        const errMsg = errMsgFrom(data, "turn failed");
        console.warn(
          `[eve-lark] turn.failed sessionId=${sessionId} chatId=${info.chatId} err="${errMsg.slice(0, 200)}"`,
        );
        const userText = `⚠ ${errMsg}`;

        // If a streaming card already exists, abort patches it with the
        // error — the user sees the failure in-place. Otherwise deliverReply
        // sends a fresh error card / text. Either way the user sees the
        // error, never a silent typing-emoji dead end.
        const ctrl = controllers.get(sessionId);
        if (ctrl) {
          try {
            await ctrl.abort(errMsg);
            console.log(`[eve-lark] error shown via streaming abort (sessionId=${sessionId})`);
          } catch (e) {
            console.warn(
              `[eve-lark] turn.failed: streaming abort failed, will deliver fresh error (sessionId=${sessionId}):`,
              e instanceof Error ? e.message : e,
            );
            try {
              await deliverReply(sessionId, info, userText);
            } catch {
              // deliverReply swallows internally; unreachable.
            }
          }
        } else {
          try {
            await deliverReply(sessionId, info, userText);
          } catch {
            // unreachable
          }
        }

        await cleanupAckReaction(sessionId);
        dropController(sessionId);
      },

      async "session.failed"(data) {
        // `session.failed` carries no `ctx`, so we can't tell which chat
        // this is. Per-session delivery happens via `turn.failed`; this
        // event is informational only.
        const errMsg = errMsgFrom(data, "session failed");
        console.error("[eve-lark] session.failed:", errMsg);
      },
    },
  });
}
