import { describe, expect, it, vi } from "vitest";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

/**
 * Per-turn controller behavior across an HITL flow.
 *
 *   - User sends one message (turn 1).
 *   - eve fires message.appended + message.completed (turn 1 streams + finalizes).
 *   - eve fires input.requested (HITL ask) — still in turn 1.
 *   - User clicks, eve resumes as turn 2.
 *   - eve fires turn.started + message.appended + message.completed (turn 2).
 *
 * With per-turn controllers (keyed by eve turnId):
 *   - Turn 1 owns its own controller → streams onto om_card_1.
 *   - input.requested (turn 1) finds turn 1's controller still alive and
 *     patches the SAME card with the ask UI inline (no separate ask-card).
 *   - Turn 2 is a fresh controller (different turnId) → streams onto a NEW
 *     card (om_card_2).
 *
 * This is the intended per-turn behavior: each turn gets its own card, and
 * HITL's inline ask stays on the originating turn's card. The previous
 * "shared controller, 1 card for the whole flow" design is gone — interleaved
 * turns in conversation mode no longer overwrite each other's reply rootId or
 * share completed state.
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

describe("multi-turn per-turn controller", () => {
  // (Tests below exercise the per-turn controller behavior: each eve turnId
  // owns its own StreamingCardController, so interleaved/sequential turns in
  // conversation mode no longer overwrite each other's reply rootId or
  // share completed state.)
  it("turn 1 owns its card; HITL inline-asks patch it; turn 2 (resume) gets a fresh card", async () => {
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
      // Each sendCard returns a fresh id in order: om_card_1, om_card_2, ...
      let nextMessageId = "om_card_1";
      const sendCardCalls: Array<{ messageId: string }> = [];
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/im/v1/messages"),
        () => {
          const mid = nextMessageId;
          sendCardCalls.push({ messageId: mid });
          nextMessageId = `om_card_${sendCardCalls.length + 1}`;
          return { status: 200, body: { code: 0, data: { message_id: mid } } };
        },
        { description: "sendCard" },
      );
      // patchCard updates the existing card; record the targeted id.
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

      // Turn 1: model streams some text, then completes (creates om_card_1).
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

      // HITL: input.requested in turn 1. Should patch turn 1's card inline
      // (NOT sendCard a new ask-card) because turn 1's controller still
      // exists with a messageId.
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
          sequence: 3, stepIndex: 0, turnId: "t1",
        },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(10);

      // User clicks. (We don't drive handleCardAction here — just resume.)

      // Turn 2: eve resumes. turn.started is a no-op for controllers (each
      // turn gets its own). message.appended creates a FRESH controller for
      // t2 → sendCard → om_card_2. message.completed patches om_card_2.
      testEvents["turn.started"]!({ turnId: "t2" }, {}, sessionCtx);
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

      // EXPECT: TWO sendCards — one per turn. input.requested did NOT add a
      // third (it patched turn 1's existing card inline).
      expect(sendCardCalls).toHaveLength(2);
      expect(sendCardCalls[0]!.messageId).toBe("om_card_1");
      expect(sendCardCalls[1]!.messageId).toBe("om_card_2");
      // Every patch targeted one of the two turn cards (no stray ids).
      expect(patchCalls.length).toBeGreaterThan(0);
      for (const id of patchCalls) {
        expect(id === "om_card_1" || id === "om_card_2").toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates SEPARATE cards for each top-level message (per-turn controllers, no shared card)", async () => {
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
      // Track BOTH card-creation paths:
      //   - POST /im/v1/messages         (sendCard, no reply target)
      //   - POST /im/v1/messages/{id}/reply (sendCard when a reply target is set)
      // Each turn quotes its source inbound, so streaming sendCards land on
      // the reply API. We want to assert that each turn creates exactly ONE
      // card regardless of which path it took.
      const cardCreateCalls: string[] = [];
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/im/v1/messages"),
        () => {
          const mid = `om_msg_${nextId++}`;
          cardCreateCalls.push(mid);
          return { status: 200, body: { code: 0, data: { message_id: mid } } };
        },
        { description: "sendCard" },
      );
      mock.on(
        "POST",
        (u) => u.pathname.endsWith("/reply"),
        (req) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)\/reply/);
          const replyTo = m?.[1] ?? "?";
          const mid = `om_reply_${nextId++}`;
          cardCreateCalls.push(mid);
          void replyTo;
          return { status: 200, body: { code: 0, data: { message_id: mid } } };
        },
        { description: "reply" },
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

      // Message 1: webhook enqueues om_in_1, then turn 1 streams → card #1.
      // (We don't drive the full webhook here — we just enqueue the inbound
      // id so turn.started can map turnId → source. In production the webhook
      // handler does this; in this direct-drive test we mirror its effect by
      // calling the route handler.)
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
      const msg1Body = Buffer.from(JSON.stringify({
        schema: "2.0",
        header: { event_id: "evt_1", event_type: "im.message.receive_v1", token: "tok", app_id: "cli_test", create_time: "1" },
        event: {
          message: { message_id: "om_in_1", chat_id: "oc_chat1", message_type: "text", content: JSON.stringify({ text: "first" }) },
          sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
          chat_type: "p2p",
        },
      }));
      let res = await route.handler(new Request("http://localhost/lark/webhook", {
        method: "POST",
        body: msg1Body,
      }), args);
      expect(res.status).toBe(200);

      testEvents["turn.started"]!({ turnId: "t1" }, {}, sessionCtx);
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

      // Message 2: webhook enqueues om_in_2, then turn 2 streams → card #2.
      // Per-turn controllers mean turn 2 gets its OWN controller (keyed by
      // turnId) — message.appended creates a fresh card instead of patching
      // turn 1's card. The webhook no longer needs to set any "expect fresh
      // card" flag; the turnId difference is what isolates the cards.
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
      res = await route.handler(new Request("http://localhost/lark/webhook", {
        method: "POST",
        body: msg2Body,
      }), args);
      expect(res.status).toBe(200);

      testEvents["turn.started"]!({ turnId: "t2" }, {}, sessionCtx);
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

      // EXPECT: TWO card-creation calls (one per turn), with DIFFERENT ids.
      expect(cardCreateCalls.length).toBeGreaterThanOrEqual(2);
      expect(cardCreateCalls[0]).not.toBe(cardCreateCalls[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
