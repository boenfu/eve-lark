import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import { ASK_BUTTON_VALUE_MARKER } from "../src/card.js";
import type { LarkCustomCardActionContext, ResolvedLarkOptions, LarkInputRequest } from "../src/types.js";

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
      event_id: `evt_card_${Math.random().toString(36).slice(2, 8)}`,
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

function formActionTrigger(
  value: Record<string, unknown>,
  formValue: Record<string, unknown>,
  openMessageId = "om_card_1",
): object {
  const body = cardActionTrigger(value, openMessageId) as {
    event: { action: Record<string, unknown> };
  };
  body.event.action.form_value = formValue;
  body.event.action.tag = "form";
  return body;
}

async function eventsSettled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

interface CapturedSend {
  payload: unknown;
  opts: { continuationToken: string; auth: unknown };
}

function makeChannelWithMockedClient(
  mock: MockFetch,
  opts: {
    registerDefaultCardHandlers?: boolean;
    options?: Partial<ResolvedLarkOptions>;
    sendImpl?: (payload: unknown, opts: unknown) => Promise<{ id: string; continuationToken: string }>;
  } = {},
) {
  registerToken(mock);
  if (opts.registerDefaultCardHandlers !== false) {
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
  }
  const sends: CapturedSend[] = [];
  const waits: Array<Promise<unknown>> = [];
  const channel = createLarkChannel(
    baseOptions({ fetch: mock.fetch as unknown as typeof fetch, ...opts.options }),
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
    waits,
    testEvents,
    async invoke(req: Request): Promise<Response> {
      const args = {
        async send(payload: unknown, sendOpts: unknown) {
          if (opts.sendImpl) return opts.sendImpl(payload, sendOpts);
          sends.push({ payload, opts: sendOpts as { continuationToken: string; auth: unknown } });
          return { id: "sess_test", continuationToken: (sendOpts as { continuationToken: string }).continuationToken };
        },
        getSession: () => ({ id: "sess_test" }),
        receive: async () => undefined,
        params: {},
        waitUntil: (p: Promise<unknown>) => {
          // Track so tests can `await Promise.all(waits)` after invoke.
          waits.push(p.catch(() => {}));
        },
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

  it("streaming-v2 sends option questions as a separate v1 ask card instead of patching unsupported v2 actions", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      const interactiveSends: Array<{ messageId: string; card: Record<string, unknown> }> = [];
      const patches: Record<string, unknown>[] = [];
      let nextMessageId = 1;
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        (req) => {
          const body = req.body as { msg_type: string; content: string };
          if (body.msg_type === "interactive") {
            const messageId = `om_card_${nextMessageId++}`;
            interactiveSends.push({ messageId, card: JSON.parse(body.content) as Record<string, unknown> });
            return { status: 200, body: { code: 0, data: { message_id: messageId } } };
          }
          return { status: 500, body: { code: 1, msg: "unexpected message type" } };
        },
        { description: "POST interactive cards" },
      );
      mock.on(
        "PATCH",
        (url) => url.pathname.startsWith("/open-apis/im/v1/messages/"),
        (req) => {
          patches.push(JSON.parse((req.body as { content: string }).content) as Record<string, unknown>);
          return { status: 200, body: { code: 0 } };
        },
        { description: "PATCH cards" },
      );
      const { testEvents } = makeChannelWithMockedClient(mock, {
        registerDefaultCardHandlers: false,
        options: {
          replyMode: "streaming-v2",
          streamCreateThresholdMs: 1,
          streamPatchIntervalMs: 1,
        },
      });
      const sessionCtx = {
        session: {
          id: "sess_test",
          auth: {
            initiator: {
              attributes: {
                chatId: "oc_chat1",
                messageId: "om_in_1",
              },
            },
          },
        },
      };

      testEvents["message.appended"]!(
        { messageDelta: "Need one detail.", sequence: 1, stepIndex: 0, turnId: "t1" },
        {},
        sessionCtx,
      );
      await vi.advanceTimersByTimeAsync(2);
      await eventsSettled();

      await testEvents["input.requested"]!(
        {
          requests: [
            {
              requestId: "req_v2_options",
              prompt: "Pick one",
              options: [{ id: "a", label: "A" }],
              action: { kind: "tool-call", toolName: "ask_question", callId: "c_v2", input: {} },
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "t1",
        },
        {},
        sessionCtx,
      );

      expect(interactiveSends).toHaveLength(2);
      expect(interactiveSends[0]!.card.schema).toBe("2.0");
      expect(interactiveSends[1]!.card.schema).toBeUndefined();
      expect(patches).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders multiple input requests as one submit form card", async () => {
    const mock = createMockFetch();
    const cardSends: Array<Record<string, unknown>> = [];
    mock.on(
      "POST",
      "/open-apis/im/v1/messages",
      (req) => {
        const body = req.body as { msg_type: string; content: string };
        if (body.msg_type === "interactive") {
          cardSends.push(JSON.parse(body.content) as Record<string, unknown>);
        }
        return { status: 200, body: { code: 0, data: { message_id: "om_card_1" } } };
      },
      { description: "POST ask form card" },
    );
    const { testEvents } = makeChannelWithMockedClient(mock, { registerDefaultCardHandlers: false });

    await testEvents["input.requested"]!(
      {
        requests: [
          {
            requestId: "req_name",
            prompt: "Name?",
            allowFreeform: true,
            display: "text",
            action: { kind: "tool-call", toolName: "ask_question", callId: "c_name", input: {} },
          },
          {
            requestId: "req_color",
            prompt: "Color?",
            options: [{ id: "blue", label: "Blue" }],
            display: "select",
            action: { kind: "tool-call", toolName: "ask_question", callId: "c_color", input: {} },
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
      {},
      {
        session: {
          id: "sess_test",
          auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in_1" } } },
        },
      },
    );

    expect(cardSends).toHaveLength(1);
    const card = cardSends[0] as { elements: Array<{ tag?: string; actions?: Array<{ value?: Record<string, unknown> }> }> };
    const submit = card.elements.flatMap((e) => e.actions ?? []).find((a) => a.value?.__eveLarkAskForm === true);
    expect(submit?.value).toMatchObject({ requestIds: ["req_name", "req_color"] });
  });

  it("submits multiple form fields as one inputResponses payload", async () => {
    const mock = createMockFetch();
    const { sends, invoke, testEvents, waits } = makeChannelWithMockedClient(mock);
    await testEvents["input.requested"]!(
      {
        requests: [
          {
            requestId: "req_name",
            prompt: "Name?",
            allowFreeform: true,
            display: "text",
            action: { kind: "tool-call", toolName: "ask_question", callId: "c_name", input: {} },
          },
          {
            requestId: "req_color",
            prompt: "Color?",
            options: [{ id: "blue", label: "Blue" }],
            display: "select",
            action: { kind: "tool-call", toolName: "ask_question", callId: "c_color", input: {} },
          },
        ],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
      {},
      {
        session: {
          id: "sess_test",
          auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in_1" } } },
        },
      },
    );

    const click = formActionTrigger(
      { __eveLarkAskForm: true, requestIds: ["req_name", "req_color"] },
      { req_name: "Alice", req_color: "blue" },
    );
    const res = await invoke(buildRequest(click));
    expect(res.status).toBe(200);
    await Promise.all(waits);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({
      inputResponses: [
        { requestId: "req_name", text: "Alice" },
        { requestId: "req_color", optionId: "blue" },
      ],
    });
  });

  it("expires a pending input card after askInputTtlMs and ignores later clicks", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockFetch();
      const patches: string[] = [];
      mock.on(
        "POST",
        "/open-apis/im/v1/messages",
        () => ({ status: 200, body: { code: 0, data: { message_id: "om_card_1" } } }),
        { description: "POST ask card" },
      );
      mock.on(
        "PATCH",
        (url) => url.pathname.startsWith("/open-apis/im/v1/messages/om_card_1"),
        (req) => {
          patches.push((req.body as { content: string }).content);
          return { status: 200, body: { code: 0 } };
        },
        { description: "PATCH expired ask card" },
      );
      const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock, {
        registerDefaultCardHandlers: false,
        options: { askInputTtlMs: 10 } as Partial<ResolvedLarkOptions>,
      });

      await testEvents["input.requested"]!(
        {
          requests: [{
            requestId: "req_expire",
            prompt: "Continue?",
            options: [{ id: "ok", label: "OK" }],
            action: { kind: "tool-call", toolName: "ask_question", callId: "c_expire", input: {} },
          }],
          sequence: 1,
          stepIndex: 0,
          turnId: "t1",
        },
        {},
        {
          session: {
            id: "sess_test",
            auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in_1" } } },
          },
        },
      );

      await vi.advanceTimersByTimeAsync(11);
      expect(patches.join("\n")).toContain("expired");

      await invoke(buildRequest(cardActionTrigger({
        [ASK_BUTTON_VALUE_MARKER]: true,
        requestId: "req_expire",
        optionId: "ok",
      })));
      expect(sends).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending card-action input retryable when synthetic injection fails", async () => {
    const mock = createMockFetch();
    let calls = 0;
    const sends: CapturedSend[] = [];
    const { invoke, testEvents, waits } = makeChannelWithMockedClient(mock, {
      sendImpl: async (payload, sendOpts) => {
        calls += 1;
        if (calls === 1) throw new Error("eve temporarily unavailable");
        sends.push({ payload, opts: sendOpts as CapturedSend["opts"] });
        return { id: "sess_test", continuationToken: "oc_chat1:_" };
      },
    });

    await testEvents["input.requested"]!(
      {
        requests: [{
          requestId: "req_retry",
          prompt: "Confirm?",
          options: [{ id: "ok", label: "OK" }],
          action: { kind: "tool-call", toolName: "ask_question", callId: "c_retry", input: {} },
        }],
        sequence: 1,
        stepIndex: 0,
        turnId: "t1",
      },
      {},
      {
        session: {
          id: "sess_test",
          auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in_1" } } },
        },
      },
    );

    await invoke(buildRequest(cardActionTrigger({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_retry",
      optionId: "ok",
    })));
    await Promise.all(waits);
    expect(sends).toHaveLength(0);

    await invoke(buildRequest(cardActionTrigger({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_retry",
      optionId: "ok",
    })));
    await Promise.all(waits);

    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({ inputResponses: [{ requestId: "req_retry", optionId: "ok" }] });
  });

  it("falls back to a text prompt and accepts the next message when an ask card cannot be sent", async () => {
    const mock = createMockFetch();
    const textMessages: string[] = [];
    mock.on(
      "POST",
      "/open-apis/im/v1/messages",
      (req) => {
        const body = req.body as { msg_type: string; content: string };
        if (body.msg_type === "interactive") {
          return {
            status: 400,
            body: { code: 230099, msg: "Failed to create card content" },
          };
        }
        if (body.msg_type === "text") {
          textMessages.push(JSON.parse(body.content).text as string);
          return { status: 200, body: { code: 0, data: { message_id: "om_text_1" } } };
        }
        return { status: 500, body: { code: 1, msg: "unexpected message type" } };
      },
      { description: "POST card failure then text fallback" },
    );
    const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock, {
      registerDefaultCardHandlers: false,
    });

    const request: LarkInputRequest = {
      requestId: "req_card_fail",
      prompt: "Which trigger should this agent use?",
      options: [
        { id: "cron", label: "Cron" },
        { id: "manual", label: "Manual" },
      ],
      action: { kind: "tool-call", toolName: "ask_question", callId: "c_fail", input: {} },
    };
    await testEvents["input.requested"]!(
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

    expect(textMessages).toHaveLength(1);
    expect(textMessages[0]).toContain("Interactive question card failed to render");
    expect(textMessages[0]).toContain("Failed to create card content");
    expect(textMessages[0]).toContain("Which trigger should this agent use?");
    expect(textMessages[0]).toContain("Cron");

    const followUp = imReceiveEvent({ text: "Cron", eventId: "evt_card_fail_follow" });
    const res = await invoke(buildRequest(followUp));
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({ inputResponses: [{ requestId: "req_card_fail", text: "Cron" }] });
  });

  it("card.action.trigger with our marker resumes the session via inputResponses", async () => {
    const mock = createMockFetch();
    const { sends, invoke, testEvents, waits } = makeChannelWithMockedClient(mock);
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

    // handleCardAction now acks first and runs send+patch in the background
    // via helpers.waitUntil — wait for that work before asserting on sends.
    await Promise.all(waits);

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

  it("dispatches non-eve card actions to a custom handler", async () => {
    const mock = createMockFetch();
    const handled: unknown[] = [];
    const { invoke } = makeChannelWithMockedClient(mock, {
      options: {
        cardActionHandler: async (actionCtx: LarkCustomCardActionContext) => {
          handled.push({
            action: actionCtx.action,
            actionValue: actionCtx.actionValue,
            chatId: actionCtx.chatId,
            messageId: actionCtx.messageId,
            senderOpenId: actionCtx.senderOpenId,
            rawEvent: actionCtx.rawEvent,
          });
          return { toast: { type: "success", content: "Handled" } };
        },
      },
    });
    const click = cardActionTrigger({ action: "ticket.approve", ticketId: "T-1" }, "om_card_custom") as {
      event: Record<string, unknown>;
    };
    click.event.open_chat_id = "oc_chat1";

    const res = await invoke(buildRequest(click));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ toast: { type: "success", content: "Handled" } });
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      action: "ticket.approve",
      actionValue: { action: "ticket.approve", ticketId: "T-1" },
      chatId: "oc_chat1",
      messageId: "om_card_custom",
      senderOpenId: "ou_user",
    });
  });

  it("custom card actions can reply, follow up, and edit the source card", async () => {
    const mock = createMockFetch();
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    mock.on(
      "POST",
      "/open-apis/im/v1/messages/om_card_custom/reply",
      (req) => {
        calls.push({ method: req.method, path: req.url.pathname, body: req.body });
        return { status: 200, body: { code: 0, data: { message_id: "om_reply" } } };
      },
      { description: "POST custom action reply" },
    );
    mock.on(
      "POST",
      "/open-apis/im/v1/messages",
      (req) => {
        calls.push({ method: req.method, path: req.url.pathname, body: req.body });
        return { status: 200, body: { code: 0, data: { message_id: "om_follow" } } };
      },
      { description: "POST custom action follow-up" },
    );
    mock.on(
      "PATCH",
      "/open-apis/im/v1/messages/om_card_custom",
      (req) => {
        calls.push({ method: req.method, path: req.url.pathname, body: req.body });
        return { status: 200, body: { code: 0 } };
      },
      { description: "PATCH custom action card" },
    );
    const { invoke } = makeChannelWithMockedClient(mock, {
      registerDefaultCardHandlers: false,
      options: {
        cardActionHandler: async (actionCtx: LarkCustomCardActionContext) => {
          await actionCtx.respond.reply({ text: "reply text" });
          await actionCtx.respond.followUp({ text: "follow-up text" });
          await actionCtx.respond.editMessage({ text: "edited text" });
        },
      },
    });
    const click = cardActionTrigger({ action: "ticket.comment" }, "om_card_custom") as {
      event: Record<string, unknown>;
    };
    click.event.open_chat_id = "oc_chat1";

    const res = await invoke(buildRequest(click));

    expect(res.status).toBe(200);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /open-apis/im/v1/messages/om_card_custom/reply",
      "POST /open-apis/im/v1/messages",
      "PATCH /open-apis/im/v1/messages/om_card_custom",
    ]);
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

  it("button-only pending input accepts a text reply that matches an option label", async () => {
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

    const followUp = imReceiveEvent({ text: "yes", eventId: "evt_follow2" });
    await invoke(buildRequest(followUp));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toEqual({ inputResponses: [{ requestId: "req_nofree", optionId: "y" }] });
  });

  it("button-only pending input rejects unmatched text visibly instead of starting a new turn", async () => {
    const mock = createMockFetch();
    const textMessages: string[] = [];
    mock.on(
      "POST",
      "/open-apis/im/v1/messages",
      (req) => {
        const body = req.body as { msg_type: string; content: string };
        if (body.msg_type === "interactive") {
          return { status: 200, body: { code: 0, data: { message_id: "om_card_1" } } };
        }
        if (body.msg_type === "text") {
          textMessages.push(JSON.parse(body.content).text as string);
          return { status: 200, body: { code: 0, data: { message_id: "om_text_1" } } };
        }
        return { status: 500, body: { code: 1, msg: "unexpected message type" } };
      },
      { description: "POST ask card and pending-input text hint" },
    );
    const { sends, invoke, testEvents } = makeChannelWithMockedClient(mock, {
      registerDefaultCardHandlers: false,
    });
    const events = testEvents;
    const request: LarkInputRequest = {
      requestId: "req_nofree_unmatched",
      prompt: "Yes or no?",
      options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }],
      action: { kind: "tool-call", toolName: "ask_question", callId: "c5", input: {} },
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

    const followUp = imReceiveEvent({ text: "maybe", eventId: "evt_follow3" });
    const res = await invoke(buildRequest(followUp));
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(0);
    expect(textMessages).toHaveLength(1);
    expect(textMessages[0]).toContain("This conversation is waiting for your answer");
    expect(textMessages[0]).toContain("Yes");
    expect(textMessages[0]).toContain("No");
  });
});
