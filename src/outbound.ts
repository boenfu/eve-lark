import { LarkClient } from "./lark-client.js";
import { resolveOptions } from "./options.js";
import {
  isLarkChatTarget,
  resolveLarkOutboundTarget,
  type LarkOutboundTarget,
  type ResolvedLarkOutboundTarget,
} from "./target.js";
import type { LarkChannelOptions } from "./types.js";

export interface MentionTarget {
  openId: string;
  name: string;
}

export interface MentionAmbiguous {
  ambiguous: MentionTarget[];
}

export interface OutboundMentionContext {
  chatId: string;
  resolveName(name: string): Promise<MentionTarget | MentionAmbiguous | null>;
}

export interface OutboundMentionSentinel {
  name: string;
  reason: "not_found" | "ambiguous";
  candidates?: MentionTarget[];
}

export interface OutboundMentionResult {
  text: string;
  sentinels: OutboundMentionSentinel[];
}

export async function normalizeOutboundMentions(
  text: string,
  ctx: OutboundMentionContext,
): Promise<OutboundMentionResult> {
  let out = normalizeMentionTags(text);
  out = out.replace(/@(<at\s+user_id="ou_[A-Za-z0-9_-]+">[^<]*<\/at>)/g, "$1");

  const inMask = buildMaskPredicate(out);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const sentinels: OutboundMentionSentinel[] = [];

  for (const variant of MENTION_VARIANT_PATTERNS) {
    for (const match of out.matchAll(variant.re)) {
      const matchStart = match.index ?? 0;
      const leading = variant.leadingGroup ? (match[variant.leadingGroup] ?? "") : "";
      const start = matchStart + leading.length;
      const end = matchStart + match[0].length;
      if (inMask(start) || overlapsReplacement(replacements, start, end)) continue;
      const name = (match[variant.nameGroup] ?? "").trim();
      if (!name) continue;

      if (isAllMentionAlias(name)) {
        replacements.push({ start, end, text: '<at user_id="all">Everyone</at>' });
        continue;
      }

      const resolved = await ctx.resolveName(name);
      if (!resolved) {
        sentinels.push({ name, reason: "not_found" });
        continue;
      }
      if ("ambiguous" in resolved) {
        sentinels.push({ name, reason: "ambiguous", candidates: resolved.ambiguous });
        continue;
      }
      replacements.push({
        start,
        end,
        text: `<at user_id="${resolved.openId}">${resolved.name}</at>`,
      });
    }
  }

  return { text: applyReplacements(out, replacements), sentinels };
}

const MENTION_VARIANT_PATTERNS: Array<{
  re: RegExp;
  nameGroup: number;
  leadingGroup?: number | undefined;
}> = [
  { re: /@\[([^\]\n]+)\]/g, nameGroup: 1 },
  { re: /@<([^>\n]+)>/g, nameGroup: 1 },
  { re: /<@([^>\n]+)>/g, nameGroup: 1 },
  { re: /<at>\s*([^<\n]+?)\s*<\/at>/g, nameGroup: 1 },
  { re: /\{\{\s*([^}\n]+?)\s*\}\}/g, nameGroup: 1 },
  { re: /(^|[^\w@])@([A-Za-z0-9\u4e00-\u9fa5_][\w.\u4e00-\u9fa5-]{0,30})/g, nameGroup: 2, leadingGroup: 1 },
];

function normalizeMentionTags(text: string): string {
  return text
    .replace(
      /<at\s+(?:id|user_id|open_id)\s*=\s*["']?all["']?\s*>\s*<\/at>/gi,
      '<at user_id="all">Everyone</at>',
    )
    .replace(
      /<at\s+(?:id|open_id|user_id)\s*=\s*["']?(ou_[A-Za-z0-9_-]+)["']?\s*>/gi,
      '<at user_id="$1">',
    );
}

function buildMaskPredicate(text: string): (idx: number) => boolean {
  const masks: Array<[number, number]> = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /`[^`\n]*`/g,
    /<at\s+user_id="[^"]+">[^<]*<\/at>/g,
    /<person\s+[^>]*>[^<]*<\/person>/g,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /\b(?:https?|ftp|mailto):\/\/[^\s)\]<>]+/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      masks.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }
  return (idx) => masks.some(([start, end]) => idx >= start && idx < end);
}

function isAllMentionAlias(name: string): boolean {
  return new Set(["all", "everyone", "所有人"]).has(name.toLowerCase());
}

function overlapsReplacement(
  replacements: ReadonlyArray<{ start: number; end: number }>,
  start: number,
  end: number,
): boolean {
  return replacements.some((replacement) => start < replacement.end && end > replacement.start);
}

function applyReplacements(
  text: string,
  replacements: Array<{ start: number; end: number; text: string }>,
): string {
  if (replacements.length === 0) return text;
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of sorted) {
    if (replacement.start < cursor) continue;
    chunks.push(text.slice(cursor, replacement.start), replacement.text);
    cursor = replacement.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

export function chunkMarkdownText(text: string, limit: number): string[] {
  if (limit <= 0 || text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const part of text.split("\n\n")) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (part.length <= limit) {
      current = part;
      continue;
    }
    const hardChunks = splitLongPart(part, limit);
    chunks.push(...hardChunks.slice(0, -1));
    current = hardChunks.at(-1) ?? "";
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function splitLongPart(part: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const token of part.split(/(\s+)/)) {
    if (!token) continue;
    if ((current + token).length <= limit) {
      current += token;
      continue;
    }
    if (current.trim()) chunks.push(current.trimEnd());
    if (token.length > limit) {
      for (let i = 0; i < token.length; i += limit) {
        chunks.push(token.slice(i, i + limit));
      }
      current = "";
    } else {
      current = token.trimStart();
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.length > 0 ? chunks : [part];
}

export type LarkOutboundMedia =
  | {
      data: Buffer | Uint8Array | Blob | string;
      fileName: string;
      duration?: number | undefined;
    }
  | {
      url: string;
      fileName?: string;
      duration?: number | undefined;
    };

export interface LarkOutboundPayload {
  chatId?: string;
  to?: LarkOutboundTarget;
  text?: string;
  channelData?: { feishu?: { card?: Record<string, unknown> } };
  media?: LarkOutboundMedia[];
  mentions?: Record<string, MentionTarget>;
  ensureMentions?: MentionTarget[];
  rootId?: string;
  parentId?: string;
  mediaLocalRoots?: readonly string[];
}

export function createLarkSender(options: LarkChannelOptions): {
  sendMedia(args: { chatId?: string; to?: LarkOutboundTarget; media: LarkOutboundMedia; rootId?: string; parentId?: string; mediaLocalRoots?: readonly string[] }): Promise<{ messageId: string }>;
  sendPayload(payload: LarkOutboundPayload): Promise<{ messageId: string }>;
} {
  const client = new LarkClient(resolveOptions(options));
  const memberCache = new Map<string, Promise<Awaited<ReturnType<LarkClient["listChatMembers"]>>["members"]>>();

  async function loadChatMembers(chatId: string): Promise<Awaited<ReturnType<LarkClient["listChatMembers"]>>["members"]> {
    let cached = memberCache.get(chatId);
    if (!cached) {
      cached = (async () => {
        const members: Awaited<ReturnType<LarkClient["listChatMembers"]>>["members"] = [];
        let pageToken: string | undefined;
        do {
          const page = await client.listChatMembers({ chatId, pageToken });
          members.push(...page.members);
          pageToken = page.hasMore ? page.pageToken : undefined;
        } while (pageToken);
        return members;
      })();
      memberCache.set(chatId, cached);
    }
    return cached;
  }

  return {
    sendMedia: (args) => client.uploadAndSendMedia(args),
    sendPayload: async (payload) => {
      let last: { messageId: string } | undefined;
      const target = resolveLarkOutboundTarget({
        to: payload.to,
        chatId: payload.chatId,
        rootId: payload.rootId,
        parentId: payload.parentId,
      });
      const clientTarget = toClientTarget(target);
      const text = payload.text?.trim();
      if (text) {
        const normalized = await normalizeOutboundMentions(text, {
          chatId: target.receiveId,
          resolveName: async (name) => {
            if (payload.mentions?.[name]) return payload.mentions[name];
            if (!isLarkChatTarget(target)) return null;
            const members = await loadChatMembers(target.receiveId);
            const matches = members.filter((member) => member.name === name);
            if (matches.length === 1) {
              return { openId: matches[0]!.memberId, name: matches[0]!.name };
            }
            if (matches.length > 1) {
              return {
                ambiguous: matches.map((member) => ({
                  openId: member.memberId,
                  name: member.name,
                })),
              };
            }
            return null;
          },
        });
        const withRequiredMentions = ensureOutboundMentions(
          normalized.text,
          payload.ensureMentions ?? [],
        );
        for (const chunk of chunkMarkdownText(withRequiredMentions, 15_000)) {
          last = await client.sendPost({
            target: clientTarget,
            content: chunk,
          });
        }
      }

      const card = payload.channelData?.feishu?.card;
      if (card) {
        last = await client.sendCard({
          target: clientTarget,
          card,
        });
      }

      for (const media of payload.media ?? []) {
        last = await client.uploadAndSendMedia({
          target: clientTarget,
          media,
          mediaLocalRoots: payload.mediaLocalRoots,
        });
      }

      return last ?? { messageId: "" };
    },
  };
}

export function ensureOutboundMention(text: string, mention: MentionTarget): string {
  if (text.includes(`user_id="${mention.openId}"`)) return text;
  const tag = `<at user_id="${mention.openId}">${mention.name}</at>`;
  return text.trim() ? `${tag} ${text}` : tag;
}

export function ensureOutboundMentions(text: string, mentions: readonly MentionTarget[]): string {
  return mentions.reduce((out, mention) => ensureOutboundMention(out, mention), text);
}

export type LarkMessageActionName = "send" | "react" | "reactions" | "delete" | "unsend" | "forward";

export interface LarkMessageActionContext {
  action: string;
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string | undefined;
    currentMessageId?: string | undefined;
    currentThreadTs?: string | undefined;
  } | undefined;
  mediaLocalRoots?: readonly string[] | undefined;
}

export interface LarkMessageActionAdapter {
  describeMessageTool(): {
    actions: LarkMessageActionName[];
    capabilities: string[];
    schema: Record<string, unknown>;
  };
  supportsAction(action: string): boolean;
  extractToolSend(args: Record<string, unknown>): Record<string, unknown> | null;
  handleAction(ctx: LarkMessageActionContext): Promise<Record<string, unknown>>;
}

const MESSAGE_ACTIONS: LarkMessageActionName[] = [
  "send",
  "react",
  "reactions",
  "delete",
  "unsend",
  "forward",
];

export function createLarkMessageActions(options: LarkChannelOptions): LarkMessageActionAdapter {
  const client = new LarkClient(resolveOptions(options));
  const sender = createLarkSender(options);

  return {
    describeMessageTool: () => ({
      actions: [...MESSAGE_ACTIONS],
      capabilities: ["cards", "media", "reactions"],
      schema: {
        visibility: "current-channel",
        properties: {
          message: { type: "string" },
          text: { type: "string" },
          to: { type: "string" },
          media: { type: "string" },
          fileName: { type: "string" },
          card: { type: "object" },
        },
      },
    }),
    supportsAction: (action) => MESSAGE_ACTIONS.includes(action as LarkMessageActionName),
    extractToolSend: (args) => {
      const sendMessage = args.sendMessage ?? args.message ?? args.text;
      return typeof sendMessage === "string" ? { action: "send", params: { message: sendMessage } } : null;
    },
    handleAction: async ({ action, params, toolContext, mediaLocalRoots }) => {
      switch (action) {
        case "send": {
          const sendParams = readSendActionParams(params, toolContext);
          const result = await sender.sendPayload({
            to: sendParams.to,
            chatId: sendParams.chatId,
            text: sendParams.text,
            channelData: sendParams.card ? { feishu: { card: sendParams.card } } : undefined,
            media: sendParams.mediaUrl
              ? [{ url: sendParams.mediaUrl, fileName: sendParams.fileName }]
              : undefined,
            rootId: sendParams.replyToMessageId,
            mediaLocalRoots,
          });
          return { ok: true, messageId: result.messageId };
        }
        case "react": {
          const messageId = readRequiredString(params, "messageId");
          const emojiType = readString(params, "emojiType") ?? readString(params, "emoji") ?? "";
          const remove = params.remove === true || params.delete === true;
          if (remove) {
            const listed = await client.listReactions({ messageId, emojiType: emojiType || undefined });
            const removable = listed.reactions.filter((reaction) => reaction.operatorType === undefined || reaction.operatorType === "app");
            for (const reaction of removable) {
              await client.removeReaction({ messageId, reactionId: reaction.reactionId });
            }
            return { ok: true, removed: removable.length };
          }
          if (!emojiType) throw new Error("eve-lark: react action requires emoji or emojiType");
          const result = await client.addReaction({ messageId, emojiType });
          return { ok: true, reactionId: result.reactionId };
        }
        case "reactions": {
          const messageId = readRequiredString(params, "messageId");
          const emojiType = readString(params, "emojiType") ?? readString(params, "emoji");
          const result = await client.listReactions({ messageId, emojiType });
          return { ok: true, reactions: result.reactions };
        }
        case "delete":
        case "unsend": {
          const messageId = readRequiredString(params, "messageId");
          await client.deleteMessage({ messageId });
          return { ok: true };
        }
        case "forward": {
          const messageId = readRequiredString(params, "messageId");
          const to = readRequiredString(params, "to");
          const result = await client.forwardMessage({ messageId, to });
          return { ok: true, messageId: result.messageId };
        }
        default:
          throw new Error(`eve-lark: unsupported message action ${action}`);
      }
    },
  };
}

function toClientTarget(target: ResolvedLarkOutboundTarget): LarkOutboundTarget {
  return {
    id: target.receiveId,
    idType: target.receiveIdType,
    rootId: target.rootId,
    parentId: target.parentId,
    threadId: target.threadId,
  };
}

function readSendActionParams(
  params: Record<string, unknown>,
  toolContext?: LarkMessageActionContext["toolContext"],
): {
  to?: LarkOutboundTarget | undefined;
  chatId?: string | undefined;
  text: string;
  mediaUrl?: string | undefined;
  fileName?: string | undefined;
  replyToMessageId?: string | undefined;
  card?: Record<string, unknown> | undefined;
} {
  const to = readString(params, "to");
  const text = readString(params, "message", true) ?? readString(params, "text", true) ?? "";
  const mediaUrl =
    readString(params, "media") ??
    readString(params, "path") ??
    readString(params, "filePath") ??
    readString(params, "url");
  const fileName = readString(params, "fileName") ?? readString(params, "name");
  const card = parseCardParam(params.card);
  const currentChatId = toolContext?.currentChannelId;
  const sameChat = !to || to === currentChatId;
  const replyToMessageId =
    readString(params, "replyTo") ??
    readString(params, "rootId") ??
    (sameChat ? toolContext?.currentMessageId : undefined);
  if (!text.trim() && !mediaUrl && !card) {
    throw new Error("eve-lark: send action requires message/text, media, or card");
  }
  return {
    to,
    chatId: to ? undefined : currentChatId,
    text,
    mediaUrl,
    fileName,
    replyToMessageId,
    card,
  };
}

function parseCardParam(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return Object.keys(raw as Record<string, unknown>).length > 0
      ? raw as Record<string, unknown>
      : undefined;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function readString(params: Record<string, unknown>, key: string, allowEmpty = false): string | undefined {
  const value = params[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || allowEmpty ? value : undefined;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = readString(params, key);
  if (!value) throw new Error(`eve-lark: missing required param ${key}`);
  return value;
}
