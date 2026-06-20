import { LarkApiError, type LarkApiErrorBody } from "./errors.js";
import type { LarkCard, ResolvedLarkOptions } from "./types.js";

interface TokenState {
  value: string;
  expiresAt: number;
}

const TOKEN_INVALID_CODES = new Set<number>([99991663, 99991664, 99991661]);

interface RequestResult {
  status: number;
  body: unknown;
  retryAfter: number | null;
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
    chatId: string;
    content: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const content = JSON.stringify({ text: args.content });
    if (args.rootId) {
      console.log(`[eve-lark] sendText → reply rootId=${args.rootId}`);
      return this.#replyMessage(args.rootId, "text", content);
    }
    console.log(`[eve-lark] sendText → send chatId=${args.chatId}`);
    return this.#sendMessage({
      receive_id: args.chatId,
      msg_type: "text",
      content,
    });
  }

  async sendCard(args: {
    chatId: string;
    card: LarkCard;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    const content = JSON.stringify(args.card);
    if (args.rootId) {
      console.log(`[eve-lark] sendCard → reply rootId=${args.rootId}`);
      return this.#replyMessage(args.rootId, "interactive", content);
    }
    console.log(`[eve-lark] sendCard → send chatId=${args.chatId}`);
    return this.#sendMessage({
      receive_id: args.chatId,
      msg_type: "interactive",
      content,
    });
  }

  async sendPost(args: {
    chatId: string;
    content: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
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
    if (args.rootId) {
      return this.#replyMessage(args.rootId, "post", content);
    }
    return this.#sendMessage({
      receive_id: args.chatId,
      msg_type: "post",
      content,
    });
  }

  /** Quote-reply to a specific message via Feishu's reply API.
   *  POST /open-apis/im/v1/messages/{message_id}/reply — this is the only
   *  way to quote-reply to a normal (non-thread) message; sendMessage's
   *  root_id field only works inside threads. */
  async #replyMessage(replyToMessageId: string, msgType: string, content: string): Promise<{ messageId: string }> {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`;
    const json = await this.#request("POST", path, { msg_type: msgType, content });
    const messageId = (json as { data?: { message_id?: string } }).data?.message_id;
    console.log(`[eve-lark] reply API msgType=${msgType} replyTo=${replyToMessageId} → messageId=${messageId ?? "?"}`);
    if (!messageId) {
      throw new LarkApiError("eve-lark: reply missing message_id in response", {
        body: json as LarkApiErrorBody,
      });
    }
    return { messageId };
  }

  async #sendMessage(body: Record<string, unknown>): Promise<{ messageId: string }> {
    const payload = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const json = await this.#request("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", payload);
    const messageId = (json as { data?: { message_id?: string } }).data?.message_id;
    if (!messageId) {
      throw new LarkApiError("eve-lark: send missing message_id in response", {
        body: json as LarkApiErrorBody,
      });
    }
    return { messageId };
  }

  async patchCard(args: { messageId: string; card: LarkCard }): Promise<void> {
    await this.#request(
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`,
      { content: JSON.stringify(args.card) },
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
    const url = `${this.options.baseUrl}${path}`;
    let token = await this.getTenantAccessToken();
    let tokenRefreshed = false;
    const methodNorm = method.toUpperCase();
    const retryableMethod = methodNorm !== "POST";

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const res = await this.options.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });

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
            `eve-lark: ${method} ${path} failed code=${jsonBody.code} msg=${jsonBody.msg ?? "?"}`,
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
        `eve-lark: ${method} ${path} failed HTTP ${status}${detail}`,
        { status, body: bodyObj, code },
      );
    }
    throw new LarkApiError(`eve-lark: ${method} ${path} exhausted retries`);
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
