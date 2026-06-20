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
  ASK_FORM_VALUE_MARKER,
  buildAskAnsweredCard,
  buildAskCard,
  buildAskExpiredCard,
  buildAskFormCard,
  buildAuthCard,
  buildAuthCompletedCard,
  buildTextCard,
} from "./card.js";
import { resolveOptions } from "./options.js";
import { isEveStartLauncher, startLongConnection } from "./long-connection.js";
import { isValidFeishuEmojiType } from "./feishu-emoji.js";
import {
  BotLoopGuard,
  ChatTaskQueue,
  isAbortText,
  isEventExpired,
  isEventOwnedByApp,
  parseReactionCreatedEvent,
} from "./event-policy.js";
import type {
  LarkCardActionTriggerEvent,
  LarkChannelOptions,
  LarkContinuationToken,
  LarkCustomCardActionContext,
  LarkEncryptedBody,
  LarkEventBody,
  LarkInboundEvent,
  LarkInboundFile,
  LarkInboundResult,
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

function formatErrorForUser(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function formatAskFallbackText(request: LarkInputRequest, error: unknown): string {
  const lines = [
    "Interactive question card failed to render in Feishu.",
    `Error: ${formatErrorForUser(error)}`,
    "",
    request.prompt,
  ];

  if (request.options && request.options.length > 0) {
    lines.push(
      "",
      "Options:",
      ...request.options.map((option, index) => {
        const description = option.description ? ` — ${option.description}` : "";
        return `${index + 1}. ${option.label}${description}`;
      }),
    );
  }

  lines.push("", "Please reply in this chat with your answer.");
  return lines.join("\n");
}

function formatPendingInputHint(request: LarkInputRequest): string {
  const lines = [
    "This conversation is waiting for your answer before it can continue.",
    "",
    request.prompt,
  ];

  if (request.options && request.options.length > 0) {
    lines.push(
      "",
      "Reply with one of:",
      ...request.options.map((option) => `- ${option.label}`),
      "",
      "You can also use the buttons on the previous card.",
    );
  } else {
    lines.push("", "Please use the previous card to answer.");
  }

  return lines.join("\n");
}

function findOptionByText(
  request: LarkInputRequest,
  text: string,
): { id: string; label: string } | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return undefined;
  return request.options?.find((option) => {
    return option.id.trim().toLowerCase() === normalized ||
      option.label.trim().toLowerCase() === normalized;
  });
}

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

function callbackJson(body: Record<string, unknown>): Response {
  return Response.json(body);
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

async function sendCommandPost(
  client: LarkClient,
  chatId: string,
  content: string,
): Promise<void> {
  try {
    await client.sendPost({ chatId, content });
  } catch (e) {
    console.error("[eve-lark] command response delivery failed:", e);
  }
}

async function runDoctor(
  client: LarkClient,
  opts: ResolvedLarkOptions,
  chatId: string,
): Promise<void> {
  const lines = [
    "**eve-lark doctor**",
    "",
    `appId: \`${opts.appId}\``,
    `baseUrl: \`${opts.baseUrl}\``,
    `mode: \`${opts.mode}\``,
    `replyMode: \`${opts.replyMode}\``,
    `eventMaxAgeMs: \`${opts.eventMaxAgeMs}\``,
    `askInputTtlMs: \`${opts.askInputTtlMs}\``,
    `encryptKey: ${opts.encryptKey ? "set" : "not set"}`,
    `botOpenId: ${opts.botOpenId ? `\`${opts.botOpenId}\`` : "not configured"}`,
    "",
    "**tenant_access_token:**",
  ];
  try {
    const token = await client.getTenantAccessToken();
    lines.push(`ok: ${token.slice(0, 8)}...`);
  } catch (e) {
    lines.push(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await sendCommandPost(client, chatId, lines.join("\n"));
}

async function runLarkCommand(
  client: LarkClient,
  opts: ResolvedLarkOptions,
  chatId: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/lark(?:\s+(.+))?$/i);
  if (!match) return false;
  const args = (match[1] ?? "help").trim();
  const [subcommandRaw, ...rest] = args.split(/\s+/);
  const subcommand = (subcommandRaw || "help").toLowerCase();

  if (subcommand === "doctor") {
    await runDoctor(client, opts, chatId);
    return true;
  }

  if (subcommand === "start") {
    await sendCommandPost(
      client,
      chatId,
      [
        "**eve-lark started**",
        "",
        "This channel is ready to receive Lark messages.",
        "Use `/lark help` for commands and `/lark doctor` for diagnostics.",
      ].join("\n"),
    );
    return true;
  }

  if (subcommand === "auth") {
    await sendCommandPost(
      client,
      chatId,
      [
        "**eve-lark auth**",
        "",
        "Channel messaging uses tenant_access_token.",
        "user_access_token is only needed for user-scoped Lark APIs, which are outside this channel package by default.",
      ].join("\n"),
    );
    return true;
  }

  if (subcommand === "trace") {
    const messageId = rest[0] ?? "";
    await sendCommandPost(
      client,
      chatId,
      [
        "**eve-lark trace**",
        "",
        messageId ? `message_id: \`${messageId}\`` : "message_id: missing",
        "Trace data is limited to this process; use logs for full delivery history.",
      ].join("\n"),
    );
    return true;
  }

  await sendCommandPost(
    client,
    chatId,
    [
      "**eve-lark commands**",
      "",
      "`/lark help` - show this help",
      "`/lark start` - show onboarding guidance",
      "`/lark doctor` - check channel config and token access",
      "`/lark auth` - explain user_access_token scope",
      "`/lark trace <message_id>` - show local trace hint for a message",
    ].join("\n"),
  );
  return true;
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

  // Channel-scoped (closure) state.
  //
  // **Per-turn** (keyed by eve turnId): each turn owns its own controller so
  // interleaved turns in conversation-mode don't overwrite each other's
  // reply rootId or share streaming-card state. `turnSources` maps a turnId
  // to the inbound messageId that started it — set by turn.started (which
  // shifts the head of the session's FIFO queue), consumed by
  // message.appended (for reply target) and message.completed/turn.failed/
  // turn.completed (for ack cleanup). `turnTouchedAt` feeds the stale-sweep.
  //
  // **Per-session** (keyed by sessionId): sessionMeta, the inbound-msgId FIFO
  // (awaiting turn.started), the last-chat-message id (diagnostic), the ack
  // reactions (keyed by INBOUND messageId), and per-`${sessionId}:${name}`
  // auth cards. These are session-level concerns that don't split per turn.
  const controllers = new Map<string, StreamingCardController>();
  const turnSources = new Map<string, string>();
  const turnTouchedAt = new Map<string, number>();
  const sessionMeta = new Map<string, LarkSessionMeta>();

  // Pending ask_question input requests, keyed by eve's requestId. Used to
  // resolve card.action.trigger callbacks back to the originating session.
  // Also keyed by chat-continuation-token for freeform interception.
  interface PendingInput {
    requestId: string;
    sessionId: string;
    /** eve turnId that emitted the input.requested (so handleCardAction can
     *  find the per-turn controller to preserve the streaming buffer above
     *  the answered ask UI). */
    turnId: string;
    chatId: string;
    rootId?: string | undefined;
    parentId?: string | undefined;
    /** The card message id we sent (so we can patch it after the user answers). */
    cardMessageId?: string | undefined;
    /** Full request, so the post-click renderer can show selected label. */
    request: LarkInputRequest;
    /** When the pending input was registered (for stale-sweep). */
    createdAt: number;
    expiresAt: number;
    expiryTimer?: ReturnType<typeof setTimeout> | undefined;
    /** Whether to intercept the next inbound chat message as the response. */
    awaitingFreeform: boolean;
    touchedAt: number;
  }
  const pendingInputsByRequestId = new Map<string, PendingInput>();
  const pendingInputsByChatToken = new Map<string, PendingInput>();
  const pendingInputsByCardMessageId = new Map<string, PendingInput[]>();

  // Auth cards keyed by `${sessionId}:${connectionName}`. Populated by
  // authorization.required, consumed + deleted by authorization.completed.
  const authCards = new Map<string, string>();

  // Ack reaction cleanup — keyed by INBOUND messageId (not sessionId) so
  // multiple messages in the same session don't overwrite each other's
  // cleanup data. eve reuses the same sessionId for conversation-mode
  // continuation; a sessionId-keyed map would lose the first message's
  // reactionId when the second arrives.
  const ackReactions = new Map<string, { reactionId: string; createdAt: number }>();

  // FIFO queue of inbound messageIds per session, awaiting turn.started.
  // turn.started shifts the head to map the incoming turnId → source message
  // (stored in turnSources). eve conversation mode reuses the same sessionId
  // for same-chat continuation, so a single-value map would lose the first
  // message's slot when the second arrives before the first turn starts.
  const currentInboundMsgIds = new Map<string, string[]>();

  // messageId of the last inbound message per chat session. The per-turn
  // controller now does quote-reply directly via turnSources (turnId → source),
  // so lastChatMessage is no longer used for "follow/interleaved" detection.
  // Kept mainly for future diagnostics/visualization; webhook still updates it.
  const lastChatMessage = new Map<string, string>();

  // Turn ids whose ack reaction has already been cleaned. eve fires both
  // message.completed AND turn.completed for turns with visible text (only
  // turn.completed for tool-call-only turns); without dedup the second event
  // would re-run cleanupAckForTurn on the same source message.
  const cleanedTurns = new Set<string>();

  const chatQueue = new ChatTaskQueue();
  const botLoopGuard = new BotLoopGuard({ maxBotTurns: 10 });
  const activeTurnsByChatKey = new Map<string, Set<string>>();
  const chatKeyByTurn = new Map<string, string>();
  const abortedTurns = new Set<string>();

  function trackActiveTurn(turnId: string, info: ResolvedSessionInfo): void {
    const key = chatTokenKey(info.chatId, info.rootId, info.parentId);
    const previousKey = chatKeyByTurn.get(turnId);
    if (previousKey && previousKey !== key) {
      activeTurnsByChatKey.get(previousKey)?.delete(turnId);
    }
    chatKeyByTurn.set(turnId, key);
    let turns = activeTurnsByChatKey.get(key);
    if (!turns) {
      turns = new Set<string>();
      activeTurnsByChatKey.set(key, turns);
    }
    turns.add(turnId);
  }

  function getController(turnId: string, meta: ResolvedSessionInfo): StreamingCardController {
    let ctrl = controllers.get(turnId);
    if (!ctrl) {
      ctrl = new StreamingCardController(client, {
        chatId: meta.chatId,
        rootId: meta.rootId,
        parentId: meta.parentId,
        patchIntervalMs: options.streamPatchIntervalMs,
        createThresholdMs: options.streamCreateThresholdMs,
        useCardKitV2: options.replyMode === "streaming-v2",
      });
      controllers.set(turnId, ctrl);
    }
    trackActiveTurn(turnId, meta);
    turnTouchedAt.set(turnId, Date.now());
    return ctrl;
  }

  /** Tear down all per-turn state for `turnId`. Idempotent — safe to call
   *  from every terminal handler (message.completed, turn.failed,
   *  turn.completed) without ordering assumptions. */
  function dropTurn(turnId: string): void {
    controllers.delete(turnId);
    turnSources.delete(turnId);
    turnTouchedAt.delete(turnId);
    const key = chatKeyByTurn.get(turnId);
    if (key) {
      const turns = activeTurnsByChatKey.get(key);
      turns?.delete(turnId);
      if (turns && turns.size === 0) activeTurnsByChatKey.delete(key);
      chatKeyByTurn.delete(turnId);
    }
  }


  /** Best-effort ack-reaction cleanup. Takes the INBOUND messageId (not
   *  sessionId) so multiple messages in the same session don't clean up
   *  each other's reactions. */
  async function cleanupAckReaction(messageId: string): Promise<void> {
    const ack = ackReactions.get(messageId);
    if (!ack) return;
    try {
      await client.removeReaction({ messageId, reactionId: ack.reactionId });
    } catch (e) {
      console.warn(
        "[eve-lark] ack reaction cleanup failed:",
        e instanceof Error ? e.message : e,
      );
    }
    ackReactions.delete(messageId);
  }

  /** Drain the oldest inbound messageId from the session's FIFO queue and
   *  clean up its ack reaction. Used when a terminal event arrives WITHOUT
   *  a turnId (so we can't look up the per-turn source). Terminal events
   *  that DO carry a turnId use {@link cleanupAckForTurn} instead. */
  async function cleanupAckForSession(sessionId: string): Promise<void> {
    const queue = currentInboundMsgIds.get(sessionId);
    if (!queue || queue.length === 0) return;
    const msgId = queue.shift();
    if (!msgId) return;
    if (queue.length === 0) currentInboundMsgIds.delete(sessionId);
    await cleanupAckReaction(msgId);
  }

  /** Clean up the ack reaction for the inbound message that started this
   *  turn (looked up via the turnId → source map populated by turn.started).
   *  Per-turn equivalent of {@link cleanupAckForSession}. */
  async function cleanupAckForTurn(turnId: string): Promise<void> {
    const sourceMsgId = turnSources.get(turnId);
    if (!sourceMsgId) return;
    await cleanupAckReaction(sourceMsgId);
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
   * `turnId` selects the per-turn controller in streaming mode; in post /
   * static mode it's ignored. Callers MUST pre-check `controllers.has(turnId)`
   * for streaming mode if they need to dedupe — deliverReply itself will
   * fall through to a fresh sendCard when no controller exists.
   *
   * Each failure logs; we never throw out of here.
   */
  async function deliverReply(turnId: string | undefined, info: ResolvedSessionInfo, text: string): Promise<void> {
    const replyRootId = turnId ? (turnSources.get(turnId) ?? info.rootId) : info.rootId;
    if (options.replyMode === "post") {
      try {
        await client.sendPost({
          chatId: info.chatId,
          content: text,
          rootId: replyRootId,
          parentId: info.parentId,
        });
        console.log(`[eve-lark] delivered via sendPost (turnId=${turnId ?? "?"})`);
        return;
      } catch (postErr) {
        console.warn(
          `[eve-lark] sendPost failed; falling back to plain text (turnId=${turnId ?? "?"}):`,
          postErr instanceof Error ? postErr.message : postErr,
        );
        // Fall through to sendText.
      }
      // post-specific fallback (skip the card cascade below).
      try {
        await client.sendText({
          chatId: info.chatId,
          content: text,
          rootId: replyRootId,
          parentId: info.parentId,
        });
        console.log(`[eve-lark] delivered via sendText fallback (turnId=${turnId ?? "?"})`);
      } catch (textErr) {
        console.error(
          `[eve-lark] sendText fallback ALSO failed; the user will not see this reply (turnId=${turnId ?? "?"}):`,
          textErr instanceof Error ? textErr.message : textErr,
        );
      }
      return;
    }

    if (options.replyMode === "streaming" || options.replyMode === "streaming-v2") {
      const ctrl = turnId ? controllers.get(turnId) : undefined;
      if (ctrl) {
        try {
          await ctrl.finalize(text);
          console.log(`[eve-lark] delivered via streaming finalize (turnId=${turnId})`);
          return;
        } catch (e) {
          console.warn(
            `[eve-lark] streaming finalize failed; falling back to fresh card (turnId=${turnId}):`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      // No controller (turn had no message.appended, e.g. a short final reply)
      // or finalize threw — fall through to a one-shot sendCard.
    }

    try {
      const res = await client.sendCard({
        chatId: info.chatId,
        card: buildTextCard(text),
        rootId: replyRootId,
        parentId: info.parentId,
      });
      console.log(`[eve-lark] delivered via sendCard (turnId=${turnId ?? "?"})`);
      void res;
      return;
    } catch (cardErr) {
      console.warn(
        `[eve-lark] sendCard failed; falling back to plain text (turnId=${turnId ?? "?"}):`,
        cardErr instanceof Error ? cardErr.message : cardErr,
      );
    }

    try {
      await client.sendText({
        chatId: info.chatId,
        content: text,
        rootId: replyRootId,
        parentId: info.parentId,
      });
      console.log(`[eve-lark] delivered via sendText fallback (turnId=${turnId ?? "?"})`);
    } catch (textErr) {
      console.error(
        `[eve-lark] sendText fallback ALSO failed; the user will not see this reply (turnId=${turnId ?? "?"}):`,
        textErr instanceof Error ? textErr.message : textErr,
      );
    }
  }

  // Lazy sweep: drop per-turn controllers/sources that haven't been touched
  // in STALE_SESSION_MS, plus stale sessionMeta and pending input requests.
  // Guards against the case where eve crashes mid-turn (no terminal event).
  let lastSweepAt = 0;
  function maybeSweep(): void {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    const cutoff = now - STALE_SESSION_MS;
    for (const [turnId, touchedAt] of turnTouchedAt) {
      if (touchedAt < cutoff) {
        dropTurn(turnId);
      }
    }
    for (const [id, meta] of sessionMeta) {
      if (meta.touchedAt < cutoff) {
        sessionMeta.delete(id);
      }
    }
    for (const [reqId, p] of pendingInputsByRequestId) {
      if (p.touchedAt < cutoff) {
        void reqId;
        dropPendingInput(p);
      }
    }
  }

  /** Compose the chat-scoped key used for freeform interception. */
  function chatTokenKey(chatId: string, rootId?: string, parentId?: string): string {
    return `${chatId}:${parentId ?? rootId ?? "_"}`;
  }

  function dropPendingInput(p: PendingInput): void {
    if (p.expiryTimer) {
      clearTimeout(p.expiryTimer);
      p.expiryTimer = undefined;
    }
    pendingInputsByRequestId.delete(p.requestId);
    const tokenKey = chatTokenKey(p.chatId, p.rootId, p.parentId);
    if (pendingInputsByChatToken.get(tokenKey)?.requestId === p.requestId) {
      pendingInputsByChatToken.delete(tokenKey);
    }
    if (p.cardMessageId) {
      const list = pendingInputsByCardMessageId.get(p.cardMessageId);
      if (list) {
        const next = list.filter((entry) => entry.requestId !== p.requestId);
        if (next.length > 0) pendingInputsByCardMessageId.set(p.cardMessageId, next);
        else pendingInputsByCardMessageId.delete(p.cardMessageId);
      }
    }
  }

  function registerPendingInput(p: PendingInput): void {
    pendingInputsByRequestId.set(p.requestId, p);
    const tokenKey = chatTokenKey(p.chatId, p.rootId, p.parentId);
    pendingInputsByChatToken.set(tokenKey, p);
    if (p.cardMessageId) {
      const existing = pendingInputsByCardMessageId.get(p.cardMessageId);
      if (existing) existing.push(p);
      else pendingInputsByCardMessageId.set(p.cardMessageId, [p]);
    }
    if (options.askInputTtlMs > 0) {
      p.expiryTimer = setTimeout(() => {
        void expirePendingInput(p);
      }, options.askInputTtlMs);
    }
  }

  async function expirePendingInput(p: PendingInput): Promise<void> {
    if (pendingInputsByRequestId.get(p.requestId) !== p) return;
    const related = p.cardMessageId
      ? pendingInputsByCardMessageId.get(p.cardMessageId) ?? [p]
      : [p];
    if (p.cardMessageId) {
      try {
        await client.patchCard({
          messageId: p.cardMessageId,
          card: buildAskExpiredCard(related.map((entry) => entry.request)),
        });
      } catch (e) {
        console.warn(
          `[eve-lark] ask input expiry patch failed (requestId=${p.requestId}):`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    for (const entry of related) {
      dropPendingInput(entry);
    }
  }

  async function abortActiveTurnsForChat(parsed: Pick<LarkInboundResult, "chatId" | "rootId" | "parentId">): Promise<boolean> {
    const key = chatTokenKey(parsed.chatId, parsed.rootId ?? undefined, parsed.parentId ?? undefined);
    const turns = activeTurnsByChatKey.get(key);
    if (!turns || turns.size === 0) return false;

    const turnIds = [...turns];
    await Promise.all(
      turnIds.map(async (turnId) => {
        abortedTurns.add(turnId);
        const ctrl = controllers.get(turnId);
        if (!ctrl) {
          dropTurn(turnId);
          return;
        }
        try {
          await ctrl.abort("Stopped by user.");
        } catch (e) {
          console.warn(
            `[eve-lark] abort fast-path failed (turnId=${turnId}):`,
            e instanceof Error ? e.message : e,
          );
        } finally {
          dropTurn(turnId);
        }
      }),
    );
    return true;
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

    if (!isEventOwnedByApp(body.header, options.appId)) {
      console.warn(
        `[eve-lark] dropping event for another app_id=${body.header?.app_id ?? "?"}`,
      );
      return ackOk();
    }

    if (isEventExpired(body.header, Date.now(), options.eventMaxAgeMs)) {
      console.warn(
        `[eve-lark] dropping stale event eventId=${body.header?.event_id ?? "?"}`,
      );
      return ackOk();
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
    let isSyntheticReaction = false;
    let reactionParsed: LarkInboundResult | null = null;
    if (eventType === "im.message.reaction.created_v1") {
      const reaction = parseReactionCreatedEvent(body.event);
      if (!reaction) return ackOk();
      let chatId = reaction.chatId;
      let chatType = reaction.chatType;
      let rootId = reaction.rootId;
      let parentId = reaction.parentId;
      if (!chatId || !chatType) {
        try {
          const context = await client.getMessageContext({ messageId: reaction.sourceMessageId });
          chatId = chatId ?? context.chatId;
          chatType = chatType ?? context.chatType;
          rootId = rootId ?? context.rootId ?? null;
          parentId = parentId ?? context.parentId ?? null;
        } catch (e) {
          console.warn(
            `[eve-lark] reaction context resolve failed messageId=${reaction.sourceMessageId}:`,
            e instanceof Error ? e.message : e,
          );
          return ackOk();
        }
      }
      if (!chatId || !chatType) return ackOk();
      reactionParsed = {
        text: reaction.text,
        files: [],
        chatId,
        rootId,
        parentId,
        messageId: reaction.messageId,
        senderOpenId: reaction.senderOpenId,
        senderType: "user",
        chatType,
        mentions: [],
      };
      isSyntheticReaction = true;
    } else if (eventType !== "im.message.receive_v1") {
      return ackOk();
    }
    if (!body.event && !reactionParsed) return ackOk();

    // 9) Parse — body.event is now narrowed to the message-event branch.
    const parsed = reactionParsed ?? parseInbound(body.event as LarkInboundEvent, options.botOpenId);

    const parsedChatKey = chatTokenKey(parsed.chatId, parsed.rootId ?? undefined, parsed.parentId ?? undefined);
    if (botLoopGuard.record(parsedChatKey, parsed.senderType)) {
      console.warn(`[eve-lark] dropping message after bot-loop threshold chatKey=${parsedChatKey}`);
      return ackOk();
    }

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

    // 10.8) Audio/media transcription. If ASR is configured, prefer the
    // transcript over the raw audio/video resource so the model receives a
    // normal text turn. If ASR fails, keep the parsed resource placeholder
    // and let the normal file path run.
    if (options.asrProvider) {
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
              parsed.files = [];
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

    if (!isSyntheticReaction && isAbortText(parsed.text)) {
      const aborted = await abortActiveTurnsForChat(parsed);
      if (aborted) return ackOk();
    }

    // 11.1) Built-in slash command: /lark-diagnose. Run diagnostics
    // (token fetch + config summary) and reply directly via LarkClient.
    // Does NOT forward to the agent.
    if (parsed.text.trim().toLowerCase() === "/lark-diagnose") {
      helpers.waitUntil(runDiagnostics(client, options, parsed.chatId));
      return ackOk();
    }
    if (/^\/lark(?:\s|$)/i.test(parsed.text.trim())) {
      helpers.waitUntil(runLarkCommand(client, options, parsed.chatId, parsed.text));
      return ackOk();
    }

    // 11.5) Pending-input interception. If this chat has a pending HITL
    // request, treat the inbound message as an answer when possible instead
    // of starting a new turn against a parked session.
    const tokenKey = chatTokenKey(parsed.chatId, parsed.rootId ?? undefined, parsed.parentId ?? undefined);
    const pending = pendingInputsByChatToken.get(tokenKey);
    if (pending && parsed.text.length > 0) {
      const matchedOption = pending.awaitingFreeform
        ? undefined
        : findOptionByText(pending.request, parsed.text);
      if (!pending.awaitingFreeform && !matchedOption) {
        try {
          await client.sendText({
            chatId: parsed.chatId,
            content: formatPendingInputHint(pending.request),
            rootId: parsed.rootId ?? undefined,
            parentId: parsed.parentId ?? undefined,
          });
        } catch (e) {
          console.error(
            "[eve-lark] pending input hint send failed:",
            e instanceof Error ? e.message : e,
          );
        }
        return ackOk();
      }

      const resp: LarkInputResponse = matchedOption
        ? { requestId: pending.requestId, optionId: matchedOption.id }
        : { requestId: pending.requestId, text: parsed.text };
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
            const answer = matchedOption
              ? { kind: "option" as const, label: matchedOption.label }
              : { kind: "freeform" as const, text: parsed.text };
            await client.patchCard({
              messageId: pending.cardMessageId,
              card: buildAskAnsweredCard(pending.request, answer),
            });
          } catch (e) {
            console.warn("[eve-lark] patchCard after text answer failed:", e instanceof Error ? e.message : e);
          }
        }
      } catch (e) {
        console.error("[eve-lark] text input-response send failed:", e instanceof Error ? e.message : e);
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
    await chatQueue.enqueue(parsedChatKey, async () => {
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

      // Enqueue this inbound messageId so turn.started can shift it off the
      // head to map the incoming turnId → source message. FIFO (not
      // single-value) because a second message arriving before the first
      // turn's turn.started must not overwrite the first message's slot.
      const queue = currentInboundMsgIds.get(session.id);
      if (queue) queue.push(parsed.messageId);
      else currentInboundMsgIds.set(session.id, [parsed.messageId]);

      // This user message is the current last inbound in the chat → record it
      // (for diagnostics/visualization). Quote-reply now locates the source
      // directly via turnSources (turnId → source); this map is not used for it.
      lastChatMessage.set(session.id, parsed.messageId);

      // 14) Remember chat metadata keyed by session.id so terminal handlers
      // can look up where to deliver replies.
      sessionMeta.set(session.id, {
        chatId: parsed.chatId,
        rootId: parsed.rootId ?? undefined,
        parentId: parsed.parentId ?? undefined,
        touchedAt: Date.now(),
      });

      // 15) Ack reaction — fire-and-forget. Stash the resulting reaction id
      // keyed by messageId (NOT sessionId) so multiple messages in the same
      // session don't overwrite each other's cleanup data.
      const emoji = isSyntheticReaction ? false : pickAckEmoji(options.ackReaction);
      if (emoji) {
        const inboundMsgId = parsed.messageId;
        helpers.waitUntil(
          client
            .addReaction({ messageId: inboundMsgId, emojiType: emoji })
            .then(({ reactionId }) => {
              ackReactions.set(inboundMsgId, { reactionId, createdAt: Date.now() });
            })
            .catch((e) => {
              console.warn(
                "[eve-lark] ack reaction failed:",
                e instanceof Error ? e.message : e,
              );
            }),
        );
      }
    });

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
    if (value?.[ASK_FORM_VALUE_MARKER] === true) {
      return handleAskFormAction(evt, helpers);
    }
    if (!value || value[ASK_BUTTON_VALUE_MARKER] !== true) {
      return handleCustomCardAction(evt);
    }
    const requestId = typeof value.requestId === "string" ? value.requestId : "";
    // optionId location depends on the source element:
    //   button:    action.value.optionId  (we put it there at render time)
    //   select_static: action.option      (Feishu returns the selected option's value string here)
    const optionId =
      (typeof value.optionId === "string" ? value.optionId : "") ||
      (typeof evt.action?.option === "string" ? evt.action.option : "");
    const pending =
      (requestId ? pendingInputsByRequestId.get(requestId) : undefined) ??
      pendingInputsByCardMessageId.get(evt.open_message_id)?.[0];
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
        const resp: LarkInputResponse = { requestId: pending.requestId, optionId: optionId || undefined };
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
          if (pending.cardMessageId && selectedOpt) {
            // If the ask was rendered inline on a streaming card, preserve
            // the controller's accumulated buffer above the answered prompt
            // so the user doesn't lose what the agent said before asking.
            const ctrlForBuffer = controllers.get(pending.turnId);
            const priorBuffer = ctrlForBuffer?.getBuffer() ?? undefined;
            try {
              await client.patchCard({
                messageId: pending.cardMessageId,
                card: buildAskAnsweredCard(
                  pending.request,
                  { kind: "option", label: selectedOpt.label },
                  priorBuffer,
                ),
              });
              // Clear the inline ask so the controller's next patch (turn 2's
              // streaming text after the user's answer resumes the session)
              // doesn't re-render the now-answered buttons.
              ctrlForBuffer?.clearAskRequest();
            } catch (e) {
              console.warn(
                "[eve-lark] patchCard after ask-answer failed:",
                e instanceof Error ? e.message : e,
              );
            }
          }
          console.log(
            `[eve-lark] ask answered via card action requestId=${requestId} optionId=${optionId}`,
          );
          dropPendingInput(pending);
        } catch (e) {
          console.error(
            `[eve-lark] ask input-response send failed (requestId=${requestId}):`,
            e instanceof Error ? e.message : e,
          );
        }
      })().catch((e) => {
        console.error("[eve-lark] card action background work failed:", e);
      }),
    );

    return ackOk();
  }

  async function handleCustomCardAction(evt: LarkCardActionTriggerEvent): Promise<Response> {
    const handler = options.cardActionHandler;
    if (!handler) return ackOk();

    const actionValue = evt.action?.value && typeof evt.action.value === "object"
      ? evt.action.value
      : {};
    const actionFromValue = actionValue.action;
    const action = typeof actionFromValue === "string" && actionFromValue.trim()
      ? actionFromValue.trim()
      : evt.action?.tag ?? "";
    const chatId = evt.open_chat_id ?? evt.context?.open_chat_id;
    const messageId = evt.open_message_id || evt.context?.open_message_id || "";
    const respond: LarkCustomCardActionContext["respond"] = {
      reply: async ({ text }) => {
        if (!chatId || !messageId || !text.trim()) return;
        return client.sendPost({ chatId, content: text, rootId: messageId });
      },
      followUp: async ({ text }) => {
        if (!chatId || !text.trim()) return;
        return client.sendPost({ chatId, content: text });
      },
      editMessage: async ({ text, card }) => {
        if (!messageId) return;
        await client.patchCard({
          messageId,
          card: card ?? buildTextCard(text ?? ""),
        });
      },
    };
    const ctx: LarkCustomCardActionContext = {
      action,
      actionValue,
      chatId,
      messageId,
      senderOpenId: evt.open_id,
      senderUserId: evt.user_id,
      tenantKey: evt.tenant_key,
      rawEvent: evt,
      client,
      respond,
    };

    try {
      const result = await handler(ctx);
      return result && typeof result === "object"
        ? callbackJson(result)
        : ackOk();
    } catch (e) {
      console.error("[eve-lark] custom card action handler failed:", e instanceof Error ? e.message : e);
      return callbackJson({ toast: { type: "error", content: "Card action failed. Please try again." } });
    }
  }

  async function handleAskFormAction(
    evt: LarkCardActionTriggerEvent,
    helpers: RouteHandlerArgs,
  ): Promise<Response> {
    const rawIds = evt.action.value.requestIds;
    const requestIds = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string")
      : [];
    const pendingList = requestIds.length > 0
      ? requestIds.map((id) => pendingInputsByRequestId.get(id)).filter((p): p is PendingInput => !!p)
      : pendingInputsByCardMessageId.get(evt.open_message_id) ?? [];
    if (pendingList.length === 0) return ackOk();

    const formValue = evt.action.form_value ?? {};
    const responses: LarkInputResponse[] = [];
    for (const pending of pendingList) {
      const raw = formValue[pending.requestId];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;
      const option = pending.request.options?.find((opt) => opt.id === value || opt.label === value);
      responses.push(option
        ? { requestId: pending.requestId, optionId: option.id }
        : { requestId: pending.requestId, text: value });
    }
    if (responses.length === 0) return ackOk();

    const first = pendingList[0]!;
    helpers.waitUntil(
      (async () => {
        const resumeToken = larkContinuationToken(
          first.chatId,
          first.parentId ?? first.rootId ?? null,
        );
        const resumeAuth = {
          authenticator: "lark",
          principalType: "user",
          principalId: evt.open_id,
          attributes: {
            chatId: first.chatId,
            messageId: evt.open_message_id,
            chatType: "p2p",
            ...(first.rootId ? { rootMessageId: first.rootId } : {}),
            ...(first.parentId ? { parentMessageId: first.parentId } : {}),
          },
        };
        try {
          await helpers.send(
            { inputResponses: responses } as never,
            { auth: resumeAuth as never, continuationToken: resumeToken },
          );
          if (first.cardMessageId) {
            try {
              await client.patchCard({
                messageId: first.cardMessageId,
                card: buildAskAnsweredCard(
                  first.request,
                  { kind: "freeform", text: "Submitted" },
                ),
              });
            } catch {
              // Visual confirmation is best-effort; the session already resumed.
            }
          }
          for (const pending of pendingList) {
            dropPendingInput(pending);
          }
        } catch (e) {
          console.error(
            "[eve-lark] ask form input-response send failed:",
            e instanceof Error ? e.message : e,
          );
        }
      })().catch((e) => {
        console.error("[eve-lark] ask form background work failed:", e);
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
      const turnId = (data as { turnId?: string } | null)?.turnId;
      if (!turnId) return;
      const d = data as { messageDelta?: string };
      if (typeof d.messageDelta !== "string") return;
      const ctrl = getController(turnId, info);
      // Quote-reply: aim this turn's card at the inbound message that
      // started it. turn.started already mapped turnId → source (shifted off
      // the session's FIFO). Each turn owns its own controller, so each card
      // quotes its OWN source — interleaved replies don't overwrite each
      // other's rootId.
      const source = turnSources.get(turnId);
      if (source) {
        console.log(`[eve-lark] quote-reply turnId=${turnId} sessionId=${sessionId} → REPLY ${source}`);
        ctrl.setReplyTarget(source);
      }
      ctrl.appendDelta(d.messageDelta);
    },

    // Model is about to call tools. Record each call on the streaming
    // controller so it shows up in the card as ⏳ name. The controller
    // creates the card immediately if it doesn't exist yet, so the user
    // sees the tool call even before any text has streamed (which is the
    // common case — model often calls tools before producing visible
    // output). Only fires for streaming modes; post/static have no live
    // surface to update.
    async "actions.requested"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      if (options.replyMode !== "streaming" && options.replyMode !== "streaming-v2") return;
      const info = sessionInfoFromCtx(ctx as never);
      if (!info) return;
      const turnId = (data as { turnId?: string } | null)?.turnId;
      if (!turnId) return;
      const d = data as { actions?: Array<{ kind?: string; toolName?: string }> };
      const names = (d.actions ?? [])
        .map((a) => a.toolName)
        .filter((n): n is string => typeof n === "string");
      if (names.length === 0) return;
      // getController (not just .get) so we create the controller if it
      // doesn't exist yet — tools can fire before any message.appended.
      const ctrl = getController(turnId, info);
      for (const name of names) {
        ctrl.addToolCall(name);
      }
    },

    // A tool finished. Mark its entry ✓ (or ✗ on failure). Stays visible —
    // the user keeps the tool history at the top of the card through end
    // of turn. Best-effort: if we can't find the controller (e.g. post
    // mode, or session already cleaned up), no-op.
    async "action.result"(data: unknown, _channel: unknown, _ctx: { session: { id: string } }) {
      if (options.replyMode !== "streaming" && options.replyMode !== "streaming-v2") return;
      const turnId = (data as { turnId?: string } | null)?.turnId;
      if (!turnId) return;
      const ctrl = controllers.get(turnId);
      if (!ctrl) return;
      const d = data as { result?: { toolName?: string; status?: string } };
      const name = d.result?.toolName;
      if (!name) return;
      ctrl.completeToolCall(name, d.result?.status === "failed");
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
      const turnId = (data as { turnId?: string } | null)?.turnId;
      if (!turnId) {
        console.warn(`[eve-lark] input.requested: no turnId (sessionId=${sessionId})`);
        return;
      }
      const d = data as { requests?: readonly LarkInputRequest[] };
      const requests = d.requests ?? [];
      if (requests.length === 0) return;

      console.log(
        `[eve-lark] input.requested sessionId=${sessionId} turnId=${turnId} chatId=${info.chatId} count=${requests.length}`,
      );

      if (requests.length > 1) {
        let cardMessageId: string | undefined;
        try {
          const res = await client.sendCard({
            chatId: info.chatId,
            card: buildAskFormCard(requests),
            rootId: info.rootId,
            parentId: info.parentId,
          });
          cardMessageId = res.messageId;
        } catch (e) {
          console.error(
            "[eve-lark] ask form card send failed:",
            e instanceof Error ? e.message : e,
          );
          return;
        }
        const now = Date.now();
        for (const req of requests) {
          registerPendingInput({
            requestId: req.requestId,
            sessionId,
            turnId,
            chatId: info.chatId,
            rootId: info.rootId,
            parentId: info.parentId,
            cardMessageId,
            request: req,
            createdAt: now,
            expiresAt: now + options.askInputTtlMs,
            touchedAt: now,
            awaitingFreeform: false,
          });
        }
        return;
      }

      for (const req of requests) {
        // Inline ask: if a streaming card already exists for this turn,
        // patch IT with the ask UI (prompt + option buttons appended below
        // the streaming text). This keeps the whole turn on one card — no
        // separate ask-card, no separate reply-card. Falls back to creating
        // a fresh ask-card when there's no streaming controller (post/static
        // reply modes, or the very first ask before any text streamed).
        const existingCtrl = controllers.get(turnId);
        const canPatchExisting =
          existingCtrl &&
          existingCtrl.getMessageId() &&
          options.replyMode === "streaming";

        let cardMessageId: string | undefined;
        let forceFreeform = false;
        if (canPatchExisting && existingCtrl) {
          existingCtrl.setAskRequest(req);
          cardMessageId = existingCtrl.getMessageId();
        } else {
          const card = buildAskCard(req);
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
            forceFreeform = true;
            try {
              await client.sendText({
                chatId: info.chatId,
                content: formatAskFallbackText(req, e),
                rootId: info.rootId,
                parentId: info.parentId,
              });
            } catch (fallbackErr) {
              console.error(
                `[eve-lark] ask fallback text send failed (requestId=${req.requestId}):`,
                fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
              );
            }
          }
        }

        const pending: PendingInput = {
          requestId: req.requestId,
          sessionId,
          turnId,
          chatId: info.chatId,
          rootId: info.rootId,
          parentId: info.parentId,
          cardMessageId,
          request: req,
          createdAt: Date.now(),
          expiresAt: Date.now() + options.askInputTtlMs,
          touchedAt: Date.now(),
          awaitingFreeform: req.allowFreeform === true || forceFreeform,
        };
        registerPendingInput(pending);
      }
    },

    // Terminal — deliver the final reply, then clean up the ack reaction.
    // The per-turn controller is NOT destroyed here: in HITL flows eve fires
    // input.requested AFTER message.completed (still in the same turn), and
    // that handler needs the controller to patch the streaming card with the
    // ask UI inline. The controller is torn down by turn.completed (the true
    // end of turn). Duplicate message.completed events on the same turn are
    // deduped by the controller's finalize() state guard (state→completed on
    // first call, no-op thereafter).
    async "message.completed"(data: unknown, _channel: unknown, ctx: { session: { id: string } }) {
      const sessionId = ctx.session.id;
      const info = sessionInfoFromCtx(ctx as never);
      if (!info) {
        console.warn(`[eve-lark] message.completed: no session info, cannot deliver (sessionId=${sessionId})`);
        return;
      }
      const d = data as { message?: string | null };
      const rawText = typeof d.message === "string" ? d.message : "";
      const mcTurnId = (data as { turnId?: string } | null)?.turnId;
      console.log(
        `[eve-lark] message.completed sessionId=${sessionId} chatId=${info.chatId} msgLen=${rawText.length}` + (mcTurnId ? ` turnId=${mcTurnId}` : ""),
      );
      const text = rawText.length > 0 ? rawText : EMPTY_REPLY_TEXT;

      const isStreaming = options.replyMode === "streaming" || options.replyMode === "streaming-v2";
      if (mcTurnId && abortedTurns.has(mcTurnId)) {
        abortedTurns.delete(mcTurnId);
        if (!cleanedTurns.has(mcTurnId)) {
          cleanedTurns.add(mcTurnId);
          await cleanupAckForTurn(mcTurnId);
        }
        dropTurn(mcTurnId);
        return;
      }
      // Streaming dedup: if the controller is already gone (turn.completed or
      // turn.failed already tore it down), skip delivery. Otherwise the
      // controller's finalize() state guard handles same-turn duplicates.
      if (isStreaming && mcTurnId && !controllers.has(mcTurnId)) {
        if (!cleanedTurns.has(mcTurnId)) {
          cleanedTurns.add(mcTurnId);
          await cleanupAckForTurn(mcTurnId);
        }
        return;
      }

      try {
        await deliverReply(mcTurnId, info, text);
      } finally {
        if (mcTurnId && !cleanedTurns.has(mcTurnId)) {
          cleanedTurns.add(mcTurnId);
          await cleanupAckForTurn(mcTurnId);
        } else if (!mcTurnId) {
          await cleanupAckForSession(sessionId);
        }
        // NOTE: do NOT dropTurn here — see the comment at the top of this
        // handler. turn.completed / turn.failed own the controller teardown.
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
      const failedTurnId = (data as { turnId?: string } | null)?.turnId;
      const userText = formatFailureMessage(data, "turn failed", { sentence: "turn" });
      const errorId = extractErrorId((data as { details?: unknown } | null)?.details);
      console.warn(
        `[eve-lark] turn.failed sessionId=${sessionId} chatId=${info.chatId}` +
          ` err="${userText.slice(0, 200)}"` +
          (failedTurnId ? ` turnId=${failedTurnId}` : "") +
          (errorId ? ` errorId=${errorId}` : ""),
      );

      const ctrl = failedTurnId ? controllers.get(failedTurnId) : undefined;
      if (ctrl) {
        try {
          await ctrl.abort(userText);
          console.log(`[eve-lark] error shown via streaming abort (turnId=${failedTurnId})`);
        } catch (e) {
          console.warn(
            `[eve-lark] turn.failed: streaming abort failed, will deliver fresh error (turnId=${failedTurnId}):`,
            e instanceof Error ? e.message : e,
          );
          try {
            await deliverReply(failedTurnId, info, userText);
          } catch {
            // unreachable
          }
        }
      } else {
        try {
          await deliverReply(failedTurnId, info, userText);
        } catch {
          // unreachable
        }
      }

      if (!failedTurnId || !cleanedTurns.has(failedTurnId)) {
        if (failedTurnId) cleanedTurns.add(failedTurnId);
        if (failedTurnId) await cleanupAckForTurn(failedTurnId);
        else await cleanupAckForSession(sessionId);
      }
      // Turn failed — destroy the per-turn controller so a later
      // message.completed/turn.completed on this turnId doesn't reuse it.
      // (message.completed itself doesn't drop, to keep the controller alive
      // for a follow-up input.requested in HITL flows.)
      if (failedTurnId) dropTurn(failedTurnId);
    },

    async "session.failed"(data: unknown) {
      const userText = formatFailureMessage(data, "session failed", { sentence: "session" });
      const errorId = extractErrorId((data as { details?: unknown } | null)?.details);
      console.error(
        `[eve-lark] session.failed: ${userText}` + (errorId ? ` (errorId=${errorId})` : ""),
      );
    },

    // A new turn is starting. Per-turn controllers mean we no longer reset
    // existing controllers here — each turn gets a fresh one (created lazily
    // in message.appended / actions.requested). The only side effect left is
    // mapping turnId → inbound source message: shift the head of the
    // session's FIFO (populated by the webhook handler) so message.appended
    // can aim this turn's card at the right user message and terminal events
    // can clean up the right ack reaction.
    async "turn.started"(_data: unknown, _channel: unknown, ctx: { session?: { id: string } } | null) {
      const sessionId = ctx?.session?.id;
      if (!sessionId) return;
      const tsTurnId = (_data as { turnId?: string } | null)?.turnId;
      console.log(`[eve-lark] turn.started sessionId=${sessionId}` + (tsTurnId ? ` turnId=${tsTurnId}` : ""));
      if (!tsTurnId) return;
      const queue = currentInboundMsgIds.get(sessionId);
      if (queue && queue.length > 0) {
        const source = queue.shift()!;
        if (queue.length === 0) currentInboundMsgIds.delete(sessionId);
        turnSources.set(tsTurnId, source);
      }
    },

    // Turn ended cleanly. eve fires this after the final message.completed
    // (or instead of it when the assistant step ended in tool-calls with no
    // visible text). Clean up the ack reaction and destroy the per-turn
    // controller (idempotent — message.completed/turn.failed may have done
    // it already).
    async "turn.completed"(data: unknown, _channel: unknown, _ctx: { session?: { id: string } } | null) {
      const turnId = (data as { turnId?: string } | null)?.turnId;
      if (!turnId) return;
      abortedTurns.delete(turnId);
      if (cleanedTurns.has(turnId)) {
        // message.completed already drained this turn — but we still drop
        // the per-turn controller (turn.completed is the LAST event for a
        // tool-only turn that never fires message.completed).
        dropTurn(turnId);
        return;
      }
      cleanedTurns.add(turnId);
      try {
        await cleanupAckForTurn(turnId);
      } catch {
        // best-effort
      }
      dropTurn(turnId);
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
