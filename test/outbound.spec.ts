import { describe, expect, it } from "vitest";
import {
  chunkMarkdownText,
  createLarkSender,
  normalizeOutboundMentions,
} from "../src/outbound.js";
import { resolveOptions } from "../src/options.js";
import type { LarkChannelOptions } from "../src/types.js";

const BASE = "https://open.feishu.test";

function baseOptions(fetchImpl: typeof fetch): LarkChannelOptions {
  return {
    appId: "cli_test",
    appSecret: "secret_test",
    verificationToken: "tok",
    baseUrl: BASE,
    fetch: fetchImpl,
    mode: "webhook",
    replyMode: "post",
    ackReaction: false,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("normalizeOutboundMentions", () => {
  it("rewrites plain @Name and @all while leaving code, email, URLs, and existing tags untouched", async () => {
    const out = await normalizeOutboundMentions(
      [
        "hi @Alice @all",
        "`@Alice` alice@example.com https://x.test/@Alice",
        '<at id=ou_bob>Bob</at>',
      ].join("\n"),
      {
        chatId: "oc_c",
        resolveName: async (name) =>
          name === "Alice" ? { openId: "ou_alice", name: "Alice" } : null,
      },
    );

    expect(out.text).toContain('hi <at user_id="ou_alice">Alice</at> <at user_id="all">Everyone</at>');
    expect(out.text).toContain("`@Alice` alice@example.com https://x.test/@Alice");
    expect(out.text).toContain('<at user_id="ou_bob">Bob</at>');
  });

  it("records ambiguous mentions instead of guessing", async () => {
    const out = await normalizeOutboundMentions("ask @Alex", {
      chatId: "oc_c",
      resolveName: async () => ({
        ambiguous: [
          { openId: "ou_1", name: "Alex" },
          { openId: "ou_2", name: "Alex" },
        ],
      }),
    });

    expect(out.text).toBe("ask @Alex");
    expect(out.sentinels).toEqual([
      {
        name: "Alex",
        reason: "ambiguous",
        candidates: [
          { openId: "ou_1", name: "Alex" },
          { openId: "ou_2", name: "Alex" },
        ],
      },
    ]);
  });
});

describe("chunkMarkdownText", () => {
  it("splits long markdown into bounded chunks without dropping content", () => {
    const text = ["alpha", "beta beta", "gamma gamma"].join("\n\n");
    const chunks = chunkMarkdownText(text, 14);

    expect(chunks.every((chunk) => chunk.length <= 14)).toBe(true);
    expect(chunks.join("\n\n")).toBe(text);
  });
});

describe("Lark outbound sender", () => {
  it("uploads an image buffer and sends it as an image message", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
      }
      calls.push({ method, path: url.pathname, body: init?.body });

      if (url.pathname === "/open-apis/im/v1/images") {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init!.body as FormData;
        expect(form.get("image_type")).toBe("message");
        expect(form.get("image")).toBeInstanceOf(Blob);
        return json({ code: 0, data: { image_key: "img_1" } });
      }
      if (url.pathname === "/open-apis/im/v1/messages") {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({
          receive_id: "oc_c",
          msg_type: "image",
          content: JSON.stringify({ image_key: "img_1" }),
        });
        return json({ code: 0, data: { message_id: "om_image" } });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    }) as typeof fetch;

    const sender = createLarkSender(baseOptions(fetchImpl));
    const result = await sender.sendMedia({
      chatId: "oc_c",
      media: { data: Buffer.from([1, 2, 3]), fileName: "photo.png" },
    });

    expect(result.messageId).toBe("om_image");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /open-apis/im/v1/images",
      "POST /open-apis/im/v1/messages",
    ]);
  });

  it("orchestrates text, native Feishu card, and multiple media messages in order", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const uploads: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
      }
      if (url.pathname === "/open-apis/im/v1/files") {
        const form = init!.body as FormData;
        uploads.push(String(form.get("file_name")));
        return json({ code: 0, data: { file_key: `file_${uploads.length}` } });
      }
      if (url.pathname === "/open-apis/im/v1/messages") {
        sends.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return json({ code: 0, data: { message_id: `om_${sends.length}` } });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;

    const sender = createLarkSender(baseOptions(fetchImpl));
    const result = await sender.sendPayload({
      chatId: "oc_c",
      text: "hello @Alice",
      channelData: {
        feishu: { card: { schema: "2.0", body: { elements: [{ tag: "markdown", content: "card" }] } } },
      },
      media: [
        { data: Buffer.from("a"), fileName: "a.pdf" },
        { data: Buffer.from("b"), fileName: "b.pdf" },
      ],
      mentions: { Alice: { openId: "ou_alice", name: "Alice" } },
    });

    expect(result.messageId).toBe("om_4");
    expect(uploads).toEqual(["a.pdf", "b.pdf"]);
    expect(sends.map((s) => s.msg_type)).toEqual(["post", "interactive", "file", "file"]);
    expect(JSON.parse(sends[0]!.content as string).zh_cn.content[0][0].text).toBe(
      'hello <at user_id="ou_alice">Alice</at>',
    );
    expect(JSON.parse(sends[1]!.content as string)).toEqual({
      schema: "2.0",
      body: { elements: [{ tag: "markdown", content: "card" }] },
    });
    expect(JSON.parse(sends[2]!.content as string)).toEqual({ file_key: "file_1" });
    expect(JSON.parse(sends[3]!.content as string)).toEqual({ file_key: "file_2" });
  });

  it("fetches chat members to normalize @Name when no explicit mention map is provided", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
      }
      if (url.pathname === "/open-apis/im/v1/chats/oc_c/members") {
        return json({
          code: 0,
          data: {
            items: [
              { member_id: "ou_alice", name: "Alice" },
              { member_id: "ou_bob", name: "Bob" },
            ],
            has_more: false,
          },
        });
      }
      if (url.pathname === "/open-apis/im/v1/messages") {
        sends.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return json({ code: 0, data: { message_id: "om_text" } });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;

    const sender = createLarkSender(baseOptions(fetchImpl));
    await sender.sendPayload({ chatId: "oc_c", text: "hello @Alice" });

    expect(JSON.parse(sends[0]!.content as string).zh_cn.content[0][0].text).toBe(
      'hello <at user_id="ou_alice">Alice</at>',
    );
  });

  it("downloads a remote media URL before uploading and sending the file", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      calls.push(`${init?.method ?? "GET"} ${url.toString()}`);
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
      }
      if (url.toString() === "https://cdn.test/report.pdf") {
        return new Response(Buffer.from("pdf"), { status: 200 });
      }
      if (url.pathname === "/open-apis/im/v1/files") {
        const form = init!.body as FormData;
        expect(form.get("file_name")).toBe("report.pdf");
        return json({ code: 0, data: { file_key: "file_pdf" } });
      }
      if (url.pathname === "/open-apis/im/v1/messages") {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body.msg_type).toBe("file");
        expect(JSON.parse(body.content as string)).toEqual({ file_key: "file_pdf" });
        return json({ code: 0, data: { message_id: "om_file" } });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;

    const sender = createLarkSender(baseOptions(fetchImpl));
    const result = await sender.sendMedia({
      chatId: "oc_c",
      media: { url: "https://cdn.test/report.pdf" },
    });

    expect(result.messageId).toBe("om_file");
    expect(calls).toEqual([
      "GET https://cdn.test/report.pdf",
      "POST https://open.feishu.test/open-apis/auth/v3/tenant_access_token/internal",
      "POST https://open.feishu.test/open-apis/im/v1/files",
      "POST https://open.feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id",
    ]);
  });
});

describe("LarkClient outbound management APIs", () => {
  it("forwards, deletes, updates chat metadata, and manages chat members", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        return json({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
      }
      calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.pathname === "/open-apis/im/v1/messages/om_src/forward") {
        return json({ code: 0, data: { message_id: "om_fwd" } });
      }
      if (url.pathname === "/open-apis/im/v1/messages/om_src") {
        return json({ code: 0 });
      }
      if (url.pathname === "/open-apis/im/v1/chats/oc_c") {
        return json({ code: 0 });
      }
      if (url.pathname === "/open-apis/im/v1/chats/oc_c/members") {
        return json({ code: 0, data: { items: [{ member_id: "ou_1", name: "A" }], has_more: false } });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;

    const { LarkClient } = await import("../src/lark-client.js");
    const client = new LarkClient(resolveOptions({
      ...baseOptions(fetchImpl),
      maxRetries: 0,
    }));

    await expect(client.forwardMessage({ messageId: "om_src", chatId: "oc_c" })).resolves.toEqual({ messageId: "om_fwd" });
    await client.deleteMessage({ messageId: "om_src" });
    await client.updateChat({ chatId: "oc_c", name: "New name" });
    await client.addChatMembers({ chatId: "oc_c", memberIds: ["ou_1"] });
    await client.removeChatMembers({ chatId: "oc_c", memberIds: ["ou_1"] });
    await expect(client.listChatMembers({ chatId: "oc_c" })).resolves.toEqual({
      members: [{ memberId: "ou_1", name: "A" }],
      hasMore: false,
      pageToken: undefined,
    });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /open-apis/im/v1/messages/om_src/forward",
      "DELETE /open-apis/im/v1/messages/om_src",
      "PATCH /open-apis/im/v1/chats/oc_c",
      "POST /open-apis/im/v1/chats/oc_c/members",
      "DELETE /open-apis/im/v1/chats/oc_c/members",
      "GET /open-apis/im/v1/chats/oc_c/members",
    ]);
  });
});
