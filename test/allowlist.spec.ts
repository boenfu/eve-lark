import { beforeEach, describe, expect, it } from "vitest";
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

function textEvent(opts: {
  chatId?: string;
  chatType?: string;
  senderOpenId?: string;
  eventId?: string;
  text?: string;
} = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? `evt_${Math.random().toString(36).slice(2, 8)}`,
      event_type: "im.message.receive_v1",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: "tok",
      app_id: "cli_test",
    },
    event: {
      message: {
        message_id: "om_1",
        chat_id: opts.chatId ?? "oc_chat1",
        message_type: "text",
        content: JSON.stringify({ text: opts.text ?? "hello" }),
      },
      sender: {
        sender_id: { open_id: opts.senderOpenId ?? "ou_alice" },
        sender_type: "user",
      },
      chat_type: opts.chatType ?? "p2p",
    },
  }));
}

interface RouteHandlerArgs {
  send: (msg: unknown, opts: unknown) => Promise<{ id: string; continuationToken: string }>;
  getSession: () => unknown;
  receive: () => Promise<unknown>;
  params: Record<string, string>;
  waitUntil: (p: Promise<unknown>) => void;
  requestIp: string | null;
}

function makeArgs(captured: { message: unknown }): RouteHandlerArgs {
  return {
    async send(message) {
      captured.message = message;
      return { id: "sess_1", continuationToken: "oc_chat1:_" };
    },
    getSession: () => ({ id: "sess_1" }),
    receive: async () => undefined,
    params: {},
    waitUntil: () => {},
    requestIp: null,
  };
}

function invoke(channel: ReturnType<typeof createLarkChannel>, body: Buffer, args: RouteHandlerArgs) {
  const route = channel.routes[0] as unknown as {
    handler: (req: Request, args: RouteHandlerArgs) => Promise<Response>;
  };
  const req = new Request(`${BASE}/lark/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return route.handler(req, args);
}

describe("DM allowlist", () => {
  let captured: { message: unknown };
  beforeEach(() => { captured = { message: null }; });

  it("drops DM from a sender not in allowFrom", async () => {
    const channel = createLarkChannel(baseOptions({ allowFrom: ["ou_bob"] } as Partial<ResolvedLarkOptions> & { allowFrom: string[] }));
    const res = await invoke(channel, textEvent({ senderOpenId: "ou_alice", chatType: "p2p" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).toBeNull();
  });

  it("allows DM from a sender in allowFrom", async () => {
    const channel = createLarkChannel(baseOptions({ allowFrom: ["ou_alice"] } as Partial<ResolvedLarkOptions> & { allowFrom: string[] }));
    const res = await invoke(channel, textEvent({ senderOpenId: "ou_alice", chatType: "p2p" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).not.toBeNull();
  });

  it("does not apply allowFrom to group messages (group has its own allowlist)", async () => {
    const channel = createLarkChannel(baseOptions({ allowFrom: ["ou_bob"] } as Partial<ResolvedLarkOptions> & { allowFrom: string[] }));
    const res = await invoke(channel, textEvent({ chatType: "group" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).not.toBeNull();
  });
});

describe("group allowlist", () => {
  let captured: { message: unknown };
  beforeEach(() => { captured = { message: null }; });

  it("drops group message from a chat not in groupAllowFrom", async () => {
    const channel = createLarkChannel(baseOptions({ groupAllowFrom: ["oc_allowed"] } as Partial<ResolvedLarkOptions> & { groupAllowFrom: string[] }));
    const res = await invoke(channel, textEvent({ chatId: "oc_other", chatType: "group" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).toBeNull();
  });

  it("allows group message from a chat in groupAllowFrom", async () => {
    const channel = createLarkChannel(baseOptions({ groupAllowFrom: ["oc_chat1"] } as Partial<ResolvedLarkOptions> & { groupAllowFrom: string[] }));
    const res = await invoke(channel, textEvent({ chatId: "oc_chat1", chatType: "group" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).not.toBeNull();
  });
});

describe("no allowlist configured", () => {
  let captured: { message: unknown };
  beforeEach(() => { captured = { message: null }; });

  it("allows all DMs and group messages by default (backwards compat)", async () => {
    const channel = createLarkChannel(baseOptions());
    const dmRes = await invoke(channel, textEvent({ chatType: "p2p" }), makeArgs(captured));
    expect(dmRes.status).toBe(200);
    expect(captured.message).not.toBeNull();

    captured.message = null;
    const groupRes = await invoke(channel, textEvent({ chatType: "group" }), makeArgs(captured));
    expect(groupRes.status).toBe(200);
    expect(captured.message).not.toBeNull();
  });
});

describe("per-group system prompt", () => {
  let captured: { message: unknown; opts: unknown };
  beforeEach(() => { captured = { message: null, opts: null }; });

  function makeArgsWithOpts(captured: { message: unknown; opts: unknown }): RouteHandlerArgs {
    return {
      async send(message, opts) {
        captured.message = message;
        captured.opts = opts;
        return { id: "sess_1", continuationToken: "oc_chat1:_" };
      },
      getSession: () => ({ id: "sess_1" }),
      receive: async () => undefined,
      params: {},
      waitUntil: () => {},
      requestIp: null,
    };
  }

  it("injects the group's systemPrompt as send() context", async () => {
    const channel = createLarkChannel(baseOptions({
      groupConfigs: [
        { chatId: "oc_special", systemPrompt: "You are the group's assistant. Be brief." },
      ],
    } as Partial<ResolvedLarkOptions> & { groupConfigs: Array<{ chatId: string; systemPrompt: string }> }));
    await invoke(
      channel,
      textEvent({ chatId: "oc_special", chatType: "group" }),
      makeArgsWithOpts(captured),
    );
    expect(captured.opts).toMatchObject({
      context: ["You are the group's assistant. Be brief."],
    });
  });

  it("does not set context for chats not in groupConfigs", async () => {
    const channel = createLarkChannel(baseOptions({
      groupConfigs: [
        { chatId: "oc_special", systemPrompt: "You are the group's assistant." },
      ],
    } as Partial<ResolvedLarkOptions> & { groupConfigs: Array<{ chatId: string; systemPrompt: string }> }));
    await invoke(
      channel,
      textEvent({ chatId: "oc_other", chatType: "group" }),
      makeArgsWithOpts(captured),
    );
    expect((captured.opts as { context?: unknown }).context).toBeUndefined();
  });

  it("does not set context for DMs even if a group config exists for the chatId", async () => {
    // Defensive: same chatId should never appear in both DM and group, but
    // if it does, systemPrompt only applies to the group case.
    const channel = createLarkChannel(baseOptions({
      groupConfigs: [{ chatId: "oc_x", systemPrompt: "secret" }],
    } as Partial<ResolvedLarkOptions> & { groupConfigs: Array<{ chatId: string; systemPrompt: string }> }));
    await invoke(
      channel,
      textEvent({ chatId: "oc_x", chatType: "p2p" }),
      makeArgsWithOpts(captured),
    );
    expect((captured.opts as { context?: unknown }).context).toBeUndefined();
  });
});
