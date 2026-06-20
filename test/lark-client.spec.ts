import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { LarkClient } from "../src/lark-client.js";
import type { ResolvedLarkOptions } from "../src/types.js";
import { LarkApiError } from "../src/errors.js";

const BASE = "https://open.feishu.test";

function makeOptions(
  fetchImpl: typeof fetch,
  overrides: Partial<ResolvedLarkOptions> = {},
): ResolvedLarkOptions {
  return {
    appId: "cli_test",
    appSecret: "secret_test",
    verificationToken: "tok",
    encryptKey: undefined,
    baseUrl: BASE,
    botOpenId: undefined,
    webhookPath: "/lark/webhook",
    replyMode: "streaming",
    streamPatchIntervalMs: 1000,
    streamCreateThresholdMs: 400,
    dedupTtlMs: 30 * 60 * 1000,
    dedupMaxEntries: 5000,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    tokenRefreshBufferMs: 60_000,
    signatureSkewMs: 300_000,
    eventMaxAgeMs: 10 * 60 * 1000,
    askInputTtlMs: 5 * 60 * 1000,
    fetch: fetchImpl,
    ackReaction: false,
    mode: "webhook",
    port: 2000,
    allowFrom: undefined,
    groupAllowFrom: undefined,
    groupConfigs: undefined,
    asrProvider: undefined,
    ...overrides,
  };
}

function registerToken(mock: MockFetch, token = "tat_test", expire = 7200) {
  mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", (req) => {
    const body = req.body as { app_id: string; app_secret: string };
    if (body.app_id !== "cli_test" || body.app_secret !== "secret_test") {
      return { status: 401, body: { code: 99991661, msg: "bad app" } };
    }
    return { status: 200, body: { code: 0, tenant_access_token: token, expire } };
  }, { description: "POST tenant_access_token" });
}

describe("LarkClient", () => {
  let mock: MockFetch;
  beforeEach(() => {
    mock = createMockFetch();
  });
  afterEach(() => {
    const pending = mock.pendingCount();
    if (pending > 0) {
      throw new Error(`pending mock handlers: ${mock.pendingDescriptions().join(", ")}`);
    }
  });
  afterAll(() => {});

  describe("tenant_access_token", () => {
    it("caches the token across calls within the expiry window", async () => {
      registerToken(mock);
      const c = new LarkClient(makeOptions(mock.fetch));
      const a = await c.getTenantAccessToken();
      const b = await c.getTenantAccessToken();
      expect(a).toBe("tat_test");
      expect(b).toBe("tat_test");
      expect(mock.pendingCount()).toBe(0);
    });

    it("refreshes the token when expiry approaches the buffer", async () => {
      let tokenCall = 0;
      mock.on(
        "POST",
        "/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          tokenCall += 1;
          return {
            status: 200,
            body: {
              code: 0,
              tenant_access_token: tokenCall === 1 ? "tat_test" : "tat_test_2",
              expire: tokenCall === 1 ? 60 : 7200,
            },
          };
        },
        { description: "POST tenant_access_token (counter)" },
      );
      const c = new LarkClient(makeOptions(mock.fetch, { tokenRefreshBufferMs: 60_000 }));
      const a = await c.getTenantAccessToken();
      expect(a).toBe("tat_test");
      const b = await c.getTenantAccessToken();
      expect(b).toBe("tat_test_2");
    });

    it("serializes concurrent refreshes via a shared mutex", async () => {
      registerToken(mock);
      const c = new LarkClient(makeOptions(mock.fetch));
      const [a, b] = await Promise.all([
        c.getTenantAccessToken(),
        c.getTenantAccessToken(),
      ]);
      expect(a).toBe("tat_test");
      expect(b).toBe("tat_test");
      expect(mock.pendingCount()).toBe(0);
    });
  });

  describe("sendText", () => {
    it("POSTs to im/v1/messages with the right body and Authorization", async () => {
      registerToken(mock);
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          const body = req.body as Record<string, unknown>;
          if (body.receive_id !== "oc_chat1" || body.msg_type !== "text") {
            return { status: 400, body: { msg: "mismatch" } };
          }
          const content = JSON.parse(body.content as string);
          if (content.text !== "hello") return { status: 400, body: { msg: "no text" } };
          return { status: 200, body: { code: 0, data: { message_id: "om_new" } } };
        },
        {
          description: "POST sendText",
          headerMatcher: (h) => h["authorization"] === "Bearer tat_test",
        },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const r = await c.sendText({ chatId: "oc_chat1", content: "hello" });
      expect(r.messageId).toBe("om_new");
    });

    it("uses reply API (POST /messages/{id}/reply) when rootId supplied", async () => {
      registerToken(mock);
      mock.on(
        "POST",
        "/open-apis/im/v1/messages/om_root/reply",
        (req) => {
          const body = req.body as Record<string, unknown>;
          if (body.msg_type !== "text") return { status: 400, body: { msg: "wrong type" } };
          return { status: 200, body: { code: 0, data: { message_id: "om_r" } } };
        },
        { description: "POST reply sendText" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      await c.sendText({
        chatId: "oc_c",
        content: "threaded",
        rootId: "om_root",
        parentId: "om_parent",
      });
    });
  });

  describe("sendCard", () => {
    it("POSTs an interactive card payload", async () => {
      registerToken(mock);
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          const body = req.body as Record<string, unknown>;
          if (body.msg_type !== "interactive") return { status: 400, body: { msg: "wrong" } };
          return { status: 200, body: { code: 0, data: { message_id: "om_card" } } };
        },
        { description: "POST sendCard" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const r = await c.sendCard({
        chatId: "oc_c",
        card: { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: "hi" }] },
      });
      expect(r.messageId).toBe("om_card");
    });
  });

  describe("patchCard", () => {
    it("PATCHes the existing message with new card content", async () => {
      registerToken(mock);
      mock.on(
        "PATCH",
        (url) => url.pathname.startsWith("/open-apis/im/v1/messages/om_existing"),
        (req) => {
          const body = req.body as Record<string, unknown>;
          if (typeof body.content !== "string") return { status: 400, body: { msg: "no content" } };
          return { status: 200, body: { code: 0 } };
        },
        {
          description: "PATCH patchCard",
          headerMatcher: (h) => h["authorization"] === "Bearer tat_test",
        },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      await c.patchCard({
        messageId: "om_existing",
        card: { config: {}, elements: [{ tag: "markdown", content: "v2" }] },
      });
    });
  });

  describe("CardKit entity APIs", () => {
    it("creates a CardKit card entity from raw card json", async () => {
      registerToken(mock);
      let captured: unknown;
      mock.on(
        "POST",
        "/open-apis/cardkit/v1/cards",
        (req) => {
          captured = req.body;
          return { status: 200, body: { code: 0, data: { card_id: "card_1" } } };
        },
        { description: "POST cardkit card.create" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const res = await c.createCardEntity({ card: { schema: "2.0" } });

      expect(res.cardId).toBe("card_1");
      expect(captured).toEqual({
        type: "card_json",
        data: JSON.stringify({ schema: "2.0" }),
      });
    });

    it("sends an IM interactive message by CardKit card_id", async () => {
      registerToken(mock);
      let captured: Record<string, unknown> | null = null;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          captured = req.body as Record<string, unknown>;
          return { status: 200, body: { code: 0, data: { message_id: "om_cardkit" } } };
        },
        { description: "POST im message by card_id" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const res = await c.sendCardByCardId({ chatId: "oc_c", cardId: "card_1" });

      expect(res.messageId).toBe("om_cardkit");
      expect(captured).toMatchObject({
        receive_id: "oc_c",
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: "card_1" } }),
      });
    });

    it("retries CardKit card_id sends when the created card is not visible yet", async () => {
      registerToken(mock);
      let attempts = 0;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => {
          attempts += 1;
          if (attempts === 1) {
            return {
              status: 400,
              body: {
                code: 230099,
                msg: "Failed to create card content",
                error: { ext: "ErrCode: 11310; ErrMsg: cardid is invalid;" },
              },
            };
          }
          return { status: 200, body: { code: 0, data: { message_id: "om_cardkit_retry" } } };
        },
        { description: "POST im message by card_id after visibility delay" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const res = await c.sendCardByCardId({ chatId: "oc_c", cardId: "card_1" });

      expect(res.messageId).toBe("om_cardkit_retry");
      expect(attempts).toBe(2);
    });

    it("streams content to a CardKit element with a monotonically supplied sequence", async () => {
      registerToken(mock);
      let captured: Record<string, unknown> | null = null;
      mock.on(
        "PUT",
        "/open-apis/cardkit/v1/cards/card_1/elements/answer/content",
        (req) => {
          captured = req.body as Record<string, unknown>;
          return { status: 200, body: { code: 0 } };
        },
        { description: "PUT cardkit element content" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      await c.streamCardContent({
        cardId: "card_1",
        elementId: "answer",
        content: "partial",
        sequence: 2,
      });

      expect(captured).toEqual({ content: "partial", sequence: 2 });
    });

    it("closes streaming mode and updates the terminal CardKit card", async () => {
      registerToken(mock);
      const calls: Array<{ path: string; body: unknown }> = [];
      mock.on(
        "PATCH",
        "/open-apis/cardkit/v1/cards/card_1/settings",
        (req) => {
          calls.push({ path: req.url.pathname, body: req.body });
          return { status: 200, body: { code: 0 } };
        },
        { description: "PATCH cardkit settings" },
      );
      mock.on(
        "PUT",
        "/open-apis/cardkit/v1/cards/card_1",
        (req) => {
          calls.push({ path: req.url.pathname, body: req.body });
          return { status: 200, body: { code: 0 } };
        },
        { description: "PUT cardkit card.update" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      await c.setCardStreamingMode({ cardId: "card_1", streamingMode: false, sequence: 3 });
      await c.updateCardKitCard({ cardId: "card_1", card: { schema: "2.0" }, sequence: 4 });

      expect(calls).toEqual([
        {
          path: "/open-apis/cardkit/v1/cards/card_1/settings",
          body: { settings: JSON.stringify({ streaming_mode: false }), sequence: 3 },
        },
        {
          path: "/open-apis/cardkit/v1/cards/card_1",
          body: {
            card: { type: "card_json", data: JSON.stringify({ schema: "2.0" }) },
            sequence: 4,
          },
        },
      ]);
    });
  });

  describe("downloadResource", () => {
    it("GETs the resource and returns the raw bytes", async () => {
      registerToken(mock);
      // Binary downloads bypass the JSON envelope of MockFetch; the wrapper
      // routes anything touching /resources/ to a fixed PNG.
      const binaryFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        if (url.pathname.includes("/resources/")) {
          return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        return mock.fetch(input, init);
      }) as unknown as typeof fetch;

      const c = new LarkClient(makeOptions(binaryFetch));
      const bytes = await c.downloadResource({
        messageId: "om_m",
        fileKey: "img_key",
        type: "image",
      });
      expect(bytes.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    });
  });

  describe("getMessageContext", () => {
    it("resolves chat context from a message id", async () => {
      registerToken(mock);
      mock.on(
        "GET",
        "/open-apis/im/v1/messages/om_1",
        () => ({
          status: 200,
          body: {
            code: 0,
            data: {
              items: [
                {
                  message_id: "om_1",
                  chat_id: "oc_group",
                  root_id: "om_root",
                  parent_id: "om_parent",
                },
              ],
            },
          },
        }),
        { description: "GET message context" },
      );
      mock.on(
        "GET",
        "/open-apis/im/v1/chats/oc_group",
        () => ({
          status: 200,
          body: { code: 0, data: { chat_mode: "group" } },
        }),
        { description: "GET chat context" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      await expect(c.getMessageContext({ messageId: "om_1" })).resolves.toEqual({
        chatId: "oc_group",
        chatType: "group",
        rootId: "om_root",
        parentId: "om_parent",
      });
    });
  });

  describe("retry policy", () => {
    it("retries on 429 honoring Retry-After", async () => {
      registerToken(mock);
      let calls = 0;
      const sleepSpy = vi.spyOn(globalThis, "setTimeout");
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => {
          calls += 1;
          if (calls === 1) {
            return {
              status: 429,
              body: "",
              headers: { "retry-after": "0.001" },
            };
          }
          return { status: 200, body: { code: 0, data: { message_id: "om_after" } } };
        },
        { description: "POST 429 then 200" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const r = await c.sendText({ chatId: "oc_c", content: "x" });
      expect(r.messageId).toBe("om_after");
      expect(sleepSpy).toHaveBeenCalled();
    }, 15_000);

    it("retries PATCH on 5xx with exponential backoff (idempotent)", async () => {
      registerToken(mock);
      let calls = 0;
      mock.on(
        "PATCH",
        (url) => url.pathname.startsWith("/open-apis/im/v1/messages/om_x"),
        () => {
          calls += 1;
          if (calls <= 2) return { status: 503, body: "" };
          return { status: 200, body: { code: 0 } };
        },
        { description: "PATCH 503 503 200" },
      );

      const c = new LarkClient(makeOptions(mock.fetch, { maxRetries: 2 }));
      await c.patchCard({
        messageId: "om_x",
        card: { config: {}, elements: [{ tag: "markdown", content: "v" }] },
      });
      expect(calls).toBe(3);
    }, 15_000);

    it("does NOT retry POST /messages on 5xx (non-idempotent — would double-send)", async () => {
      registerToken(mock);
      let calls = 0;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => {
          calls += 1;
          return { status: 503, body: "" };
        },
        { description: "POST 503 always" },
      );

      const c = new LarkClient(makeOptions(mock.fetch, { maxRetries: 3 }));
      await expect(
        c.sendText({ chatId: "oc_c", content: "x" }),
      ).rejects.toThrow(LarkApiError);
      // Single attempt — no retry, even though maxRetries=3.
      expect(calls).toBe(1);
    }, 15_000);

    it("still retries POST on 429 (server rejected before processing — safe)", async () => {
      registerToken(mock);
      let calls = 0;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => {
          calls += 1;
          if (calls === 1) {
            return { status: 429, body: "", headers: { "retry-after": "0.001" } };
          }
          return { status: 200, body: { code: 0, data: { message_id: "om_after" } } };
        },
        { description: "POST 429 then 200" },
      );

      const c = new LarkClient(makeOptions(mock.fetch, { maxRetries: 3 }));
      const r = await c.sendText({ chatId: "oc_c", content: "x" });
      expect(r.messageId).toBe("om_after");
      expect(calls).toBe(2);
    }, 15_000);

    it("throws LarkApiError on non-retryable 4xx with Feishu code/msg", async () => {
      registerToken(mock);
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => ({ status: 400, body: { code: 230001, msg: "chat not found" } }),
        { description: "POST 400" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      try {
        await c.sendText({ chatId: "oc_bad", content: "x" });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(LarkApiError);
        const err = e as LarkApiError;
        expect(err.code).toBe(230001);
        expect(err.status).toBe(400);
        expect(err.message).toContain("chat not found");
      }
    });

    it("refreshes the token and retries once on 401 mid-flight", async () => {
      // Initial token, then expired → refresh
      let tokenCall = 0;
      mock.on(
        "POST",
        "/open-apis/auth/v3/tenant_access_token/internal",
        () => {
          tokenCall += 1;
          return {
            status: 200,
            body: {
              code: 0,
              tenant_access_token: tokenCall === 1 ? "tat_test" : "tat_fresh",
              expire: 7200,
            },
          };
        },
        { description: "POST token refresh (sequence)" },
      );
      let sendCall = 0;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          sendCall += 1;
          if (sendCall === 1) {
            if (req.headers["authorization"] !== "Bearer tat_test") {
              return { status: 400, body: { msg: "wrong token" } };
            }
            return { status: 401, body: { code: 99991663, msg: "token invalid" } };
          }
          if (req.headers["authorization"] !== "Bearer tat_fresh") {
            return { status: 400, body: { msg: "expected fresh token" } };
          }
          return { status: 200, body: { code: 0, data: { message_id: "om_retry" } } };
        },
        { description: "POST send 401 then 200" },
      );

      const c = new LarkClient(makeOptions(mock.fetch));
      const r = await c.sendText({ chatId: "oc_c", content: "x" });
      expect(r.messageId).toBe("om_retry");
      expect(tokenCall).toBe(2);
    });
  });
});
