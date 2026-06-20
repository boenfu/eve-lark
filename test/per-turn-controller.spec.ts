import { describe, expect, it, vi } from "vitest";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

function baseOptions(o: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test", appSecret: "secret_test", verificationToken: "tok",
    encryptKey: undefined, baseUrl: "https://open.feishu.test", botOpenId: undefined,
    webhookPath: "/lark/webhook", replyMode: "streaming",
    streamPatchIntervalMs: 5, streamCreateThresholdMs: 1000,
    dedupTtlMs: 30 * 60 * 1000, dedupMaxEntries: 5000,
    requestTimeoutMs: 5000, maxRetries: 2, tokenRefreshBufferMs: 60_000,
    signatureSkewMs: 300_000, fetch: globalThis.fetch, ackReaction: false,
    eventMaxAgeMs: 10 * 60 * 1000, askInputTtlMs: 5 * 60 * 1000,
    mode: "webhook", port: 2000, allowFrom: undefined, groupAllowFrom: undefined,
    groupConfigs: undefined, asrProvider: undefined, ...o,
  } as ResolvedLarkOptions;
}

function msgBody(evtId: string, msgId: string, text: string): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "2.0",
    header: { event_id: evtId, event_type: "im.message.receive_v1", token: "tok", app_id: "cli_test", create_time: String(Math.floor(Date.now() / 1000)) },
    event: {
      message: { message_id: msgId, chat_id: "oc_pt", message_type: "text", content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: "ou_u" }, sender_type: "user" },
      chat_type: "p2p",
    },
  }));
}

describe("per-turn controller", () => {
  it("interleaved turns keep their own reply rootId (not overwritten by later turn)", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/tenant_access_token/internal"),
        () => ({ status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 } }), { description: "token" });
      const replyRoots: string[] = [];
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/reply"),
        (req: { url: { pathname: string } }) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)\/reply/);
          replyRoots.push(m?.[1] ?? "?");
          return { status: 200, body: { code: 0, data: { message_id: `om_r_${replyRoots.length}` } } };
        }, { description: "reply" });
      mock.on("POST", (u: { pathname: string }) => u.pathname.endsWith("/im/v1/messages") && !u.pathname.endsWith("/reply"),
        () => ({ status: 200, body: { code: 0, data: { message_id: "om_c" } } }), { description: "send" });
      mock.on("PATCH", (u: { pathname: string }) => u.pathname.includes("/im/v1/messages/"),
        () => ({ status: 200, body: { code: 0 } }), { description: "patch" });

      // streamCreateThresholdMs=1000 (long), simulating a short turn: delta arrives but
      // message.completed lands within 1000ms → finalize takes the sendCard path
      // (one-shot), not doCreate.
      const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
      const testEvents = (channel as unknown as { __testEvents: Record<string, (d: unknown, c: unknown, x: unknown) => unknown> }).__testEvents;
      const route = (channel.routes[0] as unknown as { handler: (req: Request, args: unknown) => Promise<Response> }).handler;

      const sessionCtx = { session: { id: "wrun_pt", auth: { initiator: { attributes: { chatId: "oc_pt", messageId: "om1", chatType: "p2p" } } } } };
      const args = {
        async send(_p: unknown, opts: { continuationToken: string }) { return { id: "wrun_pt", continuationToken: opts.continuationToken }; },
        getSession: () => ({ id: "wrun_pt" }), receive: async () => undefined, params: {}, waitUntil: () => {}, requestIp: null,
      };

      // 2 messages (interleaved): lastChatMessage = om2
      await route(new Request("http://x/lark/webhook", { method: "POST", body: msgBody("e1", "om1", "msg1") }), args);
      await route(new Request("http://x/lark/webhook", { method: "POST", body: msgBody("e2", "om2", "msg2") }), args);

      // t1 delta (source om1, prev om2 → replyTarget om1)
      testEvents["turn.started"]!({ turnId: "t1" }, {}, sessionCtx);
      testEvents["message.appended"]!({ messageDelta: "r1", turnId: "t1" }, {}, sessionCtx);
      // t2 delta interleaved (overwrites controller's deps.rootId)
      testEvents["turn.started"]!({ turnId: "t2" }, {}, sessionCtx);
      testEvents["message.appended"]!({ messageDelta: "r2", turnId: "t2" }, {}, sessionCtx);
      // t1 complete (finalize sendCard, short turn — createThreshold 1000ms not reached)
      testEvents["message.completed"]!({ message: "reply 1", turnId: "t1" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);
      // t2 complete
      testEvents["message.completed"]!({ message: "reply 2", turnId: "t2" }, {}, sessionCtx);
      await vi.advanceTimersByTimeAsync(10);

      // Assert: t1 reply rootId = om1 (not overwritten by t2), t2 reply rootId = om2
      expect(replyRoots[0]).toBe("om1");
      expect(replyRoots[1]).toBe("om2");
    } finally {
      vi.useRealTimers();
    }
  });
});
