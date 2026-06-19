import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import { ASK_BUTTON_VALUE_MARKER } from "../src/card.js";
import type { ResolvedLarkOptions, LarkInputRequest } from "../src/types.js";

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
    fetch: globalThis.fetch,
    ackReaction: false,
    mode: "webhook",
    port: 2000,
    ...overrides,
  };
}

function registerToken(mock: MockFetch) {
  mock.on(
    "POST",
    "/open-apis/auth/v3/tenant_access_token/internal",
    () => ({ status: 200, body: { code: 0, tenant_access_token: "tat_test", expire: 7200 } }),
    { description: "POST token" },
  );
}

function buildRequest(body: object, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/lark/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function imReceiveEvent(opts: {
  eventId?: string;
  text?: string;
  chatId?: string;
  rootId?: string;
  parentId?: string;
  senderOpenId?: string;
} = {}): object {
  return {
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? "evt_msg_1",
      event_type: "im.message.receive_v1",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: "tok",
      app_id: "cli_test",
      tenant_key: "t",
    },
    event: {
      message: {
        message_id: "om_in_1",
        chat_id: opts.chatId ?? "oc_chat1",
        message_type: "text",
        content: JSON.stringify({ text: opts.text ?? "hi" }),
        ...(opts.rootId !== undefined ? { root_id: opts.rootId } : {}),
        ...(opts.parentId !== undefined ? { parent_id: opts.parentId } : {}),
      },
      sender: { sender_id: { open_id: opts.senderOpenId ?? "ou_user" }, sender_type: "user" },
      chat_type: "p2p",
    },
  };
}

function cardActionTrigger(value: Record<string, unknown>, openMessageId = "om_card_1"): object {
  return {
    schema: "2.0",
    header: {
      event_id: "evt_card_1",
      event_type: "card.action.trigger",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: "tok",
      app_id: "cli_test",
      tenant_key: "t",
    },
    event: {
      open_id: "ou_user",
      open_message_id: openMessageId,
      token: "tok",
      tenant_key: "t",
      action: { value, tag: "button" },
    },
  };
}

interface CapturedSend {
  payload: unknown;
  opts: { continuationToken: string; auth: unknown };
}

function makeChannelWithMockedClient(mock: MockFetch) {
  registerToken(mock);
  // Default handlers for sendCard + patchCard so input.requested and the
  // post-click patch succeed without each test setting them up.
  mock.on(
    "POST",
    "/open-apis/im/v1/messages",
    () => ({ status: 200, body: { code: 0, data: { message_id: "om_card_1" } } }),
    { description: "POST sendCard (default)" },
  );
  mock.on(
    "PATCH",
    (url) => url.pathname.startsWith("/open-apis/im/v1/messages/"),
    () => ({ status: 200, body: { code: 0 } }),
    { description: "PATCH (default)" },
  );
  const sends: CapturedSend[] = [];
  const channel = createLarkChannel(
    baseOptions({ fetch: mock.fetch as unknown as typeof fetch }),
  );
  const route = channel.routes[0] as unknown as {
    handler: (req: Request, args: unknown) => Promise<Response>;
  };
  // Channel events are hidden by eve's defineChannel; we expose them as
  // `__testEvents` for direct testing. Cast to access.
  const testEvents = (channel as unknown as {
    __testEvents: Record<string, (data: unknown, ch: unknown, ctx: unknown) => Promise<unknown> | void>;
  }).__testEvents;
  return {
    channel,
    sends,
    testEvents,
    async invoke(req: Request): Promise<Response> {
      const args = {
        async send(payload: unknown, opts: unknown) {
          sends.push({ payload, opts: opts as { continuationToken: string; auth: unknown } });
          return { id: "sess_test", continuationToken: (opts as { continuationToken: string }).continuationToken };
        },
        getSession: () => ({ id: "sess_test" }),
        receive: async () => undefined,
        params: {},
        waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
        requestIp: null,
      };
      return route.handler(req, args);
    },
  };
}

describe("ask_question end-to-end", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("input.requested event renders a Feishu card and tracks the pending request", async () => {
    const mock = createMockFetch();
    const cardSends: Array<{ chatId: string; cardElements: unknown[] }> = [];
    mock.on(
      "POST",
      "/open-apis/im/v1/messages",
      (req) => {
        const body = req.body as { msg_type: string; content: string; receive_id: string };
        if (body.msg_type === "interactive") {
          const card = JSON.parse(body.content);
          cardSends.push({ chatId: body.receive_id, cardElements: card.elements });
        }
        return { status: 200, body: { code: 0, data: { message_id: "om_card_1" } } };
      },
      { description: "POST sendCard (ask)" },
    );
    const { testEvents } = makeChannelWithMockedClient(mock);
    const events = testEvents;

    // Drive the input.requested event handler directly.
    const request: LarkInputRequest = {
      requestId: "req_1",
      prompt: "Continue?",
      options: [
        { id: "yes", label: "Yes", style: "primary" },
        { id: "no", label: "No", style: "danger" },
      ],
      action: { kind: "tool-call", toolName: "ask_question", callId: "c1", input: {} },
    };
    await events["input.requested"]!(
      { requests: [request], sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      {
        session: {
          id: "sess_test",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                rootMessageId: undefined,
                parentId: undefined,
                messageId: "om_in_1",
              },
            },
          },
        },
      },
    );

    expect(cardSends).toHaveLength(1);
    expect(cardSends[0]!.chatId).toBe("oc_chat1");
    // Action element with 2 buttons should be present.
    const action = (cardSends[0]!.cardElements as Array<{ tag?: string; actions?: unknown[] }>)
      .find((e) => e.tag === "action");
    expect(action).toBeDefined();
    expect(action!.actions).toHaveLength(2);
  });

  it("card.action.trigger with our marker resumes the session via inputResponses", async () => {
    const mock = createMockFetch();
    const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock);
    const events = testEvents;

    // First: drive input.requested so the pending map is populated.
    const request: LarkInputRequest = {
      requestId: "req_42",
      prompt: "Confirm?",
      options: [{ id: "ok", label: "OK" }],
      action: { kind: "tool-call", toolName: "ask_question", callId: "c2", input: {} },
    };
    await events["input.requested"]!(
      { requests: [request], sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      {
        session: {
          id: "sess_test",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                rootMessageId: undefined,
                parentId: undefined,
                messageId: "om_in_1",
              },
            },
          },
        },
      },
    );

    // Card patch expected after click — register a handler so the mock
    // doesn't fall through.
    mock.on(
      "PATCH",
      (url) => url.pathname.startsWith("/open-apis/im/v1/messages/om_card_1"),
      () => ({ status: 200, body: { code: 0 } }),
      { description: "PATCH ask answered" },
    );

    // Now simulate a button click with our marker + requestId + optionId.
    const click = cardActionTrigger({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_42",
      optionId: "ok",
    });
    const res = await invoke(buildRequest(click));
    expect(res.status).toBe(200);

    // helpers.send should have been called with an inputResponses payload.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({ inputResponses: [{ requestId: "req_42", optionId: "ok" }] });
  });

  it("card.action.trigger with no marker (other integration's button) is a no-op", async () => {
    const mock = createMockFetch();
    const { sends, invoke } = makeChannelWithMockedClient(mock);

    const click = cardActionTrigger({ someOtherBot: true });
    const res = await invoke(buildRequest(click));
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(0);
  });

  it("card.action.trigger for an unknown requestId is a no-op (already answered / expired)", async () => {
    const mock = createMockFetch();
    const { sends, invoke } = makeChannelWithMockedClient(mock);

    const click = cardActionTrigger({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_does_not_exist",
      optionId: "x",
    });
    const res = await invoke(buildRequest(click));
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(0);
  });

  it("freeform reply is intercepted as InputResponse.text when awaitingFreeform is set", async () => {
    const mock = createMockFetch();
    const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock);
    const events = testEvents;

    // Set up a pending freeform input.
    const request: LarkInputRequest = {
      requestId: "req_free",
      prompt: "What's your name?",
      allowFreeform: true,
      action: { kind: "tool-call", toolName: "ask_question", callId: "c3", input: {} },
    };
    await events["input.requested"]!(
      { requests: [request], sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      {
        session: {
          id: "sess_test",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                rootMessageId: undefined,
                parentId: undefined,
                messageId: "om_in_1",
              },
            },
          },
        },
      },
    );

    // User sends a follow-up chat message in the same chat.
    const followUp = imReceiveEvent({ text: "Alice", eventId: "evt_follow" });
    const res = await invoke(buildRequest(followUp));
    expect(res.status).toBe(200);

    // Should have called send with text response, NOT started a new turn.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({ inputResponses: [{ requestId: "req_free", text: "Alice" }] });
  });

  it("non-freeform message after a button-only ask starts a new turn normally", async () => {
    const mock = createMockFetch();
    const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock);
    const events = testEvents;
    const request: LarkInputRequest = {
      requestId: "req_nofree",
      prompt: "Yes or no?",
      options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }],
      // allowFreeform not set — button-only.
      action: { kind: "tool-call", toolName: "ask_question", callId: "c4", input: {} },
    };
    await events["input.requested"]!(
      { requests: [request], sequence: 1, stepIndex: 0, turnId: "t1" },
      {},
      {
        session: {
          id: "sess_test",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                rootMessageId: undefined,
                parentId: undefined,
                messageId: "om_in_1",
              },
            },
          },
        },
      },
    );

    // User sends a chat message instead of clicking — should NOT be
    // intercepted as an InputResponse; it's a normal new turn.
    const followUp = imReceiveEvent({ text: "maybe", eventId: "evt_follow2" });
    await invoke(buildRequest(followUp));
    expect(sends).toHaveLength(1);
    // New turn = payload is a UserContent array (text part), not {inputResponses}.
    expect(sends[0]!.payload).toEqual([{ type: "text", text: "maybe" }]);
  });
});
