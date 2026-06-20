export type LarkReceiveIdType = "chat_id" | "open_id" | "user_id";

export interface LarkOutboundTargetObject {
  id: string;
  idType?: LarkReceiveIdType | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadId?: string | undefined;
}

export type LarkOutboundTarget = string | LarkOutboundTargetObject;

export interface ResolvedLarkOutboundTarget {
  receiveId: string;
  receiveIdType: LarkReceiveIdType;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadId?: string | undefined;
}

const TAG_CHAT = "chat:";
const TAG_USER = "user:";
const TAG_USER_ID = "user_id:";
const TAG_OPEN_ID = "open_id:";
const TAG_FEISHU = "feishu:";

const ROUTE_META_FRAGMENT_REPLY_TO = "__feishu_reply_to";
const ROUTE_META_FRAGMENT_THREAD_ID = "__feishu_thread_id";

export function encodeLarkRouteTarget(params: {
  target: string;
  replyToMessageId?: string | undefined;
  threadId?: string | number | null | undefined;
}): string {
  const target = params.target.trim();
  if (!target) return target;
  const replyToMessageId = normalizeLarkMessageId(params.replyToMessageId);
  const threadId =
    params.threadId !== null && params.threadId !== undefined && String(params.threadId).trim()
      ? String(params.threadId).trim()
      : undefined;
  if (!replyToMessageId && !threadId) return target;
  const fragment = new URLSearchParams();
  if (replyToMessageId) fragment.set(ROUTE_META_FRAGMENT_REPLY_TO, replyToMessageId);
  if (threadId) fragment.set(ROUTE_META_FRAGMENT_THREAD_ID, threadId);
  return `${target}#${fragment.toString()}`;
}

export function resolveLarkOutboundTarget(params: {
  to?: LarkOutboundTarget | undefined;
  chatId?: string | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadId?: string | undefined;
}): ResolvedLarkOutboundTarget {
  const parsed = parseTarget(params.to ?? params.chatId ?? "");
  const receiveId = parsed.id || params.chatId || "";
  if (!receiveId) {
    throw new Error("eve-lark: outbound target requires `to` or `chatId`");
  }
  return {
    receiveId,
    receiveIdType: parsed.idType ?? inferReceiveIdType(receiveId),
    rootId: normalizeLarkMessageId(params.rootId) ?? parsed.rootId,
    parentId: normalizeLarkMessageId(params.parentId) ?? parsed.parentId,
    threadId: params.threadId ?? parsed.threadId,
  };
}

export function normalizeLarkMessageId(messageId: string | undefined): string | undefined {
  if (!messageId) return undefined;
  const trimmed = messageId.trim();
  if (!trimmed) return undefined;
  const colonIndex = trimmed.indexOf(":");
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

export function isLarkChatTarget(target: ResolvedLarkOutboundTarget): boolean {
  return target.receiveIdType === "chat_id";
}

function parseTarget(target: LarkOutboundTarget | string): {
  id: string;
  idType?: LarkReceiveIdType | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadId?: string | undefined;
} {
  if (typeof target === "object" && target !== null) {
    const parsed = parseTargetString(target.id);
    return {
      ...parsed,
      idType: target.idType ?? parsed.idType,
      rootId: normalizeLarkMessageId(target.rootId) ?? parsed.rootId,
      parentId: normalizeLarkMessageId(target.parentId) ?? parsed.parentId,
      threadId: target.threadId ?? parsed.threadId,
    };
  }
  return parseTargetString(target);
}

function parseTargetString(raw: string): {
  id: string;
  idType?: LarkReceiveIdType | undefined;
  rootId?: string | undefined;
  parentId?: string | undefined;
  threadId?: string | undefined;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { id: "" };
  const hashIndex = trimmed.indexOf("#");
  const target = hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed;
  const fragment = hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() : "";
  const meta = parseRouteFragment(fragment);
  const tagged = stripTargetTag(target);
  return {
    id: tagged.id,
    idType: tagged.idType,
    ...meta,
  };
}

function parseRouteFragment(fragment: string): {
  rootId?: string | undefined;
  threadId?: string | undefined;
} {
  if (!fragment) return {};
  const params = new URLSearchParams(fragment);
  const rootId = normalizeLarkMessageId(params.get(ROUTE_META_FRAGMENT_REPLY_TO) ?? undefined);
  const threadId = params.get(ROUTE_META_FRAGMENT_THREAD_ID)?.trim() || undefined;
  return {
    ...(rootId ? { rootId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function stripTargetTag(raw: string): { id: string; idType?: LarkReceiveIdType | undefined } {
  if (raw.startsWith(TAG_FEISHU)) return stripTargetTag(raw.slice(TAG_FEISHU.length).trim());
  if (raw.startsWith(TAG_CHAT)) return { id: raw.slice(TAG_CHAT.length), idType: "chat_id" };
  if (raw.startsWith(TAG_OPEN_ID)) return { id: raw.slice(TAG_OPEN_ID.length), idType: "open_id" };
  if (raw.startsWith(TAG_USER_ID)) return { id: raw.slice(TAG_USER_ID.length), idType: "user_id" };
  if (raw.startsWith(TAG_USER)) return { id: raw.slice(TAG_USER.length), idType: "user_id" };
  return { id: raw };
}

function inferReceiveIdType(id: string): LarkReceiveIdType {
  if (id.startsWith("oc_")) return "chat_id";
  if (id.startsWith("ou_")) return "open_id";
  return "open_id";
}
