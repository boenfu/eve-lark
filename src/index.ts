/**
 * eve-lark — Lark/Feishu channel for the eve agent framework.
 *
 * Drop the factory's return value into `agent/channels/lark.ts` as the default
 * export and eve will mount a Lark/Feishu webhook that streams turns into
 * interactive cards.
 *
 * @example
 * ```ts
 * // agent/channels/lark.ts
 * import { createLarkChannel } from "eve-lark";
 *
 * export default createLarkChannel({
 *   appId:             process.env.LARK_APP_ID!,
 *   appSecret:         process.env.LARK_APP_SECRET!,
 *   verificationToken: process.env.LARK_VERIFICATION_TOKEN!,
 *   encryptKey:        process.env.LARK_ENCRYPT_KEY,
 *   botOpenId:         process.env.LARK_BOT_OPEN_ID,
 * });
 * ```
 */

export { createLarkChannel, larkContinuationToken } from "./channel.js";
export { LarkClient } from "./lark-client.js";
export {
  chunkMarkdownText,
  createLarkSender,
  normalizeOutboundMentions,
  type LarkOutboundMedia,
  type LarkOutboundPayload,
  type MentionTarget,
  type OutboundMentionContext,
  type OutboundMentionResult,
  type OutboundMentionSentinel,
} from "./outbound.js";
export {
  LarkChannelError,
  LarkConfigError,
  LarkSignatureError,
  LarkDecryptError,
  LarkApiError,
  type LarkApiErrorBody,
} from "./errors.js";

export type {
  LarkChannelOptions,
  ResolvedLarkOptions,
  LarkAdapterState,
  LarkContext,
  LarkContinuationToken,
  LarkReplyMode,
  LarkTransportMode,
  LarkInboundEvent,
  LarkInboundResult,
  LarkInboundFile,
  LarkInboundMessage,
  LarkMention,
  LarkCard,
  LarkCardActionHandler,
  LarkCardActionHandlerResponse,
  LarkCardActionRespond,
  LarkCardElement,
  LarkCustomCardActionContext,
} from "./types.js";
