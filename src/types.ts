/**
 * Public types for eve-lark.
 */
import type { LarkClient } from "./lark-client.js";

/**
 * Discriminated union of normalized inbound message parts (text vs file).
 * Useful for consumers that want to inspect what eve-lark handed to `send()`.
 */
export type LarkInboundMessage = LarkInboundResult;

export type LarkReplyMode = "post" | "streaming" | "streaming-v2" | "static";

/**
 * How the channel receives events from Feishu.
 *
 * - `"long-connection"` (default): the channel starts a Feishu WSClient as a
 *   side effect of construction. Events arrive via the official
 *   `@larksuiteoapi/node-sdk` long-connection transport; no public webhook
 *   URL is needed. Requires `@larksuiteoapi/node-sdk` to be installed.
 * - `"webhook"`: pure HTTP. The channel mounts a POST webhook only; Feishu
 *   must be configured for HTTP callback mode with a public URL pointing at
 *   your agent. Use this for production deploy (`eve deploy`).
 */
export type LarkTransportMode = "long-connection" | "webhook";

/**
 * Branded string for a continuation token in the wire format `${chatId}:${rootMessageId ?? "_"}`.
 * Use {@link larkContinuationToken} to mint one.
 */
export type LarkContinuationToken = string & {
  readonly __larkContinuationTokenBrand: unique symbol;
};

export interface LarkChannelOptions {
  appId?: string | undefined;
  appSecret?: string | undefined;
  verificationToken?: string | undefined;
  encryptKey?: string | undefined;
  baseUrl?: string | undefined;
  botOpenId?: string | undefined;
  webhookPath?: string | undefined;
  replyMode?: LarkReplyMode | undefined;
  streamPatchIntervalMs?: number | undefined;
  streamCreateThresholdMs?: number | undefined;
  dedupTtlMs?: number | undefined;
  dedupMaxEntries?: number | undefined;
  requestTimeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  tokenRefreshBufferMs?: number | undefined;
  signatureSkewMs?: number | undefined;
  /**
   * Drop Feishu events older than this many milliseconds based on
   * `header.create_time`. Set to 0 to disable. Default: 10 minutes.
   */
  eventMaxAgeMs?: number | undefined;
  /**
   * TTL for pending ask_question cards. Expired cards are patched and no
   * longer resume the parked session. Default: 5 minutes.
   */
  askInputTtlMs?: number | undefined;
  fetch?: typeof fetch | undefined;
  /**
   * Emoji type to react to the inbound user message with as soon as it arrives
   * (acknowledgement feedback). Set to a Feishu emoji type string like
   * "TYPING", an array of candidates (one is picked at random per message),
   * or `false` to disable. Default: "TYPING".
   */
  ackReaction?: string | readonly string[] | false | undefined;
  /**
   * Transport mode. Default: `"long-connection"` (WSClient side effect, no
   * public URL needed). Set to `"webhook"` for production with a public URL.
   */
  mode?: LarkTransportMode | undefined;
  /**
   * Port the host eve server listens on. Used only in `"long-connection"`
   * mode to compute the localhost webhook URL we POST forwarded events to.
   * Defaults to `$PORT` or `2000` (matches `eve dev`).
   */
  port?: number | undefined;
  /**
   * Allowlist of sender open_ids for DM (p2p) messages. When set, DMs from
   * senders not in this list are dropped before reaching the agent. Has no
   * effect on group messages (use `groupAllowFrom` for those). Default:
   * unset → all DMs allowed.
   */
  allowFrom?: readonly string[] | undefined;
  /**
   * Allowlist of chat_ids for group messages. When set, messages from
   * chats not in this list are dropped. Default: unset → all groups allowed.
   */
  groupAllowFrom?: readonly string[] | undefined;
  /**
   * Per-group configuration. Matched by chat_id on inbound group messages.
   * Currently only `systemPrompt` is read; it's injected as `context` in
   * the `send()` call so the agent treats it as an additional user-role
   * instruction at the start of the turn. DMs ignore this.
   */
  groupConfigs?: readonly LarkGroupConfig[] | undefined;
  /**
   * ASR provider for audio/media transcription. When set, audio/media
   * messages are downloaded, transcribed, and the transcript is forwarded
   * to the agent as text. When unset (default), audio/media messages are
   * ack-and-skipped.
   */
  asrProvider?: LarkAsrProvider | undefined;
  /**
   * Optional handler for custom Feishu card actions that are not produced by
   * eve-lark's built-in ask_question UI. When omitted, unknown card actions
   * are acknowledged and ignored.
   */
  cardActionHandler?: LarkCardActionHandler | undefined;
}

export interface LarkGroupConfig {
  chatId: string;
  /**
   * Allowlist of sender open_ids for this group. When set, group messages
   * from other users in the same chat are dropped before reaching the agent.
   */
  allowFrom?: readonly string[] | undefined;
  /**
   * Require a direct bot mention before group messages in this chat wake the
   * agent. Default is false for backwards compatibility.
   */
  requireMention?: boolean | undefined;
  /**
   * When `requireMention` is true, treat @all as a valid trigger. Default is
   * false to avoid waking the agent on broad announcements.
   */
  respondToMentionAll?: boolean | undefined;
  systemPrompt?: string | undefined;
}

/**
 * Pluggable ASR (Automatic Speech Recognition) provider. When configured,
 * inbound audio/media messages are downloaded, transcribed, and the transcript
 * replaces the empty text — the agent receives it as a normal text message.
 */
export interface LarkAsrProvider {
  transcribe(audioBytes: Buffer, mediaType: string): Promise<string>;
}

export interface ResolvedLarkOptions {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string | undefined;
  baseUrl: string;
  botOpenId: string | undefined;
  webhookPath: string;
  replyMode: LarkReplyMode;
  streamPatchIntervalMs: number;
  streamCreateThresholdMs: number;
  dedupTtlMs: number;
  dedupMaxEntries: number;
  requestTimeoutMs: number;
  maxRetries: number;
  tokenRefreshBufferMs: number;
  signatureSkewMs: number;
  eventMaxAgeMs: number;
  askInputTtlMs: number;
  fetch: typeof fetch;
  ackReaction: string | readonly string[] | false;
  mode: LarkTransportMode;
  port: number;
  allowFrom: readonly string[] | undefined;
  groupAllowFrom: readonly string[] | undefined;
  groupConfigs: readonly LarkGroupConfig[] | undefined;
  asrProvider: LarkAsrProvider | undefined;
  cardActionHandler?: LarkCardActionHandler | undefined;
}

export type LarkSenderType = "user" | "app";
export type LarkChatType = "p2p" | "group";

export interface LarkMention {
  key: string;
  id: LarkMentionId;
  name: string;
  idType: LarkMentionIdType;
  isOpenIdOfBot: boolean;
  isAll: boolean;
}

export interface LarkMentionId {
  openId?: string | undefined;
  userId?: string | undefined;
  unionId?: string | undefined;
}

export type LarkMentionIdType = "open_id" | "user_id" | "union_id";

export interface LarkInboundFile {
  fileKey: string;
  mediaType: string;
  kind: "image" | "file" | "audio" | "video" | "sticker";
  fileName?: string | undefined;
  duration?: number | undefined;
}

export interface LarkInboundResult {
  text: string;
  files: LarkInboundFile[];
  chatId: string;
  rootId: string | null;
  parentId: string | null;
  messageId: string;
  senderOpenId: string;
  senderType: LarkSenderType;
  chatType: LarkChatType;
  mentions: LarkMention[];
}

/** Subset of the official v2 `im.message.receive_v1` event payload we depend on. */
export interface LarkInboundEvent {
  message: {
    message_id: string;
    root_id?: string | undefined;
    parent_id?: string | undefined;
    chat_id: string;
    chat_type?: string | undefined;
    message_type: string;
    content: string;
    create_time?: string | undefined;
    mentions?: LarkRawMention[] | undefined;
  };
  sender: {
    sender_id: {
      open_id?: string | undefined;
      user_id?: string | undefined;
      union_id?: string | undefined;
    };
    sender_type?: string | undefined;
  };
  chat_type?: string | undefined;
}

/** card.action.trigger event payload (no outer envelope). */
export interface LarkCardActionTriggerEvent {
  open_id: string;
  user_id?: string;
  tenant_key: string;
  open_message_id: string;
  open_chat_id?: string;
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
    option?: string;
    form_value?: Record<string, unknown>;
    timezone?: string;
  };
}

export type LarkCardActionHandlerResponse = Record<string, unknown> | void | undefined;

export interface LarkCardActionRespond {
  reply(args: { text: string }): Promise<{ messageId: string } | void>;
  followUp(args: { text: string }): Promise<{ messageId: string } | void>;
  editMessage(args: { text?: string | undefined; card?: Record<string, unknown> | undefined }): Promise<void>;
}

export interface LarkCustomCardActionContext {
  action: string;
  actionValue: Record<string, unknown>;
  chatId?: string | undefined;
  messageId: string;
  senderOpenId: string;
  senderUserId?: string | undefined;
  tenantKey: string;
  rawEvent: LarkCardActionTriggerEvent;
  client: LarkClient;
  respond: LarkCardActionRespond;
}

export type LarkCardActionHandler = (
  ctx: LarkCustomCardActionContext,
) => LarkCardActionHandlerResponse | Promise<LarkCardActionHandlerResponse>;

export interface LarkRawMention {
  key: string;
  id: { open_id?: string | undefined; user_id?: string | undefined; union_id?: string | undefined };
  name: string;
  id_type?: LarkMentionIdType | undefined;
}

/** Body shape of the encrypted envelope. */
export interface LarkEncryptedBody {
  encrypt?: string | undefined;
}

export interface LarkUrlVerificationBody {
  token?: string | undefined;
  challenge?: string | undefined;
  type?: "url_verification" | undefined;
}

export interface LarkEventHeader {
  event_id?: string | undefined;
  event_type?: string | undefined;
  create_time?: string | undefined;
  token?: string | undefined;
  app_id?: string | undefined;
  tenant_key?: string | undefined;
}

export interface LarkEventBody {
  schema?: string | undefined;
  header?: LarkEventHeader | undefined;
  /** v2 message event payload, OR card.action.trigger payload. */
  event?: LarkInboundEvent | LarkCardActionTriggerEvent | undefined;
  type?: string | undefined;
  challenge?: string | undefined;
  token?: string | undefined;
}

export interface LarkContext {
  client: unknown;
  options: ResolvedLarkOptions;
  anchorThread(rootMessageId: string): void;
}

export interface LarkAdapterState {
  client: unknown;
  dedup: unknown;
  options: ResolvedLarkOptions;
}

/**
 * Minimal interactive card payload (template_blue).
 */
export interface LarkCard {
  config: {
    wide_screen_mode?: boolean | undefined;
    update_multi?: boolean | undefined;
  };
  elements: LarkCardElement[];
}

export type LarkCardElement =
  | { tag: "div"; text: { tag: "lark_md"; content: string } }
  | { tag: "div"; text: { tag: "plain_text"; content: string } }
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | { tag: "note"; elements: Array<{ tag: "plain_text"; content: string }> }
  | {
      tag: "action";
      actions: LarkCardActionItem[];
      layout?: "bisected" | "trisection" | "flow";
    }
  | {
      tag: "input";
      name: string;
      placeholder?: { tag: "plain_text"; content: string };
    };

/** Union of action-row item shapes: buttons (yes/no confirm style) and
 *  select menus (dropdowns for longer option lists). */
export type LarkCardActionItem = LarkCardButton | LarkCardSelectMenu;

export interface LarkCardSelectMenu {
  tag: "select_static";
  name?: string;
  placeholder?: { tag: "plain_text"; content: string };
  /** Initially-selected option id (string). */
  initial_option?: string;
  /** Selectable options. `value` carries the optionId we get back in
   *  `action.option` when the user picks one. */
  options: Array<{
    text: { tag: "plain_text"; content: string };
    value: string;
  }>;
  /** Same marker payload as a button so the dispatcher can recognise our
   *  own callbacks. `optionId` is NOT set here — it comes back via
   *  `action.option` instead. */
  value?: Record<string, unknown>;
}

export interface LarkCardButton {
  tag: "button";
  text: { tag: "plain_text"; content: string };
  type?: "default" | "primary" | "danger";
  /** Opens this URL when clicked (instead of triggering card.action.trigger). */
  url?: string;
  /** Arbitrary JSON returned in the card.action.trigger callback's
   *  `action.value`. eve-lark sets `{ __eveLarkAsk, requestId, optionId }`. */
  value?: Record<string, unknown>;
  confirm?: { title: { tag: "plain_text"; content: string }; text: { tag: "plain_text"; content: string } };
}

/**
 * One selectable option in an eve input request (ask_question tool).
 * Mirrors eve's InputOption.
 */
export interface LarkInputOption {
  id: string;
  label: string;
  description?: string;
  style?: "primary" | "default" | "danger";
}

/**
 * eve's InputRequest — surfaced when the model calls `ask_question` (or a
 * similar HITL tool). The channel renders it as a Feishu card with buttons.
 */
export interface LarkInputRequest {
  requestId: string;
  prompt: string;
  options?: LarkInputOption[];
  allowFreeform?: boolean;
  display?: "confirmation" | "select" | "text";
  action: {
    kind: "tool-call";
    toolName: string;
    callId: string;
    input: Record<string, unknown>;
  };
}

/**
 * eve's InputResponse — what we send back when the user answers (button
 * click or freeform text).
 */
export interface LarkInputResponse {
  requestId: string;
  optionId?: string;
  text?: string;
}

/**
 * Feishu's `card.action.trigger` event payload. The button's `value` JSON
 * comes through as `action.value`.
 */
export interface LarkCardActionEvent {
  open_id: string;
  user_id?: string;
  tenant_key: string;
  open_message_id: string;
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
    option?: string;
    timezone?: string;
  };
}
