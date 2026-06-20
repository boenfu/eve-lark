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
import {
  ASK_BUTTON_VALUE_MARKER,
  buildAskAnsweredCard,
  buildAskCard,
  buildAuthCard,
  buildAuthCompletedCard,
  buildTextCard,
} from "./card.js";
import { resolveOptions } from "./options.js";
import { isEveStartLauncher, startLongConnection } from "./long-connection.js";
import { isValidFeishuEmojiType } from "./feishu-emoji.js";
import type {
  LarkCardActionTriggerEvent,
  LarkChannelOptions,
  LarkContinuationToken,
  LarkEncryptedBody,
  LarkEventBody,
  LarkInboundEvent,
  LarkInboundFile,
  LarkInputRequest,
  LarkInputResponse,
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

/**
 * Run a diagnostic check and reply with the results in the given chat.
 * Tests config validity, fetches a tenant_access_token, and reports.
 */
async function runDiagnostics(
  client: LarkClient,
  opts: ResolvedLarkOptions,
  chatId: string,
): Promise<void> {
  const lines: string[] = ["**eve-lark diagnostics**", ""];
  lines.push(`appId: \`${opts.appId}\``);
  lines.push(`baseUrl: \`${opts.baseUrl}\``);
  lines.push(`mode: \`${opts.mode}\``);
  lines.push(`replyMode: \`${opts.replyMode}\``);
  lines.push(`encryptKey: ${opts.encryptKey ? "✓ set" : "✗ not set"}`);
  lines.push(`ackReaction: \`${opts.ackReaction === false ? "disabled" : opts.ackReaction}\``);

  lines.push("");
  lines.push("**Token fetch:**");
  try {
    const token = await client.getTenantAccessToken();
    lines.push(`✓ tenant_access_token: ${token.slice(0, 8)}…`);
  } catch (e) {
    lines.push(`✗ failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const report = lines.join("\n");
  try {
    await client.sendPost({ chatId, content: report });
  } catch (e) {
    console.error("[eve-lark] diagnostic report delivery failed:", e);
  }
}

/**
 * Port of eve's `formatErrorHint` from `#internal/logging.js`.
 *
 * Builds a ` (name: message)` hint from a turn.failed/session.failed event's
 * data payload. Reads `data.details.name` (error class, e.g. "AI_APICallError")
 * and `data.message` (the actual reason, e.g. a rate-limit string). Both are
 * optional; the hint is empty when neither is present so callers can
 * interpolate unconditionally: `` `I hit an error${hint}.` ``
 *
 * Truncated to 160 chars (matching eve) to keep one-line Feishu replies
 * readable.
 */
function formatErrorHint(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const d = data as { details?: unknown; message?: unknown };
  const detailsName =
    typeof d.details === "object" && d.details !== null
      ? (d.details as { name?: unknown }).name
      : undefined;
  const name =
    typeof detailsName === "string" && detailsName.length > 0 ? detailsName : undefined;
  const message = typeof d.message === "string" ? d.message.trim() : "";
  if (name && message.length > 0) return ` (${name}: ${truncateForDisplay(message)})`;
  if (name) return ` (${name})`;
  if (message.length > 0) return ` (${truncateForDisplay(message)})`;
  return "";
}

/**
 * Port of eve's `extractErrorId`. Reads `data.details.errorId` if present —
 * a UUID users can quote to support. Returns undefined when absent.
 */
function extractErrorId(details: unknown): string | undefined {
  if (typeof details === "object" && details !== null) {
    const id = (details as { errorId?: unknown }).errorId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

function truncateForDisplay(s: string, max = 160): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Compose a user-facing error message from a turn.failed/session.failed
 * event. Mirrors eve's official channel output:
 *
 *   `⚠ I hit an error while handling your request (AI_APICallError: <reason>). (Error id: <uuid>)`
 *
 * Always returns a non-empty string. If `data` has no useful info, falls back
 * to `⚠ <fallbackReason>` (e.g. "turn failed").
 */
function formatFailureMessage(
  data: unknown,
  fallback: string,
  opts: { sentence: "turn" | "session" } = { sentence: "turn" },
): string {
  const hint = formatErrorHint(data);
  const errorId = extractErrorId((data as { details?: unknown } | null)?.details);
  const lead =
    opts.sentence === "session"
      ? "This session couldn't recover from an error"
      : "I hit an error while handling your request";
  const idSuffix = errorId ? ` (Error id: ${errorId})` : "";
  // If we have neither hint nor errorId, prefer the explicit fallback so
  // users get "turn failed" rather than the same string every time. With
  // hint or errorId present, the lead-in alone is informative enough.
  if (!hint && !errorId) return `⚠ ${fallback}`;
  return `⚠ ${lead}${hint}.${idSuffix}`;
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

  // Pending ask_question input requests, keyed by eve's requestId. Used to
  // resolve card.action.trigger callbacks back to the originating session.
  // Also keyed by chat-continuation-token for freeform interception.
  interface PendingInput {
    requestId: string;
    sessionId: string;
    chatId: string;
    rootId?: string | undefined;
    parentId?: string | undefined;
    /** The card message id we sent (so we can patch it after the user answers). */
    cardMessageId?: string | undefined;
    /** Full request, so the post-click renderer can show selected label. */
    request: LarkInputRequest;
    /** When the pending input was registered (for stale-sweep). */
    createdAt: number;
    /** Whether to intercept the next inbound chat message as the response. */
    awaitingFreeform: boolean;
    touchedAt: number;
  }
  const pendingInputsByRequestId = new Map<string, PendingInput>();
  const pendingInputsByChatToken = new Map<string, PendingInput>();

  // Auth cards keyed by `${sessionId}:${connectionName}`. Populated by
  // authorization.required, consumed + deleted by authorization.completed.
  const authCards = new Map<string, string>();

  function getController(sessionId: string, meta: ResolvedSessionInfo): StreamingCardController {
    let ctrl = controllers.get(sessionId);
    if (!ctrl) {
      ctrl = new StreamingCardController(client, {
        chatId: meta.chatId,
        rootId: meta.rootId,
        parentId: meta.parentId,
        patchIntervalMs: options.streamPatchIntervalMs,
        createThresholdMs: options.streamCreateThresholdMs,
        useCardKitV2: options.replyMode === "streaming-v2",
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

    if (options.replyMode === "streaming" || options.replyMode === "streaming-v2") {
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
  // Also drops stale pending input requests.
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
    for (const [reqId, p] of pendingInputsByRequestId) {
      if (p.touchedAt < cutoff) {
        pendingInputsByRequestId.delete(reqId);
        const tokenKey = chatTokenKey(p.chatId, p.rootId, p.parentId);
        if (pendingInputsByChatToken.get(tokenKey)?.requestId === reqId) {
          pendingInputsByChatToken.delete(tokenKey);
        }
      }
    }
  }

  /** Compose the chat-scoped key used for freeform interception. */
  function chatTokenKey(chatId: string, rootId?: string, parentId?: string): string {
    return `${chatId}:${parentId ?? rootId ?? "_"}`;
  }

  function dropPendingInput(p: PendingInput): void {
    pendingInputsByRequestId.delete(p.requestId);
    const tokenKey = chatTokenKey(p.chatId, p.rootId, p.parentId);
    if (pendingInputsByChatToken.get(tokenKey)?.requestId === p.requestId) {
      pendingInputsByChatToken.delete(tokenKey);
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

    // 7) Dedup. Card-action callbacks dedup on open_message_id (one click
    //    per render — re-clicks after patch are no-ops because we replaced
    //    the buttons with text).
    const evtMsg = body.event as { message?: { message_id?: string }; open_message_id?: string } | undefined;
    const dedupKey = body.header?.event_id ?? evtMsg?.message?.message_id ?? evtMsg?.open_message_id;
    if (dedupKey) {
      if (dedup.has(dedupKey)) return ackOk();
      dedup.set(dedupKey);
    }

    // 8) Event-type dispatch. Two event types we own:
    //    - "im.message.receive_v1" — normal inbound message (existing flow).
    //    - "card.action.trigger"  — user clicked a button on an ask_card.
    //    Anything else is ack-and-skip.
    const eventType = body.header?.event_type;
    if (eventType === "card.action.trigger") {
      return handleCardAction(body.event as LarkCardActionTriggerEvent, helpers);
    }
    if (eventType !== "im.message.receive_v1") {
      return ackOk();
    }
    if (!body.event) return ackOk();

    // 9) Parse — body.event is now narrowed to the message-event branch.
    const parsed = parseInbound(body.event as LarkInboundEvent, options.botOpenId);

    // 10) Self-message suppression
    if (parsed.senderType === "app") {
      return ackOk();
    }

    // 10.5) Allowlist. Ack-and-drop so the user sees the message "delivered"
    // (Feishu's perspective) but the agent never wakes up. DM allowlist
    // keys on sender open_id; group allowlist keys on chat_id. Both are
    // independent — setting one doesn't restrict the other surface.
    if (parsed.chatType === "p2p" && options.allowFrom) {
      if (!options.allowFrom.includes(parsed.senderOpenId)) {
        console.log(
          `[eve-lark] dropping DM from non-allowlisted sender ${parsed.senderOpenId}`,
        );
        return ackOk();
      }
    }
    if (parsed.chatType === "group" && options.groupAllowFrom) {
      if (!options.groupAllowFrom.includes(parsed.chatId)) {
        console.log(
          `[eve-lark] dropping group message from non-allowlisted chat ${parsed.chatId}`,
        );
        return ackOk();
      }
    }

    // 10.8) Audio/media transcription. If the message has no text (audio/
    // media/sticker) and an ASR provider is configured, download the audio
    // bytes and transcribe. The transcript replaces the empty text so the
    // normal flow picks it up. If ASR fails, we fall through to step 11
    // (ack-and-skip).
    if (options.asrProvider && parsed.text === "" && parsed.files.length === 0) {
      const rawEvent = body.event as LarkInboundEvent;
      const msgType = rawEvent.message?.message_type;
      if (msgType === "audio" || msgType === "media") {
        try {
          const content = JSON.parse(rawEvent.message.content) as { file_key?: string };
          if (content.file_key) {
            const bytes = await client.downloadResource({
              messageId: parsed.messageId,
              fileKey: content.file_key,
              type: "file",
            });
            const mediaType = msgType === "audio" ? "audio/mpeg" : "video/mp4";
            const transcript = await options.asrProvider.transcribe(bytes, mediaType);
            if (transcript) {
              parsed.text = transcript;
            }
          }
        } catch (e) {
          console.warn(
            "[eve-lark] audio transcription failed, skipping message:",
            e instanceof Error ? e.message : e,
          );
        }
      }
    }

    // 11) Skip unsupported message types
    if (parsed.text === "" && parsed.files.length === 0) {
      return ackOk();
    }

    // 11.1) Built-in slash command: /lark-diagnose. Run diagnostics
    // (token fetch + config summary) and reply directly via LarkClient.
    // Does NOT forward to the agent.
    if (parsed.text.trim().toLowerCase() === "/lark-diagnose") {
      helpers.waitUntil(runDiagnostics(client, options, parsed.chatId));
      return ackOk();
    }

    // 11.5) Freeform-input interception. If this chat has a pending
    // ask_question awaiting a freeform text reply, treat this inbound
    // message as the answer instead of starting a new turn. eve resumes
    // the parked session with the user's text as InputResponse.text.
    const tokenKey = chatTokenKey(parsed.chatId, parsed.rootId ?? undefined, parsed.parentId ?? undefined);
    const pending = pendingInputsByChatToken.get(tokenKey);
    if (pending && pending.awaitingFreeform && parsed.text.length > 0) {
      const resp: LarkInputResponse = { requestId: pending.requestId, text: parsed.text };
      const resumeAttributes: Record<string, string> = {
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        chatType: parsed.chatType,
      };
      if (parsed.rootId) resumeAttributes.rootMessageId = parsed.rootId;
      if (parsed.parentId) resumeAttributes.parentMessageId = parsed.parentId;
      const resumeAuth = {
        authenticator: "lark",
        principalType: "user",
        principalId: parsed.senderOpenId,
        attributes: resumeAttributes,
      };
      const resumeToken = larkContinuationToken(parsed.chatId, parsed.parentId ?? parsed.rootId);
      try {
        await helpers.send(
          { inputResponses: [resp] } as never,
          { auth: resumeAuth as never, continuationToken: resumeToken },
        );
        // Update the card (if any) to show the typed answer.
        if (pending.cardMessageId) {
          try {
            await client.patchCard({
              messageId: pending.cardMessageId,
              card: buildAskAnsweredCard(pending.request, { kind: "freeform", text: parsed.text }),
            });
          } catch (e) {
            console.warn("[eve-lark] patchCard after freeform answer failed:", e instanceof Error ? e.message : e);
          }
        }
      } catch (e) {
        console.error("[eve-lark] freeform input-response send failed:", e instanceof Error ? e.message : e);
      } finally {
        dropPendingInput(pending);
      }
      return ackOk();
    }

    // 12) Build session inputs
    const userContent = buildUserContent(parsed.text, parsed.files, options, parsed.messageId);
    const continuationToken = larkContinuationToken(parsed.chatId, parsed.parentId ?? parsed.rootId);
    // Build auth.attributes, OMITTING null/undefined values. eve's
    // SessionAuthContext contract requires `Record<string, string | readonly
    // string[]>` — null values violate it and the `as never` cast below
    // silences TS without protecting runtime. A null `rootMessageId` (typical
    // for top-level chats where parsed.rootId is null) used to sneak through
    // and silently break helpers.send: the call returned a Session object
    // but no workflow actually ran — no [eve:harness] log, no model call,
    // no reply. Sanitize to strings-only so eve's runtime accepts the auth.
    const attributes: Record<string, string> = {
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      chatType: parsed.chatType,
    };
    if (parsed.rootId) attributes.rootMessageId = parsed.rootId;
    if (parsed.parentId) attributes.parentMessageId = parsed.parentId;
    const auth = {
      authenticator: "lark",
      principalType: "user",
      principalId: parsed.senderOpenId,
      attributes,
    };

    // 13) Start/resume session.
    // For group chats, surface any matching per-group systemPrompt as
    // `context` — eve prepends each context entry as a role:"user" message
    // before the delivery message. DMs ignore this.
    const groupConfig =
      parsed.chatType === "group"
        ? options.groupConfigs?.find((g) => g.chatId === parsed.chatId)
        : undefined;
    const sendPayload: { auth: unknown; continuationToken: string; context?: readonly string[] } = {
      auth: auth as never,
      continuationToken,
    };
    if (groupConfig?.systemPrompt) {
      sendPayload.context = [groupConfig.systemPrompt];
    }
    console.log(
      `[eve-lark] invoking helpers.send chatId=${parsed.chatId} continuationToken=${continuationToken}` +
        ` textLen=${parsed.text.length} files=${parsed.files.length}`,
    );
    let session: { id: string };
    try {
      session = await helpers.send(userContent as never, sendPayload as never);
    } catch (e) {
      console.error(
        `[eve-lark] helpers.send threw for chatId=${parsed.chatId} continuationToken=${continuationToken}:`,
        e instanceof Error ? e.message : e,
      );
      throw e;
    }
    console.log(
      `[eve-lark] helpers.send returned sessionId=${session.id} for chatId=${parsed.chatId}`,
    );

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

  /**
   * Handle a `card.action.trigger` callback from Feishu. The user clicked a
   * button on an ask_card we rendered earlier. Extract the requestId +
   * optionId from `action.value`, resume the parked eve session with an
   * InputResponse, and patch the card to show the selection.
   *
   * Buttons we created carry `{__eveLarkAsk, requestId, optionId}` in their
   * `value`. Buttons from any other source are ignored.
   */
  async function handleCardAction(
    evt: LarkCardActionTriggerEvent,
    helpers: RouteHandlerArgs,
  ): Promise<Response> {
    const value = evt.action?.value;
    if (!value || value[ASK_BUTTON_VALUE_MARKER] !== true) {
      // Not our button/select — ignore (could be from another integration).
      return ackOk();
    }
    const requestId = typeof value.requestId === "string" ? value.requestId : "";
    // optionId location depends on the source element:
    //   button:    action.value.optionId  (we put it there at render time)
    //   select_static: action.option      (Feishu returns the selected option's value string here)
    const optionId =
      (typeof value.optionId === "string" ? value.optionId : "") ||
      (typeof evt.action?.option === "string" ? evt.action.option : "");
    if (!requestId) return ackOk();

    const pending = pendingInputsByRequestId.get(requestId);
    if (!pending) {
      console.warn(
        `[eve-lark] card action for unknown requestId=${requestId} (already answered or expired)`,
      );
      return ackOk();
    }

    // ACK-FIRST: return ackOk() immediately so Feishu doesn't time out the
    // card.action.trigger callback (~3s) and revert the optimistic UI. The
    // actual work (patch the card to "answered" + resume the parked eve
    // session with the InputResponse) runs in the background via
    // helpers.waitUntil. Order within the background task matters: patch
    // FIRST so the user sees the "✓ selected" state as fast as possible,
    // THEN resume eve so model execution latency doesn't delay the visual
    // confirmation.
    const selectedOpt = pending.request.options?.find((o) => o.id === optionId);
    helpers.waitUntil(
      (async () => {
        if (pending.cardMessageId && selectedOpt) {
          try {
            await client.patchCard({
              messageId: pending.cardMessageId,
              card: buildAskAnsweredCard(pending.request, {
                kind: "option",
                label: selectedOpt.label,
              }),
            });
          } catch (e) {
            console.warn(
              "[eve-lark] patchCard after ask-answer failed:",
              e instanceof Error ? e.message : e,
            );
          }
        }

        const resp: LarkInputResponse = { requestId, optionId: optionId || undefined };
        const resumeToken = larkContinuationToken(
          pending.chatId,
          pending.parentId ?? pending.rootId ?? null,
        );
        const resumeAttributes: Record<string, string> = {
          chatId: pending.chatId,
          messageId: evt.open_message_id,
          chatType: pending.request.display === "confirmation" ? "p2p" : "group",
        };
        if (pending.rootId) resumeAttributes.rootMessageId = pending.rootId;
        if (pending.parentId) resumeAttributes.parentMessageId = pending.parentId;
        const resumeAuth = {
          authenticator: "lark",
          principalType: "user",
          principalId: evt.open_id,
          attributes: resumeAttributes,
        };
        try {
          await helpers.send(
            { inputResponses: [resp] } as never,
            { auth: resumeAuth as never, continuationToken: resumeToken },
          );
          console.log(
            `[eve-lark] ask answered via card action requestId=${requestId} optionId=${optionId}`,
          );
        } catch (e) {
          console.error(
            `[eve-lark] ask input-response send failed (requestId=${requestId}):`,
            e instanceof Error ? e.message : e,
          );
        }

        dropPendingInput(pending);
      })().catch((e) => {
        console.error("[eve-lark] card action background work failed:", e);
      }),
    );

    return ackOk();
  }

  // Channel event handlers — declared as a standalone const so tests can
  // invoke them directly (eve's defineChannel hides events on the returned
  // Channel object). createLarkChannel attaches them as `__testEvents` on
  // the returned channel for that purpose; production code never reads it.
  const channelEvents = {
    // Streaming delta — patch the card.
    "message.appended"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      if (options.replyMode !== "streaming" && options.replyMode !== "streaming-v2") return;
      const sessionId = ctx.session.id;
      const info = sessionInfoFromCtx(ctx as never);
      if (!info) return;
      const d = data as { messageDelta?: string };
      if (typeof d.messageDelta !== "string") return;
      const ctrl = getController(sessionId, info);
      ctrl.appendDelta(d.messageDelta);
    },

    // Model is about to call tools. Update the streaming card status so the
    // user sees what's happening mid-turn instead of a static typing dot.
    // Only fires when replyMode is "streaming" (cards exist). Post/static
    // modes have no live surface to update.
    async "actions.requested"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      if (options.replyMode !== "streaming" && options.replyMode !== "streaming-v2") return;
      const sessionId = ctx.session.id;
      const ctrl = controllers.get(sessionId);
      if (!ctrl) return; // no streaming card yet — nothing to update
      const d = data as { actions?: Array<{ kind?: string; toolName?: string }> };
      const names = (d.actions ?? [])
        .map((a) => a.toolName)
        .filter((n): n is string => typeof n === "string");
      if (names.length === 0) return;
      const label = names.length === 1 ? `🔧 ${names[0]}` : `🔧 ${names.join(", ")}`;
      ctrl.setStatus(label);
    },

    // A tool finished. Clear the status (the next message.appended or
    // message.completed will overwrite anyway, but clearing here gives
    // snappier feedback for long tool chains). Best-effort.
    async "action.result"(_data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      if (options.replyMode !== "streaming" && options.replyMode !== "streaming-v2") return;
      const sessionId = ctx.session.id;
      const ctrl = controllers.get(sessionId);
      if (!ctrl) return;
      ctrl.setStatus("");
    },

    // eve's ask_question (and similar HITL tools) fire this event with a
    // list of input requests. Each request becomes a Feishu card with
    // buttons (one per option) plus optional freeform hint.
    async "input.requested"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      const sessionId = ctx.session.id;
      const info = sessionInfoFromCtx(ctx as never);
      if (!info) {
        console.warn(`[eve-lark] input.requested: no session info (sessionId=${sessionId})`);
        return;
      }
      const d = data as { requests?: readonly LarkInputRequest[] };
      const requests = d.requests ?? [];
      if (requests.length === 0) return;

      console.log(
        `[eve-lark] input.requested sessionId=${sessionId} chatId=${info.chatId} count=${requests.length}`,
      );

      for (const req of requests) {
        const card = buildAskCard(req);
        let cardMessageId: string | undefined;
        try {
          const res = await client.sendCard({
            chatId: info.chatId,
            card,
            rootId: info.rootId,
            parentId: info.parentId,
          });
          cardMessageId = res.messageId;
        } catch (e) {
          console.error(
            `[eve-lark] ask card send failed (requestId=${req.requestId}):`,
            e instanceof Error ? e.message : e,
          );
          continue;
        }

        const pending: PendingInput = {
          requestId: req.requestId,
          sessionId,
          chatId: info.chatId,
          rootId: info.rootId,
          parentId: info.parentId,
          cardMessageId,
          request: req,
          createdAt: Date.now(),
          touchedAt: Date.now(),
          awaitingFreeform: req.allowFreeform === true,
        };
        pendingInputsByRequestId.set(req.requestId, pending);
        if (pending.awaitingFreeform) {
          const tokenKey = chatTokenKey(info.chatId, info.rootId, info.parentId);
          pendingInputsByChatToken.set(tokenKey, pending);
        }
      }
    },

    // Terminal — deliver the final reply, then clean up the ack reaction.
    async "message.completed"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      const sessionId = ctx.session.id;
      const info = sessionInfoFromCtx(ctx as never);
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

    async "turn.failed"(data: unknown, _channel: unknown, ctx: { session?: { id: string } } | null) {
      const sessionId = ctx?.session?.id;
      if (!sessionId) {
        console.warn("[eve-lark] turn.failed: no sessionId on ctx");
        return;
      }
      const info = sessionInfoFromCtx(ctx as never);
      if (!info) {
        console.warn(`[eve-lark] turn.failed: no session info (sessionId=${sessionId})`);
        return;
      }
      const userText = formatFailureMessage(data, "turn failed", { sentence: "turn" });
      const errorId = extractErrorId((data as { details?: unknown } | null)?.details);
      console.warn(
        `[eve-lark] turn.failed sessionId=${sessionId} chatId=${info.chatId}` +
          ` err="${userText.slice(0, 200)}"` +
          (errorId ? ` errorId=${errorId}` : ""),
      );

      const ctrl = controllers.get(sessionId);
      if (ctrl) {
        try {
          await ctrl.abort(userText);
          console.log(`[eve-lark] error shown via streaming abort (sessionId=${sessionId})`);
        } catch (e) {
          console.warn(
            `[eve-lark] turn.failed: streaming abort failed, will deliver fresh error (sessionId=${sessionId}):`,
            e instanceof Error ? e.message : e,
          );
          try {
            await deliverReply(sessionId, info, userText);
          } catch {
            // unreachable
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

    async "session.failed"(data: unknown) {
      const userText = formatFailureMessage(data, "session failed", { sentence: "session" });
      const errorId = extractErrorId((data as { details?: unknown } | null)?.details);
      console.error(
        `[eve-lark] session.failed: ${userText}` + (errorId ? ` (errorId=${errorId})` : ""),
      );
    },

    // Turn ended cleanly. eve fires this after the final message.completed
    // (or instead of it when the assistant step ended in tool-calls with no
    // visible text). Either way, free this session's controller + ack
    // reaction so we don't leak waiting for a message.completed that's
    // never coming.
    async "turn.completed"(data: unknown, _channel: unknown, ctx: { session?: { id: string } } | null) {
      const sessionId = ctx?.session?.id;
      if (!sessionId) return;
      try {
        await cleanupAckReaction(sessionId);
      } catch {
        // best-effort
      }
      dropController(sessionId);
    },

    // The agent needs the user to sign in to an external service (e.g.
    // GitHub, Slack, Linear). Render a card with a "Sign in with <X>"
    // URL button so the user can complete the flow in their browser.
    // The card message id is tracked so `authorization.completed` can
    // patch it with the outcome.
    async "authorization.required"(data: unknown, _channel: unknown, ctx: { session?: { id: string } }) {
      const sessionId = ctx?.session?.id;
      const info = sessionInfoFromCtx(ctx as never);
      if (!info || !sessionId) return;
      const d = data as {
        name?: string;
        authorization?: { displayName?: string; url?: string; userCode?: string };
      };
      const name = d.name ?? "service";
      const displayName = d.authorization?.displayName ?? name;
      const url = d.authorization?.url;
      if (!url) {
        console.warn(`[eve-lark] authorization.required for ${name}: no url, skipping card`);
        return;
      }
      const card = buildAuthCard({ displayName, url, userCode: d.authorization?.userCode });
      try {
        const res = await client.sendCard({ chatId: info.chatId, card, rootId: info.rootId, parentId: info.parentId });
        authCards.set(`${sessionId}:${name}`, res.messageId);
      } catch (e) {
        console.error(`[eve-lark] auth card send failed (${name}):`, e instanceof Error ? e.message : e);
      }
    },

    // The user completed (or declined) the external auth. Patch the card
    // we rendered in `authorization.required` to show the outcome.
    async "authorization.completed"(data: unknown, _channel: unknown, ctx: { session?: { id: string } }) {
      const sessionId = ctx?.session?.id;
      if (!sessionId) return;
      const d = data as {
        name?: string;
        outcome?: string;
        reason?: string;
        authorization?: { displayName?: string };
      };
      const name = d.name ?? "service";
      const cardMessageId = authCards.get(`${sessionId}:${name}`);
      if (!cardMessageId) return; // no prior required card (or already cleaned up)
      const displayName = d.authorization?.displayName ?? name;
      const card = buildAuthCompletedCard({
        displayName,
        outcome: d.outcome ?? "completed",
        reason: d.reason,
      });
      try {
        await client.patchCard({ messageId: cardMessageId, card });
      } catch (e) {
        console.warn(`[eve-lark] auth card patch failed (${name}):`, e instanceof Error ? e.message : e);
      }
      authCards.delete(`${sessionId}:${name}`);
    },
  };

  const channel = defineChannel({
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

    events: channelEvents,
  });

  // Test seam: expose the events map so tests can drive handlers directly
  // (eve's defineChannel hides them on the returned Channel). Production
  // code MUST NOT read this — it's typing-loose and not part of the API.
  (channel as Channel<undefined, Record<string, unknown>, Record<string, unknown>> & {
    __testEvents?: typeof channelEvents;
  }).__testEvents = channelEvents;

  return channel;
}
