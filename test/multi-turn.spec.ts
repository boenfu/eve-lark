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

  it("creates SEPARATE cards for each top-level message (not all on card 1)", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/tenant_access_token/internal"),
        () => ({ status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 } }),
        { description: "token" },
      );
      let nextId = 1;
      const sendCardCalls: string[] = [];
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/im/v1/messages"),
        () => {
          const mid = `om_msg_${nextId++}`;
          sendCardCalls.push(mid);
          return { status: 200, body: { code: 0, data: { message_id: mid } } };
        },
        { description: "sendCard" },
      );
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
          id: "wrun_same",
          auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in", chatType: "p2p" } } },
        },
      };

      // Simulate webhook handler marking the session for a fresh card,
      // then driving the turn events. The webhook handler itself isn't
      // invoked here (it needs a full HTTP request + parseInbound + send);
      // instead we directly set the flag by calling the route handler.
      // For this test we rely on turn.started consuming the expectFreshCard
      // flag that the webhook handler would have set. Since we're driving
      // events directly, we manually add the session id to the internal
      // flag set by calling the webhook handler.
      //
      // Actually: we CAN test this purely via events. The key insight is:
      // without expectFreshCard, turn.started keeps the card (resetForNewTurn).
      // With expectFreshCard, turn.started clears it (resetForNewMessage).
      //
      // Message 1: no controller exists → message.appended creates one → card #1
      testEvents["message.appended"]!(
        { messageDelta: "reply 1", sequence: 1, stepIndex: 0, turnId: "t1" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!(
        { message: "reply 1", sequence: 2, stepIndex: 0, turnId: "t1" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // Message 2: the webhook handler WOULD set expectFreshCard, but since
      // we're driving events directly we simulate the flag's effect:
      // turn.started with a fresh-card reset, then streaming.
      //
      // Without the fix, turn.started would call resetForNewTurn (keeps card)
      // and message.appended would patch card #1. With the fix, the webhook
      // handler sets expectFreshCard → turn.started calls resetForNewMessage
      // → messageId cleared → message.appended triggers sendCard #2.
      //
      // We can't access expectFreshCard directly (it's closure-private), so
      // we test the observable: the controller's messageId should have been
      // cleared, causing a NEW sendCard. We simulate this by checking that
      // after a "fresh-card" turn.started (which we trigger by calling the
      // webhook handler for a second message), we get a second sendCard.

      // Drive the webhook handler for message 2 to set expectFreshCard:
      const route = channel.routes[0] as unknown as {
        handler: (req: Request, args: unknown) => Promise<Response>;
      };
      const args = {
        async send(_payload: unknown, opts: unknown) {
          return { id: "wrun_same", continuationToken: (opts as { continuationToken: string }).continuationToken };
        },
        getSession: () => ({ id: "wrun_same" }),
        receive: async () => undefined,
        params: {},
        waitUntil: () => {},
        requestIp: null,
      };
      const msg2Body = Buffer.from(JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt_2",
          event_type: "im.message.receive_v1",
          token: "tok",
          app_id: "cli_test",
          create_time: "1",
        },
        event: {
          message: { message_id: "om_in_2", chat_id: "oc_chat1", message_type: "text", content: JSON.stringify({ text: "second" }) },
          sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
          chat_type: "p2p",
        },
      }));
      const res = await route.handler(new Request("http://localhost/lark/webhook", {
        method: "POST",
        body: msg2Body,
      }), args);
      expect(res.status).toBe(200);

      // Now drive turn.started → should trigger resetForNewMessage (flag was set by webhook).
      testEvents["turn.started"]!({}, {}, sessionCtx);
      testEvents["message.appended"]!(
        { messageDelta: "reply 2", sequence: 1, stepIndex: 0, turnId: "t2" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!(
        { message: "reply 2", sequence: 2, stepIndex: 0, turnId: "t2" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // EXPECT: TWO sendCard calls (one per message), with DIFFERENT ids.
      expect(sendCardCalls.length).toBeGreaterThanOrEqual(2);
      expect(sendCardCalls[0]).not.toBe(sendCardCalls[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
