import { LarkClient } from "./lark-client.js";
import { resolveOptions } from "./options.js";
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

  for (const match of out.matchAll(/@([A-Za-z0-9\u4e00-\u9fa5_]+(?:[.-][A-Za-z0-9\u4e00-\u9fa5_]+)*)/g)) {
    const start = match.index ?? 0;
    if (inMask(start)) continue;
    const end = start + match[0].length;
    const name = match[1] ?? "";
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

  return { text: applyReplacements(out, replacements), sentinels };
}

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
    }
  | {
      url: string;
      fileName?: string;
    };

export interface LarkOutboundPayload {
  chatId: string;
  text?: string;
  channelData?: { feishu?: { card?: Record<string, unknown> } };
  media?: LarkOutboundMedia[];
  mentions?: Record<string, MentionTarget>;
  rootId?: string;
  parentId?: string;
}

export function createLarkSender(options: LarkChannelOptions): {
  sendMedia(args: { chatId: string; media: LarkOutboundMedia; rootId?: string; parentId?: string }): Promise<{ messageId: string }>;
  sendPayload(payload: LarkOutboundPayload): Promise<{ messageId: string }>;
} {
  const client = new LarkClient(resolveOptions(options));
  return {
    sendMedia: (args) => client.uploadAndSendMedia(args),
    sendPayload: async (payload) => {
      let last: { messageId: string } | undefined;
      const text = payload.text?.trim();
      if (text) {
        let members: Awaited<ReturnType<LarkClient["listChatMembers"]>>["members"] | null = null;
        const normalized = await normalizeOutboundMentions(text, {
          chatId: payload.chatId,
          resolveName: async (name) => {
            if (payload.mentions?.[name]) return payload.mentions[name];
            members ??= (await client.listChatMembers({ chatId: payload.chatId })).members;
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
        for (const chunk of chunkMarkdownText(normalized.text, 15_000)) {
          last = await client.sendPost({
            chatId: payload.chatId,
            content: chunk,
            rootId: payload.rootId,
            parentId: payload.parentId,
          });
        }
      }

      const card = payload.channelData?.feishu?.card;
      if (card) {
        last = await client.sendCard({
          chatId: payload.chatId,
          card,
          rootId: payload.rootId,
          parentId: payload.parentId,
        });
      }

      for (const media of payload.media ?? []) {
        last = await client.uploadAndSendMedia({
          chatId: payload.chatId,
          media,
          rootId: payload.rootId,
          parentId: payload.parentId,
        });
      }

      return last ?? { messageId: "" };
    },
  };
}
