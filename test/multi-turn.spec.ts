import { describe, expect, it, vi } from "vitest";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

/**
 * Regression test for the streaming-v2 "3 cards for 1 conversation" bug:
 *   - User sends one message
 *   - eve fires message.completed (turn 1 reply)
 *   - eve fires input.requested (HITL ask)
 *   - User clicks, eve resumes
 *   - eve fires turn.started + message.completed (turn 2 reply)
 *
 * Pre-fix: each terminal event dropped the controller, so turn 2 created a
 * NEW card. User saw 3 separate cards (2 streaming + 1 ask).
 * Post-fix: controller stays across turns. Turn 2 patches the SAME card.
 */
function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test",
    appSecret: "secret_test",
    verificationToken: "tok",
    encryptKey: undefined,
    baseUrl: "https://open.feishu.test",
    botOpenId: undefined,
    webhookPath: "/lark/webhook",
    replyMode: "streaming",
    streamPatchIntervalMs: 5,
    streamCreateThresholdMs: 5,
    dedupTtlMs: 30 * 60 * 1000,
    dedupMaxEntries: 5000,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    tokenRefreshBufferMs: 60_000,
    signatureSkewMs: 300_000,
    fetch: globalThis.fetch,
    ackReaction: false,
    mode: "webhook",
    port: 2000,
    allowFrom: undefined,
    groupAllowFrom: undefined,
    groupConfigs: undefined,
    asrProvider: undefined,
    ...overrides,
  } as ResolvedLarkOptions;
}

describe("multi-turn regression: one session, one card", () => {
  it("patches the SAME card across multiple message.completed events", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      // Token
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/tenant_access_token/internal"),
        () => ({ status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 } }),
        { description: "token" },
      );
      // First sendCard creates the streaming card (messageId om_card_1)
      let nextMessageId = "om_card_1";
      const sendCardCalls: Array<{ messageId: string }> = [];
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/im/v1/messages"),
        () => {
          const mid = nextMessageId;
          sendCardCalls.push({ messageId: mid });
          // Subsequent sendCards get fresh ids; we want only ONE sendCard.
          nextMessageId = `om_card_${sendCardCalls.length + 1}`;
          return { status: 200, body: { code: 0, data: { message_id: mid } } };
        },
        { description: "sendCard" },
      );
      // patchCard updates the existing card
      const patchCalls: string[] = [];
      mock.on(
        "PATCH",
        (u) => u.pathname.includes("/im/v1/messages/"),
        (req) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)/);
          patchCalls.push(m?.[1] ?? "?");
          return { status: 200, body: { code: 0 } };
        },
        { description: "patchCard" },
      );

      const channel = createLarkChannel(
        baseOptions({ fetch: mock.fetch as unknown as typeof fetch }),
      );
      const testEvents = (channel as unknown as {
        __testEvents: Record<string, (data: unknown, ch: unknown, ctx: unknown) => Promise<unknown> | void>;
      }).__testEvents;

      const sessionCtx = {
        session: {
          id: "wrun_same_session",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                messageId: "om_in_1",
                chatType: "p2p",
              },
            },
          },
        },
      };

      // Turn 1: model streams some text, then completes.
      testEvents["message.appended"]!(
        { messageDelta: "I'll check", sequence: 1, stepIndex: 0, turnId: "t1" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!(
        { message: "I'll check the weather.", sequence: 2, stepIndex: 0, turnId: "t1" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // HITL: input.requested. Should patch the existing card with ask UI
      // (NOT sendCard a new ask-card).
      testEvents["input.requested"]!(
        {
          requests: [
            {
              requestId: "req_42",
              prompt: "Which city?",
              options: [{ id: "beijing", label: "Beijing" }],
              action: { kind: "tool-call", toolName: "ask_question", callId: "c", input: {} },
            },
          ],
        },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // User clicks. (We don't drive handleCardAction here — just resume.)

      // Turn 2: eve resumes, fires turn.started (controller resets) then
      // message.appended + message.completed. Should patch the SAME card.
      testEvents["turn.started"]!({}, {}, sessionCtx);
      testEvents["message.appended"]!(
        { messageDelta: "Beijing is", sequence: 1, stepIndex: 0, turnId: "t2" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!(
        { message: "Beijing is sunny, 25°C.", sequence: 2, stepIndex: 0, turnId: "t2" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // EXPECT: exactly ONE sendCard (the initial streaming card creation).
      // All subsequent updates must be patches on that same card.
      expect(sendCardCalls).toHaveLength(1);
      expect(sendCardCalls[0]!.messageId).toBe("om_card_1");
      // And every patch targeted that same card id.
      expect(patchCalls.length).toBeGreaterThan(0);
      for (const id of patchCalls) {
        expect(id).toBe("om_card_1");
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
