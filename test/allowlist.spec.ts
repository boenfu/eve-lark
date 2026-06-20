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
  mentions?: Array<Record<string, unknown>>;
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
        ...(opts.mentions ? { mentions: opts.mentions } : {}),
      },
      sender: {
        sender_id: { open_id: opts.senderOpenId ?? "ou_alice" },
        sender_type: "user",
      },
      chat_type: opts.chatType ?? "p2p",
    },
  }));
}

function botMention(botOpenId = "ou_bot"): Record<string, unknown> {
  return {
    key: "@_user_1",
    id: { open_id: botOpenId },
    name: "Test Bot",
    id_type: "open_id",
  };
}

function allMention(): Record<string, unknown> {
  return {
    key: "@_user_1",
    id: { open_id: "all" },
    name: "所有人",
    id_type: "open_id",
  };
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

function sentText(message: unknown): string | undefined {
  if (!Array.isArray(message)) return undefined;
  const first = message[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
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

describe("group mention policy", () => {
  let captured: { message: unknown };
  beforeEach(() => { captured = { message: null }; });

  it("drops group messages without a bot mention when requireMention is enabled", async () => {
    const channel = createLarkChannel(baseOptions({
      botOpenId: "ou_bot",
      groupConfigs: [{ chatId: "oc_chat1", requireMention: true }],
    } as Partial<ResolvedLarkOptions>));
    const res = await invoke(channel, textEvent({ chatType: "group", text: "hello" }), makeArgs(captured));
    expect(res.status).toBe(200);
    expect(captured.message).toBeNull();
  });

  it("allows and strips group messages with a bot mention when requireMention is enabled", async () => {
    const channel = createLarkChannel(baseOptions({
      botOpenId: "ou_bot",
      groupConfigs: [{ chatId: "oc_chat1", requireMention: true }],
    } as Partial<ResolvedLarkOptions>));
    const res = await invoke(
      channel,
      textEvent({
        chatType: "group",
        text: "@_user_1 hello",
        mentions: [botMention()],
      }),
      makeArgs(captured),
    );
    expect(res.status).toBe(200);
    expect(sentText(captured.message)).toBe("hello");
  });

  it("does not treat @all as a mention trigger unless respondToMentionAll is enabled", async () => {
    const channel = createLarkChannel(baseOptions({
      botOpenId: "ou_bot",
      groupConfigs: [{ chatId: "oc_chat1", requireMention: true }],
    } as Partial<ResolvedLarkOptions>));
    await invoke(
      channel,
      textEvent({
        chatType: "group",
        text: "@_user_1 please check",
        mentions: [allMention()],
      }),
      makeArgs(captured),
    );
    expect(captured.message).toBeNull();

    const allowAllChannel = createLarkChannel(baseOptions({
      botOpenId: "ou_bot",
      groupConfigs: [{ chatId: "oc_chat1", requireMention: true, respondToMentionAll: true }],
    } as Partial<ResolvedLarkOptions>));
    await invoke(
      allowAllChannel,
      textEvent({
        chatType: "group",
        text: "@_user_1 please check",
        mentions: [allMention()],
        eventId: "evt_all_allowed",
      }),
      makeArgs(captured),
    );
    expect(sentText(captured.message)).toBe("@all please check");
  });

  it("applies per-group sender allowlists after the chat allowlist passes", async () => {
    const channel = createLarkChannel(baseOptions({
      groupAllowFrom: ["oc_chat1"],
      groupConfigs: [{ chatId: "oc_chat1", allowFrom: ["ou_allowed"] }],
    } as Partial<ResolvedLarkOptions>));

    await invoke(
      channel,
      textEvent({ chatType: "group", senderOpenId: "ou_denied" }),
      makeArgs(captured),
    );
    expect(captured.message).toBeNull();

    await invoke(
      channel,
      textEvent({ chatType: "group", senderOpenId: "ou_allowed", eventId: "evt_allowed_group_sender" }),
      makeArgs(captured),
    );
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
