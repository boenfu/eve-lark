import { describe, expect, it } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
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
    fetch: globalThis.fetch, ackReaction: false, mode: "webhook", port: 2000,
    allowFrom: undefined, groupAllowFrom: undefined, groupConfigs: undefined, asrProvider: undefined,
    ...overrides,
  };
}

function makeChannel(mock: MockFetch) {
  mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
    status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
  }));
  const sentCards: Array<{ elements: unknown[] }> = [];
  const patchedCards: Array<{ messageId: string; elements: unknown[] }> = [];
  mock.on("POST", "/open-apis/im/v1/messages", (req) => {
    const body = req.body as { content?: string };
    if (body.content) sentCards.push(JSON.parse(body.content));
    return { status: 200, body: { code: 0, data: { message_id: "om_auth_1" } } };
  });
  mock.on("PATCH", (url) => url.pathname.includes("/open-apis/im/v1/messages/"), (req) => {
    const body = req.body as { content?: string };
    const messageId = req.url.pathname.split("/").slice(-2, -1)[0];
    if (body.content) patchedCards.push({ messageId: messageId!, elements: JSON.parse(body.content).elements });
    return { status: 200, body: { code: 0 } };
  });
  const channel = createLarkChannel(baseOptions({ fetch: mock.fetch as unknown as typeof fetch }));
  return {
    events: (channel as unknown as {
      __testEvents: Record<string, (data: unknown, ch: unknown, ctx: unknown) => Promise<unknown> | unknown>;
    }).__testEvents,
    sentCards,
    patchedCards,
  };
}

const CTX = {
  session: {
    id: "sess_test",
    auth: { initiator: { attributes: { chatId: "oc_chat1", messageId: "om_in" } } },
  },
};

function divContent(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const e = el as { tag?: string; text?: { content?: string } };
  if (e.tag === "div" && e.text) return e.text.content;
  return undefined;
}

describe("authorization event adaptation", () => {
  it("authorization.required handler is registered", () => {
    const { events } = makeChannel(createMockFetch());
    expect(typeof events["authorization.required"]).toBe("function");
  });

  it("authorization.completed handler is registered", () => {
    const { events } = makeChannel(createMockFetch());
    expect(typeof events["authorization.completed"]).toBe("function");
  });

  it("authorization.required renders a card with a URL button to the auth URL", async () => {
    const { events, sentCards } = makeChannel(createMockFetch());
    await events["authorization.required"]!(
      {
        name: "github",
        authorization: { displayName: "GitHub", url: "https://gh.example/auth/abc" },
      },
      {},
      CTX,
    );
    expect(sentCards).toHaveLength(1);
    const elements = sentCards[0]!.elements as Array<Record<string, unknown>>;
    // Should contain the URL as button or as text (markdown link).
    const hasUrl = JSON.stringify(elements).includes("https://gh.example/auth/abc");
    expect(hasUrl).toBe(true);
    // Should mention the display name.
    const hasName = JSON.stringify(elements).includes("GitHub");
    expect(hasName).toBe(true);
  });

  it("authorization.required with userCode shows the code in the card", async () => {
    const { events, sentCards } = makeChannel(createMockFetch());
    await events["authorization.required"]!(
      {
        name: "linear",
        authorization: { displayName: "Linear", url: "https://lin.example/auth", userCode: "ABCD-1234" },
      },
      {},
      CTX,
    );
    expect(sentCards).toHaveLength(1);
    const hasCode = JSON.stringify(sentCards[0]).includes("ABCD-1234");
    expect(hasCode).toBe(true);
  });

  it("authorization.required without session info is a safe no-op", async () => {
    const { events, sentCards } = makeChannel(createMockFetch());
    await events["authorization.required"]!(
      { name: "x", authorization: { displayName: "X", url: "https://x" } },
      {},
      { session: { id: "sess_test" } }, // no auth.initiator.attributes
    );
    expect(sentCards).toHaveLength(0);
  });

  it("authorization.completed patches the auth card to show outcome", async () => {
    const { events, sentCards, patchedCards } = makeChannel(createMockFetch());
    // First render the required card.
    await events["authorization.required"]!(
      { name: "github", authorization: { displayName: "GitHub", url: "https://gh" } },
      {},
      CTX,
    );
    expect(sentCards).toHaveLength(1);
    // Now fire completed with authorized outcome. We need to pass the
    // authCardMessageId somehow — currently the handler tracks it
    // internally via the pending map. The completed handler needs the
    // session id to look it up.
    await events["authorization.completed"]!(
      { name: "github", outcome: "authorized", authorization: { displayName: "GitHub" } },
      {},
      CTX,
    );
    expect(patchedCards.length).toBeGreaterThanOrEqual(1);
    const lastPatch = patchedCards[patchedCards.length - 1]!;
    const text = (lastPatch.elements as unknown[])
      .map(divContent)
      .filter(Boolean)
      .join(" ");
    expect(text).toContain("GitHub");
    expect(text.toLowerCase()).toMatch(/authorized|done|complete|✓/);
  });

  it("authorization.completed without prior required card is a safe no-op", async () => {
    const { events, patchedCards } = makeChannel(createMockFetch());
    await events["authorization.completed"]!(
      { name: "x", outcome: "authorized", authorization: { displayName: "X" } },
      {},
      CTX,
    );
    expect(patchedCards).toHaveLength(0);
  });
});
