import { beforeEach, describe, expect, it } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { LarkClient } from "../src/lark-client.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function makeOptions(fetchImpl: typeof fetch): ResolvedLarkOptions {
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
  };
}

function registerToken(mock: MockFetch) {
  mock.on(
    "POST",
    "/open-apis/auth/v3/tenant_access_token/internal",
    () => ({
      status: 200,
      body: { code: 0, tenant_access_token: "tat_test", expire: 7200 },
    }),
    { description: "POST token" },
  );
}

describe("LarkClient.addReaction", () => {
  let mock: MockFetch;
  beforeEach(() => {
    mock = createMockFetch();
  });

  it("POSTs to the reactions endpoint with the right body and Authorization", async () => {
    registerToken(mock);
    let captured: { url: URL; body: unknown; auth: string } | null = null;
    mock.on(
      "POST",
      (url) => url.pathname.startsWith("/open-apis/im/v1/messages/om_m/reactions"),
      (req) => {
        captured = { url: req.url, body: req.body, auth: req.headers["authorization"] ?? "" };
        return { status: 200, body: { code: 0, data: { reaction_id: "r_1" } } };
      },
      { description: "POST reactions" },
    );

    const c = new LarkClient(makeOptions(mock.fetch));
    const r = await c.addReaction({ messageId: "om_m", emojiType: "EYES" });
    expect(r.reactionId).toBe("r_1");
    expect(captured).not.toBeNull();
    expect(captured!.url.pathname).toBe("/open-apis/im/v1/messages/om_m/reactions");
    expect(captured!.body).toEqual({ reaction_type: { emoji_type: "EYES" } });
    expect(captured!.auth).toBe("Bearer tat_test");
  });

  it("throws LarkApiError when Feishu rejects the emoji type", async () => {
    registerToken(mock);
    mock.on(
      "POST",
      "/open-apis/im/v1/messages/om_m/reactions",
      () => ({ status: 200, body: { code: 230002, msg: "emoji type not allowed" } }),
      { description: "POST reactions reject" },
    );

    const c = new LarkClient(makeOptions(mock.fetch));
    await expect(
      c.addReaction({ messageId: "om_m", emojiType: "BOGUS" }),
    ).rejects.toThrow(/emoji type not allowed/);
  });
});
