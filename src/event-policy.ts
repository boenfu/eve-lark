import type { LarkChatType, LarkEventHeader } from "./types.js";

export function isEventOwnedByApp(
  header: Pick<LarkEventHeader, "app_id"> | undefined,
  appId: string,
): boolean {
  const eventAppId = header?.app_id;
  return !eventAppId || eventAppId === appId;
}

export function isEventExpired(
  header: Pick<LarkEventHeader, "create_time"> | undefined,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (ttlMs <= 0) return false;
  const createdAt = parseFeishuTimestampMs(header?.create_time);
  if (createdAt === null) return false;
  return nowMs - createdAt > ttlMs;
}

function parseFeishuTimestampMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1_000_000_000_000 ? n : n * 1000;
}

const ABORT_TEXT = new Set([
  "/stop",
  "stop",
  "abort",
  "interrupt",
  "halt",
  "exit",
  "please stop",
  "stop please",
  "停止",
  "中断",
  "终止",
  "暂停",
  "不用继续",
  "别继续",
]);

export function isAbortText(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?。,，;；:：]+$/u, "")
    .replace(/\s+/g, " ");
  return ABORT_TEXT.has(normalized);
}

export class ChatTaskQueue {
  private readonly chains = new Map<string, Promise<void>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key);
    const result = previous ? previous.catch(() => undefined).then(task) : task();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    return result;
  }

  has(key: string): boolean {
    return this.chains.has(key);
  }
}

export class BotLoopGuard {
  private readonly maxBotTurns: number;
  private readonly counts = new Map<string, number>();

  constructor(opts: { maxBotTurns: number }) {
    this.maxBotTurns = opts.maxBotTurns;
  }

  record(key: string, senderType: "user" | "app"): boolean {
    if (senderType === "user") {
      this.counts.delete(key);
      return false;
    }
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next > this.maxBotTurns;
  }
}

export interface ParsedReactionCreated {
  sourceMessageId: string;
  chatId: string | null;
  chatType: LarkChatType | null;
  messageId: string;
  senderOpenId: string;
  text: string;
  rootId: string | null;
  parentId: string | null;
}

export function parseReactionCreatedEvent(event: unknown): ParsedReactionCreated | null {
  if (!isRecord(event)) return null;
  const messageId = readString(event.message_id);
  const chatId =
    readString(event.chat_id) ??
    readString(readRecord(event.message)?.chat_id);
  const emojiType = readString(readRecord(event.reaction_type)?.emoji_type);
  const user = readRecord(event.user_id) ?? readRecord(event.operator_id);
  const senderOpenId =
    readString(user?.open_id) ??
    readString(user?.user_id) ??
    readString(user?.union_id);
  const operatorType = readString(event.operator_type);

  if (!messageId || !emojiType || !senderOpenId) return null;
  if (emojiType === "Typing") return null;
  if (operatorType === "app") return null;

  const chatTypeRaw =
    readString(event.chat_type) ??
    readString(readRecord(event.message)?.chat_type);
  const chatType: LarkChatType | null =
    chatTypeRaw === "group" ? "group" : chatTypeRaw === "p2p" ? "p2p" : null;
  const rootId =
    readString(event.root_id) ??
    readString(readRecord(event.message)?.root_id) ??
    null;
  const parentId =
    readString(event.parent_id) ??
    readString(readRecord(event.message)?.parent_id) ??
    null;

  return {
    sourceMessageId: messageId,
    chatId: chatId ?? null,
    chatType,
    messageId: `${messageId}:reaction:${emojiType}:${senderOpenId}`,
    senderOpenId,
    text: `[reacted with ${emojiType} to message ${messageId}]`,
    rootId,
    parentId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
