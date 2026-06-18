/**
 * Public types for eve-lark.
 */

/**
 * Discriminated union of normalized inbound message parts (text vs file).
 * Useful for consumers that want to inspect what eve-lark handed to `send()`.
 */
export type LarkInboundMessage = LarkInboundResult;

export type LarkReplyMode = "streaming" | "static";

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
  fetch?: typeof fetch | undefined;
  /**
   * Emoji type to react to the inbound user message with as soon as it arrives
   * (acknowledgement feedback). Set to a Feishu emoji type string like
   * "TYPING", an array of candidates (one is picked at random per message),
   * or `false` to disable. Default: "TYPING".
   */
  ackReaction?: string | readonly string[] | false | undefined;
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
  fetch: typeof fetch;
  ackReaction: string | readonly string[] | false;
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
  kind: "image" | "file";
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
  event?: LarkInboundEvent | undefined;
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
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | { tag: "note"; elements: Array<{ tag: "plain_text"; content: string }> };
