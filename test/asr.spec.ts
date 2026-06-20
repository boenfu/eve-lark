import { describe, expect, it, vi } from "vitest";
import { createMockFetch, type MockFetch } from "./helpers/mock-fetch.js";
import { createLarkChannel } from "../src/channel.js";
import type { ResolvedLarkOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function baseOptions(overrides: Partial<ResolvedLarkOptions> & { asrProvider?: unknown } = {}): ResolvedLarkOptions & { asrProvider?: unknown } {
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

function audioEvent(fileKey = "aud_123"): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "2.0",
    header: {
      event_id: `evt_${Math.random().toString(36).slice(2, 8)}`,
      event_type: "im.message.receive_v1",
      create_time: String(Math.floor(Date.now() / 1000)),
      token: "tok", app_id: "cli_test",
    },
    event: {
      message: {
        message_id: "om_aud",
        chat_id: "oc_chat1",
        message_type: "audio",
        content: JSON.stringify({ file_key: fileKey }),
      },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      chat_type: "p2p",
    },
  }));
}

async function invoke(channel: ReturnType<typeof createLarkChannel>, body: Buffer) {
  const captured: { message: unknown } = { message: null };
  const waits: Promise<unknown>[] = [];
  const route = channel.routes[0] as unknown as { handler: (req: Request, args: unknown) => Promise<Response> };
  const args = {
    async send(message: unknown) { captured.message = message; return { id: "s", continuationToken: "t" }; },
    getSession: () => ({}), receive: async () => undefined, params: {},
    waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => {})); }, requestIp: null,
  };
  const res = await route.handler(
    new Request(`${BASE}/lark/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body }),
    args,
  );
  await Promise.all(waits);
  return { status: res.status, captured };
}

function setupMock(mock: MockFetch) {
  mock.on("POST", "/open-apis/auth/v3/tenant_access_token/internal", () => ({
    status: 200, body: { code: 0, tenant_access_token: "tat", expire: 7200 },
  }));
  mock.on("GET", (url) => url.pathname.includes("/resources/"), () => ({
    status: 200, body: Buffer.from([0x52, 0x49, 0x46, 0x46]), headers: { "content-type": "audio/wav" },
  }));
}

describe("audio transcription", () => {
  it("transcribes audio when asrProvider is configured and injects transcript as text", async () => {
    const mock = createMockFetch();
    setupMock(mock);
    const asrProvider = {
      transcribe: vi.fn().mockResolvedValue("Hello from audio"),
    };
    const channel = createLarkChannel(baseOptions({
      fetch: mock.fetch as unknown as typeof fetch,
      asrProvider,
    }) as never);
    const { captured } = await invoke(channel, audioEvent("aud_123"));
    expect(asrProvider.transcribe).toHaveBeenCalledOnce();
    expect(captured.message).toEqual([{ type: "text", text: "Hello from audio" }]);
  });

  it("passes audio resource through when asrProvider is NOT configured", async () => {
    const mock = createMockFetch();
    setupMock(mock);
    const channel = createLarkChannel(baseOptions({
      fetch: mock.fetch as unknown as typeof fetch,
    }) as never);
    const { captured } = await invoke(channel, audioEvent());
    expect(captured.message).toEqual([
      { type: "text", text: '<audio key="aud_123"/>' },
      { type: "file", data: expect.any(URL), mediaType: "audio/ogg" },
    ]);
  });

  it("falls back to ack-and-skip when asrProvider.transcribe throws", async () => {
    const mock = createMockFetch();
    setupMock(mock);
    const asrProvider = {
      transcribe: vi.fn().mockRejectedValue(new Error("ASR service unavailable")),
    };
    const channel = createLarkChannel(baseOptions({
      fetch: mock.fetch as unknown as typeof fetch,
      asrProvider,
    }) as never);
    const { captured } = await invoke(channel, audioEvent());
    expect(asrProvider.transcribe).toHaveBeenCalledOnce();
    expect(captured.message).toEqual([
      { type: "text", text: '<audio key="aud_123"/>' },
      { type: "file", data: expect.any(URL), mediaType: "audio/ogg" },
    ]);
  });
});
