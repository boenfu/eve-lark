import { beforeEach, describe, expect, it } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import {
  postEventToWebhook,
  rebuildEnvelopeFromSdkEvent,
  type LarkEvent,
} from "../src/long-connection.js";

const EVE_URL = "http://localhost:21234/lark/webhook";
const ENCRYPT_KEY = "test_encrypt_key";
const VERIFICATION_TOKEN = "tok_verify";
const APP_ID = "cli_test";

/** The shape the @larksuiteoapi/node-sdk EventDispatcher hands to its callback. */
function sdkEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: "2.0",
    header: {
      event_id: "evt_1",
      event_type: "im.message.receive_v1",
      create_time: "1700000000",
      token: VERIFICATION_TOKEN,
      app_id: APP_ID,
      tenant_key: "tenant_test",
    },
    event: {
      message: {
        message_id: "om_1",
        chat_id: "oc_c",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
      sender: { sender_id: { open_id: "ou_user1" }, sender_type: "user" },
      chat_type: "p2p",
    },
    ...overrides,
  };
}

describe("rebuildEnvelopeFromSdkEvent", () => {
  it("preserves the SDK-supplied header when present", () => {
    const env = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", sdkEvent(), {
      appId: APP_ID,
      verificationToken: VERIFICATION_TOKEN,
    });
    expect(env.schema).toBe("2.0");
    expect((env.header as { event_id: string }).event_id).toBe("evt_1");
    expect(env.event).toMatchObject({
      message: { message_id: "om_1" },
    });
  });

  it("synthesizes a header when the SDK stripped it", () => {
    // The SDK sometimes calls handlers with just the event payload (no
    // envelope). We must still produce a v2-shaped envelope.
    const stripped = {
      message: { message_id: "om_2", chat_id: "oc_c", message_type: "text", content: "{}" },
      sender: { sender_id: { open_id: "ou_u" }, sender_type: "user" },
      chat_type: "p2p",
    };
    const env = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", stripped, {
      appId: APP_ID,
      verificationToken: VERIFICATION_TOKEN,
    });
    expect(env.schema).toBe("2.0");
    const header = env.header as { event_type: string; token: string; app_id: string };
    expect(header.event_type).toBe("im.message.receive_v1");
    expect(header.token).toBe(VERIFICATION_TOKEN);
    expect(header.app_id).toBe(APP_ID);
    expect(env.event).toBe(stripped);
  });
});

describe("postEventToWebhook", () => {
  let mock: MockFetch;
  beforeEach(() => {
    mock = createMockFetch();
  });

  it("POSTs the raw envelope when no encryptKey is set", async () => {
    let captured: { body: unknown; headers: Record<string, string> } | null = null;
    mock.on("POST", (u) => u.toString().startsWith(EVE_URL), (req) => {
      captured = { body: req.body, headers: req.headers };
      return { status: 200, body: { code: 0 } };
    }, { description: "POST forward" });

    const evt: LarkEvent = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", sdkEvent(), {
      appId: APP_ID,
      verificationToken: VERIFICATION_TOKEN,
    });
    await postEventToWebhook(evt, {
      eveWebhookUrl: EVE_URL,
      encryptKey: undefined,
      fetch: mock.fetch,
    });

    expect(captured).not.toBeNull();
    expect(captured!.body).toEqual(evt);
    expect(captured!.headers["x-lark-signature"]).toBeUndefined();
  });

  it("encrypts and signs when encryptKey is set, round-trips through the channel's crypto", async () => {
    let captured: { body: { encrypt?: string }; headers: Record<string, string> } | null = null;
    mock.on("POST", (u) => u.toString().startsWith(EVE_URL), (req) => {
      captured = { body: req.body as { encrypt?: string }, headers: req.headers };
      return { status: 200, body: { code: 0 } };
    }, { description: "POST forward encrypted" });

    const evt: LarkEvent = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", sdkEvent(), {
      appId: APP_ID,
      verificationToken: VERIFICATION_TOKEN,
    });
    await postEventToWebhook(evt, {
      eveWebhookUrl: EVE_URL,
      encryptKey: ENCRYPT_KEY,
      fetch: mock.fetch,
    });

    expect(captured).not.toBeNull();
    expect(typeof captured!.body.encrypt).toBe("string");

    // Decrypt and verify the round-trip — channel's decryptPayload should
    // produce exactly what we sent.
    const { decryptPayload } = await import("../src/crypto.js");
    const plain = decryptPayload(captured!.body.encrypt!, ENCRYPT_KEY).toString("utf8");
    expect(JSON.parse(plain)).toEqual(evt);

    // Signature headers all present and well-formed.
    expect(captured!.headers["x-lark-request-timestamp"]).toMatch(/^\d+$/);
    expect(captured!.headers["x-lark-request-nonce"]).toBeTruthy();
    expect(captured!.headers["x-lark-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("throws with the status code when eve returns non-2xx", async () => {
    mock.on("POST", (u) => u.toString().startsWith(EVE_URL), () => ({
      status: 500,
      body: "internal",
    }), { description: "POST forward 500" });

    const evt: LarkEvent = rebuildEnvelopeFromSdkEvent("im.message.receive_v1", sdkEvent(), {
      appId: APP_ID,
      verificationToken: VERIFICATION_TOKEN,
    });
    await expect(
      postEventToWebhook(evt, {
        eveWebhookUrl: EVE_URL,
        encryptKey: undefined,
        fetch: mock.fetch,
      }),
    ).rejects.toThrow(/500/);
  });
});
