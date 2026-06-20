import { describe, expect, it } from "vitest";
import { parseInbound } from "../src/parse.js";
import type { LarkInboundEvent } from "../src/types.js";

const BOT_OPEN_ID = "ou_bot_123";

function textEvent(overrides: Partial<LarkInboundEvent> = {}): LarkInboundEvent {
  return {
    message: {
      message_id: "om_test",
      chat_id: "oc_chat1",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
      ...overrides.message,
    },
    sender: {
      sender_id: { open_id: "ou_user1" },
      sender_type: "user",
      ...overrides.sender,
    },
    chat_type: "p2p",
    ...overrides,
  };
}

describe("parseInbound", () => {
  describe("text", () => {
    it("extracts the plain text body", () => {
      const r = parseInbound(textEvent());
      expect(r.text).toBe("hello");
      expect(r.files).toEqual([]);
      expect(r.chatId).toBe("oc_chat1");
      expect(r.messageId).toBe("om_test");
      expect(r.senderOpenId).toBe("ou_user1");
      expect(r.senderType).toBe("user");
      expect(r.chatType).toBe("p2p");
    });

    it("strips the bot mention when botOpenId matches", () => {
      const ev = textEvent({
        message: {
          message_id: "om_m",
          chat_id: "oc_g",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hi there" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: BOT_OPEN_ID },
              name: "Bot",
              id_type: "open_id",
            },
          ],
        },
      });
      const r = parseInbound(ev, BOT_OPEN_ID);
      expect(r.text).toBe("hi there");
      expect(r.mentions).toHaveLength(1);
      expect(r.mentions[0]?.isOpenIdOfBot).toBe(true);
    });

    it("replaces non-bot mention placeholders with display names", () => {
      const ev = textEvent({
        message: {
          message_id: "om_m",
          chat_id: "oc_g",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 hey @_user_2" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "ou_bot_123" },
              name: "Bot",
              id_type: "open_id",
            },
            {
              key: "@_user_2",
              id: { open_id: "ou_other" },
              name: "Alice",
              id_type: "open_id",
            },
          ],
        },
      });
      const r = parseInbound(ev, BOT_OPEN_ID);
      expect(r.text).toBe("hey @Alice");
      expect(r.mentions.filter((m) => !m.isOpenIdOfBot)).toHaveLength(1);
    });

    it("marks @all mentions as isAll and rewrites the placeholder", () => {
      const ev = textEvent({
        message: {
          message_id: "om_m",
          chat_id: "oc_g",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 everyone" }),
          mentions: [
            {
              key: "@_user_1",
              id: { open_id: "all" },
              name: "所有人",
              id_type: "open_id",
            },
          ],
        },
      });
      const r = parseInbound(ev);
      expect(r.mentions[0]?.isAll).toBe(true);
      expect(r.text).toBe("@all everyone");
    });

    it("reads chat_type from the message object used by real receive events", () => {
      const ev = textEvent({
        chat_type: undefined,
        message: {
          message_id: "om_group",
          chat_id: "oc_g",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "hello group" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.chatType).toBe("group");
    });
  });

  describe("image", () => {
    it("extracts image_key as an image file part", () => {
      const ev = textEvent({
        message: {
          message_id: "om_img",
          chat_id: "oc_g",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v3_001" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("");
      expect(r.files).toEqual([
        { fileKey: "img_v3_001", mediaType: "image/png", kind: "image" },
      ]);
    });
  });

  describe("file", () => {
    it("extracts file_key and derives mediaType from filename", () => {
      const ev = textEvent({
        message: {
          message_id: "om_file",
          chat_id: "oc_g",
          message_type: "file",
          content: JSON.stringify({ file_key: "file_v3_001", file_name: "report.pdf" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.files).toEqual([
        { fileKey: "file_v3_001", mediaType: "application/pdf", kind: "file" },
      ]);
    });

    it("falls back to application/octet-stream when extension is unknown", () => {
      const ev = textEvent({
        message: {
          message_id: "om_file",
          chat_id: "oc_g",
          message_type: "file",
          content: JSON.stringify({ file_key: "file_v3_002", file_name: "noext" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.files[0]?.mediaType).toBe("application/octet-stream");
    });
  });

  describe("post rich text", () => {
    it("concatenates text blocks from zh_cn content", () => {
      const ev = textEvent({
        message: {
          message_id: "om_post",
          chat_id: "oc_g",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "T",
              content: [
                [{ tag: "text", text: "first" }, { tag: "text", text: "line" }],
                [{ tag: "text", text: "second" }],
              ],
            },
          }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("first line second");
    });

    it("ignores non-text tags but keeps text unbroken", () => {
      const ev = textEvent({
        message: {
          message_id: "om_post",
          chat_id: "oc_g",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "T",
              content: [
                [
                  { tag: "text", text: "see" },
                  { tag: "a", text: "link", href: "https://x" },
                  { tag: "text", text: "here" },
                ],
              ],
            },
          }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("see here");
    });
  });

  describe("threading", () => {
    it("surfaces root_id and parent_id when present", () => {
      const ev = textEvent({
        message: {
          message_id: "om_reply",
          root_id: "om_root",
          parent_id: "om_parent",
          chat_id: "oc_g",
          message_type: "text",
          content: JSON.stringify({ text: "reply" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.rootId).toBe("om_root");
      expect(r.parentId).toBe("om_parent");
    });

    it("returns null rootId and parentId when not threaded", () => {
      const r = parseInbound(textEvent());
      expect(r.rootId).toBeNull();
      expect(r.parentId).toBeNull();
    });
  });

  describe("chat_type", () => {
    it("maps group chat_type", () => {
      const ev = textEvent({ chat_type: "group" });
      expect(parseInbound(ev).chatType).toBe("group");
    });

    it("maps p2p chat_type", () => {
      const ev = textEvent({ chat_type: "p2p" });
      expect(parseInbound(ev).chatType).toBe("p2p");
    });
  });

  describe("sender type", () => {
    it("maps sender_type 'app' for bot echoes", () => {
      const ev = textEvent({
        sender: { sender_id: { open_id: "ou_bot" }, sender_type: "app" },
      });
      expect(parseInbound(ev).senderType).toBe("app");
    });

    it("defaults to user when sender_type is missing", () => {
      const ev = textEvent({ sender: { sender_id: { open_id: "ou_u" } } });
      expect(parseInbound(ev).senderType).toBe("user");
    });
  });

  describe("unsupported message types", () => {
    it("returns empty text and files for audio", () => {
      const ev = textEvent({
        message: {
          message_id: "om_a",
          chat_id: "oc_g",
          message_type: "audio",
          content: JSON.stringify({ file_key: "aud" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("");
      expect(r.files).toEqual([]);
    });

    it("returns empty text and files for media", () => {
      const ev = textEvent({
        message: {
          message_id: "om_v",
          chat_id: "oc_g",
          message_type: "media",
          content: JSON.stringify({ file_key: "vid", file_name: "m.mp4" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("");
      expect(r.files).toEqual([]);
    });

    it("returns empty text and files for sticker", () => {
      const ev = textEvent({
        message: {
          message_id: "om_s",
          chat_id: "oc_g",
          message_type: "sticker",
          content: JSON.stringify({ file_key: "stk" }),
        },
      });
      const r = parseInbound(ev);
      expect(r.text).toBe("");
      expect(r.files).toEqual([]);
    });
  });

  it("carries chat_id from event", () => {
    const r = parseInbound(textEvent());
    expect(r.chatId).toBe("oc_chat1");
  });
});
