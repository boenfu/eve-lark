import { LarkApiError, type LarkApiErrorBody } from "./errors.js";
import { lookup } from "node:dns/promises";
import { readFile, realpath } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { LarkOutboundMedia } from "./outbound.js";
import { resolveLarkOutboundTarget, type LarkOutboundTarget, type LarkReceiveIdType } from "./target.js";
import type { LarkInboundEvent, ResolvedLarkOptions } from "./types.js";

interface TokenState {
  value: string;
  expiresAt: number;
}

const TOKEN_INVALID_CODES = new Set<number>([99991663, 99991664, 99991661]);
const CARDKIT_CARD_ID_NOT_READY_RETRY_DELAY_MS = 250;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);

type UploadFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

interface RequestResult {
  status: number;
  body: unknown;
  retryAfter: number | null;
}

interface ApiMessageItem {
  message_id?: string;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  chat_type?: string;
  msg_type?: string;
  message_type?: string;
  content?: string;
  body?: { content?: string };
  sender?: {
    id?: string;
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
}

export class LarkClient {
  private readonly options: ResolvedLarkOptions;
  private token: TokenState | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(options: ResolvedLarkOptions) {
    this.options = options;
  }

  async getTenantAccessToken(): Promise<string> {
    if (
      this.token &&
      Date.now() + this.options.tokenRefreshBufferMs < this.token.expiresAt
    ) {
      return this.token.value;
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.#refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async #refresh(): Promise<string> {
    const body = {
      app_id: this.options.appId,
      app_secret: this.options.appSecret,
    };
    const res = await this.options.fetch(
      `${this.options.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      },
    );
    if (!res.ok) {
      throw new LarkApiError(
        `eve-lark: token refresh failed (HTTP ${res.status})`,
        { status: res.status },
      );
    }
    const json = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number; msg?: string };
    if (json.code !== 0 || !json.tenant_access_token) {
      throw new LarkApiError(
        `eve-lark: token refresh returned code=${json.code ?? "?"} msg=${json.msg ?? "?"}`,
        { body: json, code: json.code },
      );
    }
    const expireSec = typeof json.expire === "number" ? json.expire : 7200;
    this.token = {
      value: json.tenant_access_token,
      expiresAt: Date.now() + expireSec * 1000,
    };
    return this.token.value;
  }

  async sendText(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    content: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    const content = JSON.stringify({ text: args.content });
    if (target.rootId) {
      console.log(`[eve-lark] sendText → reply rootId=${target.rootId}`);
      return this.#replyMessage(target.rootId, "text", content, Boolean(target.threadId));
    }
    console.log(`[eve-lark] sendText → send target=${target.receiveId} type=${target.receiveIdType}`);
    return this.#sendMessage({
      receive_id: target.receiveId,
      msg_type: "text",
      content,
    }, target.receiveIdType);
  }

  async sendCard(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    card: unknown;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    const content = JSON.stringify(args.card);
    if (target.rootId) {
      console.log(`[eve-lark] sendCard → reply rootId=${target.rootId}`);
      return this.#replyMessage(target.rootId, "interactive", content, Boolean(target.threadId));
    }
    console.log(`[eve-lark] sendCard → send target=${target.receiveId} type=${target.receiveIdType}`);
    return this.#sendMessage({
      receive_id: target.receiveId,
      msg_type: "interactive",
      content,
    }, target.receiveIdType);
  }

  async sendPost(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    content: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    // `msg_type: "post"` renders at native chat-message size with full
    // markdown support (bold, links, code, <font> color tags) via the
    // inner `{tag: "md"}` element. Cards render noticeably smaller because
    // Feishu treats them as "structured content"; post does not.
    //
    // The content schema is post > zh_cn > content > lines > inline nodes.
    // We put the whole reply in one md node — the md tag honors embedded
    // newlines, so multi-paragraph replies work as a single text string.
    const post = {
      zh_cn: {
        content: [[{ tag: "md", text: args.content }]],
      },
    };
    const content = JSON.stringify(post);
    if (target.rootId) {
      return this.#replyMessage(target.rootId, "post", content, Boolean(target.threadId));
    }
    return this.#sendMessage({
      receive_id: target.receiveId,
      msg_type: "post",
      content,
    }, target.receiveIdType);
  }

  async uploadImage(args: {
    image: Buffer | Uint8Array | Blob | string;
    imageType?: "message" | "avatar";
    fileName?: string;
  }): Promise<{ imageKey: string }> {
    const form = new FormData();
    form.set("image_type", args.imageType ?? "message");
    form.set("image", await binaryInputToBlob(args.image), args.fileName ?? "image");
    const json = await this.#requestForm("POST", "/open-apis/im/v1/images", form);
    const imageKey = (json as { data?: { image_key?: string }; image_key?: string }).data?.image_key ??
      (json as { image_key?: string }).image_key;
    if (!imageKey) {
      throw new LarkApiError("eve-lark: uploadImage missing image_key", {
        body: json as LarkApiErrorBody,
      });
    }
    return { imageKey };
  }

  async uploadFile(args: {
    file: Buffer | Uint8Array | Blob | string;
    fileName: string;
    fileType?: UploadFileType;
    duration?: number;
  }): Promise<{ fileKey: string }> {
    const fileType = args.fileType ?? detectFileType(args.fileName);
    const form = new FormData();
    form.set("file_type", fileType);
    form.set("file_name", args.fileName);
    if (args.duration !== undefined) form.set("duration", String(args.duration));
    form.set("file", await binaryInputToBlob(args.file), args.fileName);
    const json = await this.#requestForm("POST", "/open-apis/im/v1/files", form);
    const fileKey = (json as { data?: { file_key?: string }; file_key?: string }).data?.file_key ??
      (json as { file_key?: string }).file_key;
    if (!fileKey) {
      throw new LarkApiError("eve-lark: uploadFile missing file_key", {
        body: json as LarkApiErrorBody,
      });
    }
    return { fileKey };
  }

  async sendImage(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    imageKey: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    return this.#sendMediaMessage("image", JSON.stringify({ image_key: args.imageKey }), args);
  }

  async sendFile(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    fileKey: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    return this.#sendMediaMessage("file", JSON.stringify({ file_key: args.fileKey }), args);
  }

  async sendAudio(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    fileKey: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    return this.#sendMediaMessage("audio", JSON.stringify({ file_key: args.fileKey }), args);
  }

  async sendVideo(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    fileKey: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    return this.#sendMediaMessage("media", JSON.stringify({ file_key: args.fileKey }), args);
  }

  async uploadAndSendMedia(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    media: LarkOutboundMedia;
    rootId?: string;
    parentId?: string;
    mediaLocalRoots?: readonly string[];
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    const media = await this.#resolveOutboundMedia(args.media, args.mediaLocalRoots);
    const fileName = media.fileName;
    if (isImageFileName(fileName)) {
      const uploaded = await this.uploadImage({
        image: media.data,
        imageType: "message",
        fileName,
      });
      return this.sendImage({
        target: {
          id: target.receiveId,
          idType: target.receiveIdType,
          rootId: target.rootId,
          parentId: target.parentId,
        },
        imageKey: uploaded.imageKey,
      });
    }

    const fileType = detectFileType(fileName);
    const duration = media.duration ?? inferDurationFromFileName(fileName);
    const uploaded = await this.uploadFile({
      file: media.data,
      fileName,
      fileType,
      ...(duration !== undefined ? { duration } : {}),
    });
    if (fileType === "opus") {
      return this.sendAudio({
        target: {
          id: target.receiveId,
          idType: target.receiveIdType,
          rootId: target.rootId,
          parentId: target.parentId,
        },
        fileKey: uploaded.fileKey,
      });
    }
    if (fileType === "mp4") {
      return this.sendVideo({
        target: {
          id: target.receiveId,
          idType: target.receiveIdType,
          rootId: target.rootId,
          parentId: target.parentId,
        },
        fileKey: uploaded.fileKey,
      });
    }
    return this.sendFile({
      target: {
        id: target.receiveId,
        idType: target.receiveIdType,
        rootId: target.rootId,
        parentId: target.parentId,
      },
      fileKey: uploaded.fileKey,
    });
  }

  async forwardMessage(args: {
    messageId: string;
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
    });
    const json = await this.#request(
      "POST",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/forward?receive_id_type=${target.receiveIdType}`,
      { receive_id: target.receiveId },
    );
    const messageId = (json as { data?: { message_id?: string } }).data?.message_id;
    if (!messageId) {
      throw new LarkApiError("eve-lark: forwardMessage missing message_id", {
        body: json as LarkApiErrorBody,
      });
    }
    return { messageId };
  }

  async deleteMessage(args: { messageId: string }): Promise<void> {
    await this.#request(
      "DELETE",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`,
      undefined,
    );
  }

  async updateChat(args: {
    chatId: string;
    name?: string;
    avatar?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = {};
    if (args.name) body.name = args.name;
    if (args.avatar) body.avatar = args.avatar;
    await this.#request(
      "PATCH",
      `/open-apis/im/v1/chats/${encodeURIComponent(args.chatId)}`,
      body,
    );
  }

  async addChatMembers(args: { chatId: string; memberIds: string[] }): Promise<void> {
    await this.#request(
      "POST",
      `/open-apis/im/v1/chats/${encodeURIComponent(args.chatId)}/members?member_id_type=open_id`,
      { id_list: args.memberIds },
    );
  }

  async removeChatMembers(args: { chatId: string; memberIds: string[] }): Promise<void> {
    await this.#request(
      "DELETE",
      `/open-apis/im/v1/chats/${encodeURIComponent(args.chatId)}/members?member_id_type=open_id`,
      { id_list: args.memberIds },
    );
  }

  async listChatMembers(args: { chatId: string; pageToken?: string }): Promise<{
    members: Array<{ memberId: string; name: string }>;
    pageToken?: string;
    hasMore: boolean;
  }> {
    const query = new URLSearchParams({ member_id_type: "open_id", page_size: "100" });
    if (args.pageToken) query.set("page_token", args.pageToken);
    const json = await this.#request(
      "GET",
      `/open-apis/im/v1/chats/${encodeURIComponent(args.chatId)}/members?${query.toString()}`,
      undefined,
    );
    const data = (json as {
      data?: {
        items?: Array<{ member_id?: string; name?: string }>;
        page_token?: string;
        has_more?: boolean;
      };
    }).data;
    return {
      members: (data?.items ?? []).map((item) => ({
        memberId: item.member_id ?? "",
        name: item.name ?? "",
      })).filter((item) => item.memberId && item.name),
      pageToken: data?.page_token,
      hasMore: data?.has_more === true,
    };
  }

  async listReactions(args: { messageId: string; emojiType?: string | undefined }): Promise<{
    reactions: Array<{ reactionId: string; emojiType?: string | undefined; operatorType?: string | undefined }>;
  }> {
    const query = new URLSearchParams();
    if (args.emojiType) query.set("emoji_type", args.emojiType);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const json = await this.#request(
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reactions${suffix}`,
      undefined,
    );
    const items = (json as {
      data?: {
        items?: Array<{
          reaction_id?: string;
          reaction_type?: { emoji_type?: string };
          operator_type?: string;
        }>;
      };
    }).data?.items ?? [];
    return {
      reactions: items
        .map((item) => ({
          reactionId: item.reaction_id ?? "",
          emojiType: item.reaction_type?.emoji_type,
          operatorType: item.operator_type,
        }))
        .filter((item) => item.reactionId),
    };
  }

  async #resolveOutboundMedia(media: LarkOutboundMedia, mediaLocalRoots?: readonly string[]): Promise<{
    data: Buffer | Uint8Array | Blob | string;
    fileName: string;
    duration?: number | undefined;
  }> {
    if ("data" in media) {
      if (typeof media.data === "string") {
        await this.#assertLocalMediaPathAllowed(media.data, mediaLocalRoots);
      }
      return media;
    }
    const url = new URL(media.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new LarkApiError(`eve-lark: unsupported media URL protocol ${url.protocol}`);
    }
    await this.#assertRemoteMediaUrlAllowed(url);
    const res = await this.options.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new LarkApiError(`eve-lark: media URL fetch failed HTTP ${res.status}`, {
        status: res.status,
      });
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      fileName: media.fileName ?? fileNameFromUrl(url) ?? "file",
    };
  }

  async #assertLocalMediaPathAllowed(filePath: string, mediaLocalRoots?: readonly string[]): Promise<void> {
    const roots = mediaLocalRoots ?? this.options.mediaLocalRoots ?? [];
    if (roots.length === 0) {
      throw new LarkApiError("eve-lark: local media paths require mediaLocalRoots");
    }
    const resolved = await realpath(path.resolve(filePath));
    const resolvedRoots = await Promise.all(
      roots.map(async (root) => {
        try {
          return await realpath(path.resolve(root));
        } catch {
          return null;
        }
      }),
    );
    const allowed = resolvedRoots.some((root) => root !== null && isPathInside(resolved, root));
    if (!allowed) {
      throw new LarkApiError("eve-lark: local media path is outside mediaLocalRoots");
    }
  }

  async #assertRemoteMediaUrlAllowed(url: URL): Promise<void> {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
      throw new LarkApiError("eve-lark: private/localhost media URL is not allowed");
    }
    if (isPrivateHostname(host)) {
      throw new LarkApiError("eve-lark: private/loopback media URL is not allowed");
    }
    const resolver = this.options.mediaHostResolver ?? defaultMediaHostResolver;
    let addresses: readonly string[];
    try {
      addresses = await resolver(host);
    } catch (e) {
      throw new LarkApiError(`eve-lark: media URL host resolution failed for ${host}`, {
        body: { msg: e instanceof Error ? e.message : String(e) },
      });
    }
    for (const address of addresses) {
      if (isPrivateHostname(address)) {
        throw new LarkApiError("eve-lark: media URL resolves to a private/loopback address");
      }
    }
  }

  /** Quote-reply to a specific message via Feishu's reply API.
   *  POST /open-apis/im/v1/messages/{message_id}/reply — this is the only
   *  way to quote-reply to a normal (non-thread) message; sendMessage's
   *  root_id field only works inside threads. */
  async #replyMessage(
    replyToMessageId: string,
    msgType: string,
    content: string,
    replyInThread = false,
  ): Promise<{ messageId: string }> {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`;
    const json = await this.#request("POST", path, {
      msg_type: msgType,
      content,
      ...(replyInThread ? { reply_in_thread: true } : {}),
    });
    const messageId = (json as { data?: { message_id?: string } }).data?.message_id;
    console.log(`[eve-lark] reply API msgType=${msgType} replyTo=${replyToMessageId} → messageId=${messageId ?? "?"}`);
    if (!messageId) {
      throw new LarkApiError("eve-lark: reply missing message_id in response", {
        body: json as LarkApiErrorBody,
      });
    }
    return { messageId };
  }

  async #sendMessage(body: Record<string, unknown>, receiveIdType: LarkReceiveIdType): Promise<{ messageId: string }> {
    const payload = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const json = await this.#request("POST", `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, payload);
    const messageId = (json as { data?: { message_id?: string } }).data?.message_id;
    if (!messageId) {
      throw new LarkApiError("eve-lark: send missing message_id in response", {
        body: json as LarkApiErrorBody,
      });
    }
    return { messageId };
  }

  async #sendMediaMessage(
    msgType: "image" | "file" | "audio" | "media",
    content: string,
    args: { chatId?: string; to?: LarkOutboundTarget; target?: LarkOutboundTarget; rootId?: string; parentId?: string },
  ): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    if (target.rootId) {
      return this.#replyMessage(target.rootId, msgType, content, Boolean(target.threadId));
    }
    return this.#sendMessage({
      receive_id: target.receiveId,
      msg_type: msgType,
      content,
    }, target.receiveIdType);
  }

  async patchCard(args: { messageId: string; card: unknown }): Promise<void> {
    await this.#request(
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`,
      { content: JSON.stringify(args.card) },
    );
  }

  async createCardEntity(args: { card: unknown }): Promise<{ cardId: string }> {
    const json = await this.#request("POST", "/open-apis/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(args.card),
    });
    const cardId =
      (json as { data?: { card_id?: string }; card_id?: string }).data?.card_id ??
      (json as { card_id?: string }).card_id;
    if (!cardId) {
      throw new LarkApiError("eve-lark: card.create missing card_id in response", {
        body: json as LarkApiErrorBody,
      });
    }
    return { cardId };
  }

  async sendCardByCardId(args: {
    chatId?: string;
    to?: LarkOutboundTarget;
    target?: LarkOutboundTarget;
    cardId: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const target = resolveLarkOutboundTarget({
      to: args.target ?? args.to,
      chatId: args.chatId,
      rootId: args.rootId,
      parentId: args.parentId,
    });
    const content = JSON.stringify({
      type: "card",
      data: { card_id: args.cardId },
    });
    const sendOnce = () => target.rootId
      ? this.#replyMessage(target.rootId, "interactive", content, Boolean(target.threadId))
      : this.#sendMessage({
        receive_id: target.receiveId,
        msg_type: "interactive",
        content,
      }, target.receiveIdType);

    for (let attempt = 0; ; attempt++) {
      try {
        return await sendOnce();
      } catch (error) {
        if (attempt >= this.options.maxRetries || !isCardKitCardIdNotReady(error)) {
          throw error;
        }
        await sleep(CARDKIT_CARD_ID_NOT_READY_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  async streamCardContent(args: {
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
  }): Promise<void> {
    await this.#request(
      "PUT",
      `/open-apis/cardkit/v1/cards/${encodeURIComponent(args.cardId)}/elements/${encodeURIComponent(args.elementId)}/content`,
      { content: args.content, sequence: args.sequence },
    );
  }

  async setCardStreamingMode(args: {
    cardId: string;
    streamingMode: boolean;
    sequence: number;
  }): Promise<void> {
    await this.#request(
      "PATCH",
      `/open-apis/cardkit/v1/cards/${encodeURIComponent(args.cardId)}/settings`,
      {
        settings: JSON.stringify({ streaming_mode: args.streamingMode }),
        sequence: args.sequence,
      },
    );
  }

  async updateCardKitCard(args: {
    cardId: string;
    card: unknown;
    sequence: number;
  }): Promise<void> {
    await this.#request(
      "PUT",
      `/open-apis/cardkit/v1/cards/${encodeURIComponent(args.cardId)}`,
      {
        card: { type: "card_json", data: JSON.stringify(args.card) },
        sequence: args.sequence,
      },
    );
  }

  async downloadResource(args: {
    messageId: string;
    fileKey: string;
    type: "image" | "file";
  }): Promise<Buffer> {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/resources/${encodeURIComponent(args.fileKey)}?type=${args.type}`;
    const token = await this.getTenantAccessToken();
    const res = await this.options.fetch(`${this.options.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new LarkApiError(
        `eve-lark: downloadResource HTTP ${res.status}`,
        { status: res.status },
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async addReaction(args: {
    messageId: string;
    emojiType: string;
  }): Promise<{ reactionId: string }> {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reactions`;
    const json = (await this.#request("POST", path, {
      reaction_type: { emoji_type: args.emojiType },
    })) as { data?: { reaction_id?: string } };
    const reactionId = json.data?.reaction_id;
    if (!reactionId) {
      throw new LarkApiError("eve-lark: addReaction missing reaction_id", {
        body: json as LarkApiErrorBody,
      });
    }
    return { reactionId };
  }

  async removeReaction(args: { messageId: string; reactionId: string }): Promise<void> {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reactions/${encodeURIComponent(args.reactionId)}`;
    await this.#request("DELETE", path, undefined);
  }

  async getMessageContext(args: { messageId: string }): Promise<{
    chatId: string;
    chatType: "p2p" | "group";
    rootId?: string | undefined;
    parentId?: string | undefined;
  }> {
    const json = await this.#request(
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`,
      undefined,
    );
    const item = (json as {
      data?: {
        items?: Array<{
          chat_id?: string;
          root_id?: string;
          parent_id?: string;
        }>;
      };
    }).data?.items?.[0];
    if (!item?.chat_id) {
      throw new LarkApiError("eve-lark: getMessageContext missing chat_id", {
        body: json as LarkApiErrorBody,
      });
    }

    const chatJson = await this.#request(
      "GET",
      `/open-apis/im/v1/chats/${encodeURIComponent(item.chat_id)}`,
      undefined,
    );
    const chatMode = (chatJson as { data?: { chat_mode?: string } }).data?.chat_mode;
    return {
      chatId: item.chat_id,
      chatType: chatMode === "group" ? "group" : "p2p",
      rootId: item.root_id,
      parentId: item.parent_id,
    };
  }

  async getMessageContent(args: { messageId: string; rawCardContent?: boolean | undefined }): Promise<string | undefined> {
    const query = new URLSearchParams({ user_id_type: "open_id" });
    if (args.rawCardContent) query.set("card_msg_content_type", "raw_card_content");
    const json = await this.#request(
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}?${query.toString()}`,
      undefined,
    );
    const item = (json as { data?: { items?: ApiMessageItem[] } }).data?.items?.[0];
    return readApiMessageContent(item);
  }

  async getMergedForwardMessages(args: { messageId: string }): Promise<LarkInboundEvent[]> {
    const query = new URLSearchParams({
      user_id_type: "open_id",
      card_msg_content_type: "raw_card_content",
    });
    const json = await this.#request(
      "GET",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}?${query.toString()}`,
      undefined,
    );
    const items = (json as { data?: { items?: ApiMessageItem[] } }).data?.items ?? [];
    return items.map(apiMessageItemToInboundEvent).filter((event) => event.message.message_id);
  }

  /**
   * Central request wrapper with auth, retry, and Feishu error decoding.
   *
   * Retry policy:
   *   - 429 (rate limit): always retry with `Retry-After` backoff. Safe —
   *     server rejected the request before processing.
   *   - 5xx: retry ONLY for idempotent methods (GET / PATCH / DELETE). POST
   *     is NOT retried on 5xx because Feishu's POST /messages and POST
   *     /reactions are non-idempotent — the server may have created the
   *     resource before returning the error, and retrying would silently
   *     double-send.
   *   - 401 / token-invalid code: refresh and retry once.
   *   - Other 4xx: throw LarkApiError with the Feishu code/msg.
   */
  async #request(method: string, path: string, body: unknown): Promise<unknown> {
    return this.#requestPrepared(method, path, (token) => ({
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    }));
  }

  async #requestForm(method: string, path: string, body: FormData): Promise<unknown> {
    return this.#requestPrepared(method, path, (token) => ({
      method,
      headers: {
        authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    }));
  }

  async #requestPrepared(
    method: string,
    requestPath: string,
    buildInit: (token: string) => RequestInit,
  ): Promise<unknown> {
    const url = `${this.options.baseUrl}${requestPath}`;
    let token = await this.getTenantAccessToken();
    let tokenRefreshed = false;
    const methodNorm = method.toUpperCase();
    const retryableMethod = methodNorm !== "POST";

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const res = await this.options.fetch(url, buildInit(token));

      const result = await this.#consumeResponse(res);
      const status = result.status;

      if (status >= 200 && status < 300) {
        const jsonBody = result.body as { code?: number; msg?: string };
        if (jsonBody && typeof jsonBody.code === "number" && jsonBody.code !== 0) {
          if (TOKEN_INVALID_CODES.has(jsonBody.code) && !tokenRefreshed) {
            this.token = null;
            token = await this.getTenantAccessToken();
            tokenRefreshed = true;
            attempt -= 1;
            continue;
          }
          throw new LarkApiError(
            `eve-lark: ${method} ${requestPath} failed code=${jsonBody.code} msg=${jsonBody.msg ?? "?"}`,
            { code: jsonBody.code, body: jsonBody as LarkApiErrorBody, status },
          );
        }
        return result.body;
      }

      if (status === 401 && !tokenRefreshed) {
        this.token = null;
        token = await this.getTenantAccessToken();
        tokenRefreshed = true;
        attempt -= 1;
        continue;
      }

      const isRateLimited = status === 429;
      const isServerErr = status >= 500 && status < 600;
      const retryable = isRateLimited || (isServerErr && retryableMethod);
      if (retryable && attempt < this.options.maxRetries) {
        const delayMs = this.#computeBackoff(status, result.retryAfter, attempt);
        await sleep(delayMs);
        continue;
      }

      const bodyObj = result.body as LarkApiErrorBody | undefined;
      const code = bodyObj?.code;
      const msg = bodyObj?.msg;
      const detail = msg ? ` code=${code ?? "?"} msg=${msg}` : "";
      throw new LarkApiError(
        `eve-lark: ${method} ${requestPath} failed HTTP ${status}${detail}`,
        { status, body: bodyObj, code },
      );
    }
    throw new LarkApiError(`eve-lark: ${method} ${requestPath} exhausted retries`);
  }

  async #consumeResponse(res: Response): Promise<RequestResult> {
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfter = retryAfterRaw ? parseRetryAfter(retryAfterRaw) : null;
    const text = await res.text();
    if (!text) {
      return { status: res.status, body: undefined, retryAfter };
    }
    try {
      return { status: res.status, body: JSON.parse(text), retryAfter };
    } catch {
      return { status: res.status, body: { raw: text }, retryAfter };
    }
  }

  #computeBackoff(status: number, retryAfter: number | null, attempt: number): number {
    if (status === 429 && retryAfter !== null) {
      return Math.min(retryAfter * 1000, 10_000);
    }
    const base = 300 * Math.pow(2, attempt);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }
}

function parseRetryAfter(raw: string): number | null {
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return sec;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return null;
}

async function binaryInputToBlob(input: Buffer | Uint8Array | Blob | string): Promise<Blob> {
  if (input instanceof Blob) return input;
  if (typeof input === "string") {
    return new Blob([await readFile(input)]);
  }
  return new Blob([new Uint8Array(input)]);
}

function isImageFileName(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function detectFileType(fileName: string): UploadFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") return "opus";
  if (ext === ".mp4" || ext === ".mov" || ext === ".avi" || ext === ".mkv" || ext === ".webm") return "mp4";
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx") return "doc";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") return "xls";
  if (ext === ".ppt" || ext === ".pptx") return "ppt";
  return "stream";
}

function fileNameFromUrl(url: URL): string | null {
  const baseName = path.posix.basename(url.pathname);
  if (!baseName || baseName === "/" || baseName === ".") return null;
  try {
    return decodeURIComponent(baseName);
  } catch {
    return baseName;
  }
}

function readApiMessageContent(item: ApiMessageItem | undefined): string | undefined {
  return item?.body?.content ?? item?.content;
}

function apiMessageItemToInboundEvent(item: ApiMessageItem): LarkInboundEvent {
  const senderOpenId = item.sender?.sender_id?.open_id ?? item.sender?.id ?? "";
  return {
    message: {
      message_id: item.message_id ?? "",
      chat_id: item.chat_id ?? "",
      root_id: item.root_id,
      parent_id: item.parent_id,
      chat_type: item.chat_type,
      message_type: item.msg_type ?? item.message_type ?? "text",
      content: readApiMessageContent(item) ?? "",
    },
    sender: {
      sender_id: {
        open_id: senderOpenId,
        user_id: item.sender?.sender_id?.user_id,
        union_id: item.sender?.sender_id?.union_id,
      },
      sender_type: item.sender?.sender_type,
    },
    chat_type: item.chat_type,
  };
}

function inferDurationFromFileName(fileName: string): number | undefined {
  const match = fileName.match(/(?:^|[._-])(\d{1,8})ms(?:[._-]|$)/i);
  if (!match?.[1]) return undefined;
  const duration = Number(match[1]);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function isPathInside(filePath: string, root: string): boolean {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function defaultMediaHostResolver(hostname: string): Promise<readonly string[]> {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
}

function isPrivateHostname(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCardKitCardIdNotReady(error: unknown): boolean {
  if (!(error instanceof LarkApiError)) return false;
  if (error.status !== 400 || error.code !== 230099) return false;
  const detail = `${error.message} ${JSON.stringify(error.body ?? {})}`.toLowerCase();
  return detail.includes("failed to create card content") && detail.includes("cardid is invalid");
}
