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

function msgBody(evtId: string, msgId: string, text: string): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "2.0",
    header: { event_id: evtId, event_type: "im.message.receive_v1", token: "tok", app_id: "cli_test", create_time: "1" },
    event: {
      message: { message_id: msgId, chat_id: "oc_q", message_type: "text", content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: "ou_u" }, sender_type: "user" },
      chat_type: "p2p",
    },
  }));
}

describe("quote-reply", () => {
  it("interleaved: both replies quote their own source via reply API", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/tenant_access_token/internal"),
        () => ({ status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 } }),
        { description: "token" });

      // reply API (POST /messages/{id}/reply)
      const replyCalls: string[] = [];
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/reply"),
        (req: { url: { pathname: string } }) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)\/reply/);
          replyCalls.push(m?.[1] ?? "?");
          return { status: 200, body: { code: 0, data: { message_id: `om_reply_${replyCalls.length}` } } };
        },
        { description: "reply" });

      // sendMessage (POST /messages, non-reply)
      const sendCalls: string[] = [];
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/im/v1/messages") && !u.pathname.endsWith("/reply"),
        () => { sendCalls.push("send"); return { status: 200, body: { code: 0, data: { message_id: `om_send_${sendCalls.length}` } } }; },
        { description: "send" });

      mock.on("PATCH", (u: { pathname: string }) => u.pathname.includes("/im/v1/messages/"),
        () => ({ status: 200, body: { code: 0 } }),
        { description: "patch" });

      const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
      const testEvents = (channel as unknown as { __testEvents: Record<string, (d: unknown, c: unknown, x: unknown) => unknown> }).__testEvents;
      const route = (channel.routes[0] as unknown as { handler: (req: Request, args: unknown) => Promise<Response> }).handler;

      const sessionCtx = { session: { id: "wrun_q", auth: { initiator: { attributes: { chatId: "oc_q", messageId: "om_in_1", chatType: "p2p" } } } } };
      const args = {
        async send(_p: unknown, opts: { continuationToken: string }) { return { id: "wrun_q", continuationToken: opts.continuationToken }; },
        getSession: () => ({ id: "wrun_q" }), receive: async () => undefined, params: {}, waitUntil: () => {}, requestIp: null,
      };

      // Two user messages (interleaved): lastChatMessage ends up = om_in_2
      await route(new Request("http://x/lark/webhook", { method: "POST", body: msgBody("e1", "om_in_1", "first") }), args);
      await route(new Request("http://x/lark/webhook", { method: "POST", body: msgBody("e2", "om_in_2", "second") }), args);

      // Reply 1: source om_in_1, prev om_in_2 (interleaved) → reply om_in_1
      testEvents["turn.started"]!({ turnId: "t1" }, {}, sessionCtx);
      testEvents["message.appended"]!({ messageDelta: "r1", sequence: 1, stepIndex: 0, turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!({ message: "reply 1", sequence: 2, stepIndex: 0, turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);

      // Reply 2: source om_in_2 (after queue head shift), prev om_reply_1 → reply om_in_2
      testEvents["turn.started"]!({ turnId: "t2" }, {}, sessionCtx);
      testEvents["message.appended"]!({ messageDelta: "r2", sequence: 1, stepIndex: 0, turnId: "t2" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);
      testEvents["message.completed"]!({ message: "reply 2", sequence: 2, stepIndex: 0, turnId: "t2" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);

      expect(replyCalls).toContain("om_in_1");
      expect(replyCalls).toContain("om_in_2");
    } finally {
      vi.useRealTimers();
    }
  });
});
