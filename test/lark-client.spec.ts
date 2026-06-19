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
    fetch: fetchImpl,
    ackReaction: false,
    mode: "webhook",
    port: 2000,
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

    it("includes root_id and parent_id when supplied", async () => {
      registerToken(mock);
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          const body = req.body as Record<string, unknown>;
          if (body.root_id !== "om_root" || body.parent_id !== "om_parent") {
            return { status: 400, body: { msg: "no thread" } };
          }
          return { status: 200, body: { code: 0, data: { message_id: "om_r" } } };
        },
        { description: "POST threaded sendText" },
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
