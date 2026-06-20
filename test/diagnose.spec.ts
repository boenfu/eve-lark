import { describe, expect, it } from "vitest";
import { createMockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: "cli_test", appSecret: "secret_test", verificationToken: "tok",
    encryptKey: undefined, baseUrl: BASE, botOpenId: undefined,
    webhookPath: "/lark/webhook", replyMode: "post",
    streamPatchIntervalMs: 1000, streamCreateThresholdMs: 400,
    dedupTtlMs: 30 * 60 * 1000, dedupMaxEntries: 5000,
    requestTimeoutMs: 5000, maxRetries: 2,
    tokenRefreshBufferMs: 60_000, signatureSkewMs: 300_000,
    eventMaxAgeMs: 10 * 60 * 1000, askInputTtlMs: 5 * 60 * 1000,
    fetch: globalThis.fetch, ackReaction: false, mode: "webhook", port: 2000,
    allowFrom: undefined, groupAllowFrom: undefined, groupConfigs: undefined, asrProvider: undefined,
    ...overrides,
  };
}

function textEvent(text: string, senderOpenId = "ou_user"): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "2.0",
    header: {
      event_id: `evt_${Math.random().toString(36).slice(2, 8)}`,
      event_type: "im.message.receive_v1",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: "tok", app_id: "cli_test",
    },
    event: {
      message: { message_id: "om_diag", chat_id: "oc_chat1", message_type: "text",
        content: JSON.stringify({ text }) },
      sender: { sender_id: { open_id: senderOpenId }, sender_type: "user" },
      chat_type: "p2p",
    },
  }));
}

interface CapturedSession { message: unknown; opts: unknown }

async function invoke(channel: ReturnType<typeof createLarkChannel>, body: Buffer): Promise<{
  status: number; body: string; captured: CapturedSession;
}> {
  const captured: CapturedSession = { message: null, opts: null };
  const waits: Promise<unknown>[] = [];
  const route = channel.routes[0] as unknown as {
    handler: (req: Request, args: unknown) => Promise<Response>;
  };
  const args = {
    async send(message: unknown, opts: unknown) {
      captured.message = message; captured.opts = opts;
      return { id: "sess_1", continuationToken: "oc_chat1:_" };
    },
    getSession: () => ({ id: "sess_1" }),
    receive: async () => undefined, params: {},
    waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => {})); },
    requestIp: null,
  };
  const req = new Request(`${BASE}/lark/webhook`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  const res = await route.handler(req, args);
  await Promise.all(waits); // wait for background work (diagnostics)
  return { status: res.status, body: await res.text(), captured };
}

describe("/lark-diagnose command", () => {
  it("intercepts '/lark-diagnose' and does NOT forward to the agent", async () => {
    const mock = createMockFetch();
    mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
      status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
    }));
    mock.on("POST", "/open-apis/im/v1/messages", () => ({
      status: 200, body: { code: 0, data: { message_id: "om_reply" } },
    }));
    const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
    const { captured } = await invoke(channel, textEvent("/lark-diagnose"));
    // Agent should NOT have been called (no helpers.send()).
    expect(captured.message).toBeNull();
  });

  it("replies with a diagnostic report in the same chat", async () => {
    const mock = createMockFetch();
    mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
      status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
    }));
    const sentBodies: string[] = [];
    mock.on("POST", "/open-apis/im/v1/messages", (req) => {
      const body = req.body as { content?: string };
      if (body.content) sentBodies.push(body.content);
      return { status: 200, body: { code: 0, data: { message_id: "om_reply" } } };
    });
    const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
    await invoke(channel, textEvent("/lark-diagnose"));
    // At least one message was sent to the user (the diagnostic report).
    expect(sentBodies.length).toBeGreaterThanOrEqual(1);
    // Report should mention "appId" or "config" or "token" — it's a
    // diagnostic, not an empty ack.
    const report = sentBodies.join(" ");
    expect(report).toMatch(/app|token|config|connect|ok/i);
  });

  it("normal messages are NOT intercepted (forwarded to agent normally)", async () => {
    const mock = createMockFetch();
    mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
      status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
    }));
    const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
    const { captured } = await invoke(channel, textEvent("hello there"));
    expect(captured.message).not.toBeNull();
  });
});

describe("/lark command suite", () => {
  async function invokeCommand(text: string): Promise<{ captured: CapturedSession; sentText: string }> {
    const mock = createMockFetch();
    mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
      status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
    }));
    const sentBodies: string[] = [];
    mock.on("POST", "/open-apis/im/v1/messages", (req) => {
      const body = req.body as { content?: string };
      if (body.content) sentBodies.push(body.content);
      return { status: 200, body: { code: 0, data: { message_id: "om_reply" } } };
    });
    const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
    const { captured } = await invoke(channel, textEvent(text));
    return { captured, sentText: sentBodies.join("\n") };
  }

  it("intercepts '/lark help' with command help", async () => {
    const { captured, sentText } = await invokeCommand("/lark help");
    expect(captured.message).toBeNull();
    expect(sentText).toContain("/lark doctor");
    expect(sentText).toContain("/lark auth");
  });

  it("intercepts '/lark start' with onboarding guidance", async () => {
    const { captured, sentText } = await invokeCommand("/lark start");
    expect(captured.message).toBeNull();
    expect(sentText).toContain("eve-lark");
    expect(sentText).toContain("/lark help");
  });

  it("intercepts '/lark auth' with channel-scoped auth guidance", async () => {
    const { captured, sentText } = await invokeCommand("/lark auth");
    expect(captured.message).toBeNull();
    expect(sentText).toContain("user_access_token");
  });

  it("intercepts '/lark trace <message_id>'", async () => {
    const { captured, sentText } = await invokeCommand("/lark trace om_123");
    expect(captured.message).toBeNull();
    expect(sentText).toContain("om_123");
  });

  it("intercepts '/lark doctor' with token and channel checks", async () => {
    const { captured, sentText } = await invokeCommand("/lark doctor");
    expect(captured.message).toBeNull();
    expect(sentText).toContain("doctor");
    expect(sentText).toContain("tenant_access_token");
    expect(sentText).toContain("eventMaxAgeMs");
    expect(sentText).toContain("im.message.receive_v1");
    expect(sentText).toContain("card.action.trigger");
    expect(sentText).toContain("im:resource");
    expect(sentText).toContain("CardKit");
  });
});
