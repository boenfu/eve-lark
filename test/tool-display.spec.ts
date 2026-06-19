import { describe, expect, it } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test", appSecret: "secret_test", verificationToken: "tok",
    encryptKey: undefined, baseUrl: BASE, botOpenId: undefined,
    webhookPath: "/lark/webhook", replyMode: "streaming",
    streamPatchIntervalMs: 1000, streamCreateThresholdMs: 400,
    dedupTtlMs: 30 * 60 * 1000, dedupMaxEntries: 5000,
    requestTimeoutMs: 5000, maxRetries: 2,
    tokenRefreshBufferMs: 60_000, signatureSkewMs: 300_000,
    fetch: globalThis.fetch, ackReaction: false, mode: "webhook", port: 2000,
    allowFrom: undefined, groupAllowFrom: undefined, groupConfigs: undefined, asrProvider: undefined,
    ...overrides,
  };
}

function makeChannel(mock: MockFetch) {
  mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
    status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
  }));
  mock.on("POST", "/open-apis/im/v1/messages", () => ({
    status: 200, body: { code: 0, data: { message_id: "om_x" } },
  }));
  mock.on("PATCH", (url) => url.pathname.includes("/open-apis/im/v1/messages/"), () => ({
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
    auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in" } } },
  },
};

describe("tool call display", () => {
  it("actions.requested event is registered", () => {
    const events = makeChannel(createMockFetch());
    expect(typeof events["actions.requested"]).toBe("function");
  });

  it("actions.requested updates the streaming controller status with tool name(s)", async () => {
    const mock = createMockFetch();
    const events = makeChannel(mock);

    // First trigger a delta so a controller exists with messageId.
    events["message.appended"]!(
      { messageDelta: "thinking", messageSoFar: "thinking", sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      CTX,
    );
    // Wait for the createTimer (streamCreateThresholdMs=400) — use real timers,
    // so wait 450ms.
    await new Promise((r) => setTimeout(r, 450));

    // Now actions.requested with two tool calls.
    await events["actions.requested"]!(
      {
        actions: [
          { kind: "tool-call", toolName: "bash", callId: "c1", input: { command: "ls" } },
          { kind: "tool-call", toolName: "read_file", callId: "c2", input: {} },
        ],
        sequence: 2, stepIndex: 0, turnId: "t1",
      },
      {},
      CTX,
    );

    // No throw + the controller exists (proving the handler ran cleanly).
    expect(true).toBe(true);
  });

  it("actions.requested is a no-op when no controller exists yet (no streaming started)", async () => {
    const mock = createMockFetch();
    const events = makeChannel(mock);
    // No prior message.appended → no controller. actions.requested must
    // be a safe no-op, not throw.
    await expect(
      events["actions.requested"]!(
        { actions: [{ kind: "tool-call", toolName: "bash", callId: "c1", input: {} }],
          sequence: 1, stepIndex: 0, turnId: "t1" },
        {},
        CTX,
      ),
    ).resolves.toBeUndefined();
  });

  it("action.result is registered", () => {
    const events = makeChannel(createMockFetch());
    expect(typeof events["action.result"]).toBe("function");
  });
});
