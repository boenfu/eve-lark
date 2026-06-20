import { describe, expect, it, vi } from "vitest";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test", appSecret: "secret_test", verificationToken: "tok",
    encryptKey: undefined, baseUrl: "https://open.feishu.test", botOpenId: undefined,
    webhookPath: "/lark/webhook", replyMode: "streaming",
    streamPatchIntervalMs: 5, streamCreateThresholdMs: 5,
    dedupTtlMs: 30 * 60 * 1000, dedupMaxEntries: 5000,
    requestTimeoutMs: 5000, maxRetries: 2, tokenRefreshBufferMs: 60_000,
    signatureSkewMs: 300_000, fetch: globalThis.fetch, ackReaction: false,
    mode: "webhook", port: 2000, allowFrom: undefined, groupAllowFrom: undefined,
    groupConfigs: undefined, asrProvider: undefined, ...overrides,
  } as ResolvedLarkOptions;
}

describe("double-reply regression", () => {
  it("one turn with multiple message.completed (same turnId) delivers only 1 card", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/tenant_access_token/internal"),
        () => ({ status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 } }),
        { description: "token" });

      // sendCard (POST /messages, non-reply)
      const sendCardCalls: string[] = [];
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/im/v1/messages") && !u.pathname.endsWith("/reply"),
        () => { sendCardCalls.push("send"); return { status: 200, body: { code: 0, data: { message_id: `om_c_${sendCardCalls.length}` } } }; },
        { description: "send" });

      // reply API (POST /messages/{id}/reply)
      const replyCalls: string[] = [];
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/reply"),
        (req: { url: { pathname: string } }) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)\/reply/);
          replyCalls.push(m?.[1] ?? "?");
          return { status: 200, body: { code: 0, data: { message_id: `om_r_${replyCalls.length}` } } };
        },
        { description: "reply" });

      mock.on("PATCH", (u: { pathname: string }) => u.pathname.includes("/im/v1/messages/"),
        () => ({ status: 200, body: { code: 0 } }),
        { description: "patch" });

      const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
      const testEvents = (channel as unknown as { __testEvents: Record<string, (d: unknown, c: unknown, x: unknown) => unknown> }).__testEvents;

      const sessionCtx = { session: { id: "wrun_d", auth: { initiator: { attributes: { chatId: "oc_d", messageId: "om_in", chatType: "p2p" } } } } };

      // One turn: start + delta + 2 message.completed (same turnId, simulating eve segmented output)
      testEvents["turn.started"]!({}, {}, sessionCtx);
      testEvents["message.appended"]!({ messageDelta: "r", sequence: 1, stepIndex: 0, turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!({ message: "reply part 1", sequence: 2, stepIndex: 0, turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!({ message: "reply part 2", sequence: 3, stepIndex: 0, turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);

      // Assert: the whole turn only delivers 1 card (sendCard + reply total = 1).
      // The 2nd message.completed must not create a new card.
      const totalCards = sendCardCalls.length + replyCalls.length;
      expect(totalCards).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
