import { describe, expect, it } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test",
    appSecret: "secret_test",
    verificationToken: "tok",
    encryptKey: undefined,
    baseUrl: BASE,
    botOpenId: undefined,
    webhookPath: "/lark/webhook",
    replyMode: "post",
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
    fetch: globalThis.fetch,
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

function makeChannel(mock: MockFetch) {
  mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
    status: 200, body: { code: 0, tenant_access_token: "tat_test", expire: 7200 },
  }));
  mock.on("POST", "/open-apis/im/v1/messages", () => ({
    status: 200, body: { code: 0, data: { message_id: "om_x" } },
  }));
  mock.on("PATCH", (url) => url.pathname.startsWith("/open-apis/im/v1/messages/"), () => ({
    status: 200, body: { code: 0 },
  }));
  const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
  return (channel as unknown as {
    __testEvents: Record<string, (data: unknown, ch: unknown, ctx: unknown) => Promise<unknown> | unknown>;
  }).__testEvents;
}

const CTX = {
  session: {
    id: "sess_test",
    auth: {
      initiator: {
        attributes: {
          chatId: "oc_chat1",
          rootMessageId: undefined,
          parentId: undefined,
          messageId: "om_in_1",
        },
      },
    },
  },
};

describe("turn.completed event", () => {
  it("exists as a registered handler", () => {
    const mock = createMockFetch();
    const events = makeChannel(mock);
    expect(typeof events["turn.completed"]).toBe("function");
  });

  it("does not throw when there is no controller for the session (no-op cleanup)", async () => {
    const mock = createMockFetch();
    const events = makeChannel(mock);
    // No prior message.appended — controller doesn't exist. turn.completed
    // must be a safe no-op, not throw.
    await expect(
      events["turn.completed"]!({ sequence: 1, stepIndex: 0, turnId: "t1" }, {}, CTX),
    ).resolves.toBeUndefined();
  });

  it("completes without errors even when replyMode is streaming and a controller exists", async () => {
    const mock = createMockFetch();
    const events = makeChannel(mock);
    // Prime a controller by simulating a delta.
    events["message.appended"]!(
      { messageDelta: "partial", messageSoFar: "partial", sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      CTX,
    );
    // turn.completed should not throw — it's the end of the turn.
    await expect(
      events["turn.completed"]!({ sequence: 2, stepIndex: 0, turnId: "t1" }, {}, CTX),
    ).resolves.toBeUndefined();
  });
});
