import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createCipher } from "./helpers/encrypt.js";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel, larkContinuationToken } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";
const APP_ID = "cli_test";
const APP_SECRET = "secret_test";
const VERIFICATION_TOKEN = "tok_verify";
const ENCRYPT_KEY = "encrypt_key_test";

function baseOptions(overrides: Partial<ResolvedLarkOptions> = {}): ResolvedLarkOptions {
  return {
    appId: APP_ID,
    appSecret: APP_SECRET,
    verificationToken: VERIFICATION_TOKEN,
    encryptKey: undefined,
    baseUrl: BASE,
    botOpenId: undefined,
    webhookPath: "/lark/webhook",
    replyMode: "streaming",
    streamPatchIntervalMs: 10,
    streamCreateThresholdMs: 5,
    dedupTtlMs: 30 * 60 * 1000,
    dedupMaxEntries: 5000,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    tokenRefreshBufferMs: 60_000,
    signatureSkewMs: 300_000,
    fetch: globalThis.fetch,
    // Disable ack-reaction by default so non-reaction tests don't hit the
    // network. Reaction-specific tests override this.
    ackReaction: false,
    // Webhook mode by default so the test suite doesn't try to start a
    // real Feishu WSClient at channel construction.
    mode: "webhook",
    port: 2000,
    ...overrides,
  };
}

function sign(timestamp: string, nonce: string, body: Buffer): Record<string, string> {
  const sig = createHash("sha256")
    .update(timestamp + nonce + ENCRYPT_KEY)
    .update(body)
    .digest("hex");
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": `sha256=${sig}`,
  };
}

function buildRequest(
  body: Buffer | string,
  headers: Record<string, string> = {},
  path = "/lark/webhook",
): Request {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: buf,
  });
}

function textEventPayload(opts: {
  messageId?: string;
  text?: string;
  chatId?: string;
  senderOpenId?: string;
  eventId?: string;
  chatType?: string;
  rootId?: string;
  parentId?: string;
  senderType?: string;
} = {}): Buffer {
  const event = {
    schema: "2.0",
    header: {
      event_id: opts.eventId ?? "evt_1",
      event_type: "im.message.receive_v1",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
      tenant_key: "tenant_test",
    },
    event: {
      message: {
        message_id: opts.messageId ?? "om_1",
        chat_id: opts.chatId ?? "oc_chat1",
        message_type: "text",
        content: JSON.stringify({ text: opts.text ?? "hello" }),
        ...(opts.rootId !== undefined ? { root_id: opts.rootId } : {}),
        ...(opts.parentId !== undefined ? { parent_id: opts.parentId } : {}),
      },
      sender: {
        sender_id: { open_id: opts.senderOpenId ?? "ou_user1" },
        sender_type: opts.senderType ?? "user",
      },
      chat_type: opts.chatType ?? "p2p",
    },
  };
  return Buffer.from(JSON.stringify(event), "utf8");
}

interface CapturedSession {
  id: string;
  continuationToken: string;
  auth: unknown;
  message: unknown;
}

/** Captures waitUntil'd promises so tests can await them. */
type WaitCapture = Array<Promise<unknown>>;

interface RouteHandlerArgs {
  send: (msg: unknown, opts: unknown) => Promise<{ id: string; continuationToken: string }>;
  getSession: unknown;
  receive: unknown;
  params: Record<string, string>;
  waitUntil: (p: Promise<unknown>) => void;
  requestIp: string | null;
}

function makeRouteArgs(captured: CapturedSession, waits: WaitCapture = []): RouteHandlerArgs {
  return {
    async send(message, opts) {
      const o = opts as { continuationToken: string; auth: unknown };
      captured.message = message;
      captured.continuationToken = o.continuationToken;
      captured.auth = o.auth;
      return { id: "sess_1", continuationToken: o.continuationToken };
    },
    getSession: () => ({ id: "sess_1" }),
    receive: async () => undefined,
    params: {},
    waitUntil: (p) => {
      waits.push(p);
      void p.catch(() => {});
    },
    requestIp: null,
  };
}

function getHandler(channel: ReturnType<typeof createLarkChannel>) {
  const route = channel.routes[0];
  if (!route || route.method !== "POST") {
    throw new Error("expected a POST route");
  }
  // RouteHandler is what we set; cast through unknown since the public type
  // is a union with WS routes.
  const any = route as unknown as { handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> };
  return any.handler;
}

async function invoke(
  channel: ReturnType<typeof createLarkChannel>,
  req: Request,
  captured: CapturedSession,
  waits: WaitCapture = [],
): Promise<Response> {
  const handler = getHandler(channel);
  return handler(req, makeRouteArgs(captured, waits));
}

describe("createLarkChannel", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("continuation token helper", () => {
    it("joins chatId and rootMessageId with a colon", () => {
      expect(larkContinuationToken("oc_c", "om_r")).toBe("oc_c:om_r");
    });
    it("uses _ placeholder when rootMessageId is null", () => {
      expect(larkContinuationToken("oc_c", null)).toBe("oc_c:_");
    });
  });

  describe("url_verification", () => {
    it("echoes the challenge when the body is unencrypted", async () => {
      const channel = createLarkChannel(baseOptions());
      const body = Buffer.from(
        JSON.stringify({
          token: VERIFICATION_TOKEN,
          challenge: "abc123",
          type: "url_verification",
        }),
        "utf8",
      );
      const res = await invoke(channel, buildRequest(body), { id: "s", continuationToken: "", auth: null, message: null });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { challenge?: string };
      expect(json.challenge).toBe("abc123");
    });

    it("decrypts then echoes the challenge when encryptKey is set", async () => {
      const channel = createLarkChannel(baseOptions({ encryptKey: ENCRYPT_KEY }));
      const inner = Buffer.from(
        JSON.stringify({
          token: VERIFICATION_TOKEN,
          challenge: "secret_challenge",
          type: "url_verification",
        }),
        "utf8",
      );
      const encrypted = createCipher(inner, ENCRYPT_KEY).toString("base64");
      const envelope = Buffer.from(JSON.stringify({ encrypt: encrypted }), "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = sign(ts, "n1", envelope);
      const res = await invoke(channel, buildRequest(envelope, headers), {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { challenge?: string };
      expect(json.challenge).toBe("secret_challenge");
    });
  });

  describe("signature + skew", () => {
    it("returns 401 when signature is missing", async () => {
      const channel = createLarkChannel(baseOptions({ encryptKey: ENCRYPT_KEY }));
      const body = textEventPayload();
      const res = await invoke(channel, buildRequest(body), {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when signature is wrong", async () => {
      const channel = createLarkChannel(baseOptions({ encryptKey: ENCRYPT_KEY }));
      const body = textEventPayload();
      const freshTs = String(Math.floor(Date.now() / 1000));
      const headers = sign(freshTs, "n", body);
      headers["x-lark-signature"] = "sha256=" + "0".repeat(64);
      const res = await invoke(channel, buildRequest(body, headers), {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      });
      expect(res.status).toBe(401);
    });

    it("returns 408 when timestamp is outside the skew window", async () => {
      const channel = createLarkChannel(baseOptions({
        encryptKey: ENCRYPT_KEY,
        signatureSkewMs: 1000,
      }));
      const body = textEventPayload();
      const stale = String(Math.floor(Date.now() / 1000) - 60);
      const headers = sign(stale, "n1", body);
      const res = await invoke(channel, buildRequest(body, headers), {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      });
      expect(res.status).toBe(408);
    });
  });

  describe("event handling", () => {
    it("starts a session and acks 200 on a valid text event", async () => {
      const channel = createLarkChannel(baseOptions());
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const body = textEventPayload({ text: "hello there" });
      const res = await invoke(channel, buildRequest(body), captured);
      expect(res.status).toBe(200);
      expect(captured.message).toEqual([{ type: "text", text: "hello there" }]);
      expect(captured.continuationToken).toBe("oc_chat1:_");
      const auth = captured.auth as { authenticator: string; principalId: string };
      expect(auth.authenticator).toBe("lark");
      expect(auth.principalId).toBe("ou_user1");
    });

    it("skips bot echoes (senderType app) without starting a session", async () => {
      const channel = createLarkChannel(baseOptions());
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const body = textEventPayload({ senderOpenId: "ou_bot", text: "echo", senderType: "app" });
      const res = await invoke(channel, buildRequest(body), captured);
      expect(res.status).toBe(200);
      expect(captured.message).toBeNull();
    });

    it("rejects events whose verification_token does not match", async () => {
      const channel = createLarkChannel(baseOptions());
      const body = textEventPayload();
      const json = JSON.parse(body.toString("utf8"));
      json.header.token = "wrong_token";
      const res = await invoke(
        channel,
        buildRequest(Buffer.from(JSON.stringify(json), "utf8")),
        { id: "s", continuationToken: "", auth: null, message: null },
      );
      expect(res.status).toBe(401);
    });

    it("acks 200 and ignores non-message event types", async () => {
      const channel = createLarkChannel(baseOptions());
      const body = Buffer.from(
        JSON.stringify({
          schema: "2.0",
          header: {
            event_id: "e1",
            event_type: "contact.user.updated_v3",
            token: VERIFICATION_TOKEN,
            create_time: String(Math.floor(Date.now() / 1000)),
          },
          event: {},
        }),
        "utf8",
      );
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const res = await invoke(channel, buildRequest(body), captured);
      expect(res.status).toBe(200);
      expect(captured.message).toBeNull();
    });

    it("dedupes a replayed event_id", async () => {
      const channel = createLarkChannel(baseOptions());
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const body = textEventPayload({ eventId: "evt_dup" });
      const r1 = await invoke(channel, buildRequest(body), captured);
      expect(r1.status).toBe(200);
      expect(captured.message).not.toBeNull();
      captured.message = null;
      const r2 = await invoke(channel, buildRequest(body), captured);
      expect(r2.status).toBe(200);
      expect(captured.message).toBeNull();
    });

    it("continuation token embeds root_id when threaded", async () => {
      const channel = createLarkChannel(baseOptions());
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const body = textEventPayload({ rootId: "om_root", parentId: "om_parent" });
      await invoke(channel, buildRequest(body), captured);
      expect(captured.continuationToken).toBe("oc_chat1:om_parent");
    });

    it("static mode acks without subscribing to streaming", async () => {
      const channel = createLarkChannel(baseOptions({ replyMode: "static" }));
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const body = textEventPayload();
      const res = await invoke(channel, buildRequest(body), captured);
      expect(res.status).toBe(200);
      // In static mode, no streaming controller is created; delivery happens
      // entirely on `message.completed` (which the integration test exercises).
    });
  });

  describe("inbound image", () => {
    it("passes image file_key as a URL-backed file part", async () => {
      const channel = createLarkChannel(baseOptions());
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const evt = {
        schema: "2.0",
        header: {
          event_id: "e_img",
          event_type: "im.message.receive_v1",
          create_time: String(Math.floor(Date.now() / 1000)),
          token: VERIFICATION_TOKEN,
        },
        event: {
          message: {
            message_id: "om_img",
            chat_id: "oc_c",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_v3_001" }),
          },
          sender: { sender_id: { open_id: "ou_u" }, sender_type: "user" },
          chat_type: "p2p",
        },
      };
      const body = Buffer.from(JSON.stringify(evt), "utf8");
      await invoke(channel, buildRequest(body), captured);
      expect(Array.isArray(captured.message)).toBe(true);
      const parts = captured.message as Array<{ type: string; data?: unknown }>;
      const filePart = parts.find((p) => p.type === "file");
      expect(filePart).toBeDefined();
      expect(String((filePart as { data: URL }).data)).toContain("/open-apis/im/v1/messages/om_img/resources/img_v3");
    });
  });

  describe("ack reaction", () => {
    function registerToken(mock: MockFetch) {
      mock.on(
        "POST",
        "/open-apis/auth/v3/tenant_access_token/internal",
        () => ({
          status: 200,
          body: { code: 0, tenant_access_token: "tat_test", expire: 7200 },
        }),
        { description: "POST token" },
      );
    }

    it("fires the default ack reaction on the inbound message after parse", async () => {
      const mock = createMockFetch();
      registerToken(mock);
      const calls: Array<{ messageId: string; emoji: string }> = [];
      mock.on(
        "POST",
        (url) => url.pathname.includes("/reactions"),
        (req) => {
          const m = req.url.pathname.match(/\/messages\/([^/]+)\/reactions/);
          const body = req.body as { reaction_type?: { emoji_type?: string } };
          calls.push({
            messageId: m?.[1] ?? "",
            emoji: body.reaction_type?.emoji_type ?? "",
          });
          return { status: 200, body: { code: 0, data: { reaction_id: "r_1" } } };
        },
        { description: "POST reactions" },
      );

      const channel = createLarkChannel(
        baseOptions({
          fetch: mock.fetch as unknown as typeof fetch,
          ackReaction: "EYES",
        }),
      );
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const waits: WaitCapture = [];
      const body = textEventPayload({ messageId: "om_react_me", text: "hi" });
      const res = await invoke(channel, buildRequest(body), captured, waits);
      expect(res.status).toBe(200);
      // The webhook acks before the reaction fires; wait for background work.
      await Promise.all(waits);
      expect(calls).toEqual([{ messageId: "om_react_me", emoji: "EYES" }]);
    });

    it("honors a custom ackReaction emoji type", async () => {
      const mock = createMockFetch();
      registerToken(mock);
      const calls: string[] = [];
      mock.on(
        "POST",
        (url) => url.pathname.includes("/reactions"),
        (req) => {
          const body = req.body as { reaction_type?: { emoji_type?: string } };
          calls.push(body.reaction_type?.emoji_type ?? "");
          return { status: 200, body: { code: 0, data: { reaction_id: "r_1" } } };
        },
        { description: "POST reactions" },
      );

      const channel = createLarkChannel(
        baseOptions({ fetch: mock.fetch as unknown as typeof fetch, ackReaction: "THUMBSUP" } as ResolvedLarkOptions & { ackReaction: string }),
      );
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const waits: WaitCapture = [];
      const body = textEventPayload({ text: "hi" });
      await invoke(channel, buildRequest(body), captured, waits);
      await Promise.all(waits);
      expect(calls).toEqual(["THUMBSUP"]);
    });

    it("does not fire a reaction when ackReaction is false", async () => {
      const mock = createMockFetch();
      registerToken(mock);
      let calls = 0;
      mock.on(
        "POST",
        (url) => url.pathname.includes("/reactions"),
        () => {
          calls += 1;
          return { status: 200, body: { code: 0 } };
        },
        { description: "POST reactions (should not fire)" },
      );

      const channel = createLarkChannel(
        baseOptions({ fetch: mock.fetch as unknown as typeof fetch, ackReaction: false } as ResolvedLarkOptions & { ackReaction: false }),
      );
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const waits: WaitCapture = [];
      const body = textEventPayload({ text: "hi" });
      await invoke(channel, buildRequest(body), captured, waits);
      await Promise.all(waits);
      expect(calls).toBe(0);
    });

    it("picks one emoji at random when ackReaction is an array", async () => {
      const mock = createMockFetch();
      registerToken(mock);
      const seen = new Set<string>();
      mock.on(
        "POST",
        (url) => url.pathname.includes("/reactions"),
        (req) => {
          const body = req.body as { reaction_type?: { emoji_type?: string } };
          seen.add(body.reaction_type?.emoji_type ?? "");
          return { status: 200, body: { code: 0, data: { reaction_id: "r" } } };
        },
        { description: "POST reactions array" },
      );

      const channel = createLarkChannel(
        baseOptions({
          fetch: mock.fetch as unknown as typeof fetch,
          ackReaction: ["THUMBSUP", "HEART", "ROCKET"],
        } as unknown as ResolvedLarkOptions),
      );

      // Fire several events; over enough samples each candidate should
      // eventually be picked at least once (probabilistic but ~ certain at 30).
      for (let i = 0; i < 30; i++) {
        const captured: CapturedSession = {
          id: "s",
          continuationToken: "",
          auth: null,
          message: null,
        };
        const waits: WaitCapture = [];
        const body = textEventPayload({ eventId: `e_${i}`, text: "hi" });
        await invoke(channel, buildRequest(body), captured, waits);
        await Promise.all(waits);
      }
      expect(seen.size).toBeGreaterThan(1);
      for (const e of seen) {
        expect(["THUMBSUP", "HEART", "ROCKET"]).toContain(e);
      }
    });

    it("does not fire when ackReaction is an empty array", async () => {
      const mock = createMockFetch();
      registerToken(mock);
      let calls = 0;
      mock.on(
        "POST",
        (url) => url.pathname.includes("/reactions"),
        () => {
          calls += 1;
          return { status: 200, body: { code: 0 } };
        },
        { description: "POST reactions (empty array)" },
      );

      const channel = createLarkChannel(
        baseOptions({
          fetch: mock.fetch as unknown as typeof fetch,
          ackReaction: [],
        } as unknown as ResolvedLarkOptions),
      );
      const captured: CapturedSession = {
        id: "s",
        continuationToken: "",
        auth: null,
        message: null,
      };
      const waits: WaitCapture = [];
      const body = textEventPayload({ text: "hi" });
      await invoke(channel, buildRequest(body), captured, waits);
      await Promise.all(waits);
      expect(calls).toBe(0);
    });
  });
});
