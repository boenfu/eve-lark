import { describe, expect, it } from "vitest";
import {
  BotLoopGuard,
  ChatTaskQueue,
  isAbortText,
  isEventExpired,
  isEventOwnedByApp,
  parseReactionCreatedEvent,
} from "../src/event-policy.js";

describe("event policy helpers", () => {
  it("validates app ownership when Feishu sends header.app_id", () => {
    expect(isEventOwnedByApp({ app_id: "cli_a" }, "cli_a")).toBe(true);
    expect(isEventOwnedByApp({ app_id: "cli_other" }, "cli_a")).toBe(false);
    expect(isEventOwnedByApp({}, "cli_a")).toBe(true);
  });

  it("drops events older than the configured ttl", () => {
    const now = Date.parse("2026-06-20T10:00:00.000Z");
    expect(isEventExpired({ create_time: String(now / 1000) }, now, 10_000)).toBe(false);
    expect(isEventExpired({ create_time: String((now - 30_000) / 1000) }, now, 10_000)).toBe(true);
    expect(isEventExpired({ create_time: String(now - 30_000) }, now, 10_000)).toBe(true);
    expect(isEventExpired({}, now, 10_000)).toBe(false);
  });

  it("recognizes explicit abort text without matching ordinary sentences", () => {
    expect(isAbortText("/stop")).toBe(true);
    expect(isAbortText("停止")).toBe(true);
    expect(isAbortText("please stop")).toBe(true);
    expect(isAbortText("can you stop by tomorrow?")).toBe(false);
  });

  it("serializes tasks for the same chat key", async () => {
    const queue = new ChatTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue("chat:1", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = queue.enqueue("chat:1", async () => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("tracks bot-loop pressure and resets after a human message", () => {
    const guard = new BotLoopGuard({ maxBotTurns: 2 });

    expect(guard.record("chat:1", "app")).toBe(false);
    expect(guard.record("chat:1", "app")).toBe(false);
    expect(guard.record("chat:1", "app")).toBe(true);
    expect(guard.record("chat:1", "user")).toBe(false);
    expect(guard.record("chat:1", "app")).toBe(false);
  });

  it("normalizes reaction.created events into synthetic text input", () => {
    const parsed = parseReactionCreatedEvent({
      message_id: "om_reacted",
      chat_id: "oc_chat",
      chat_type: "group",
      reaction_type: { emoji_type: "THUMBSUP" },
      user_id: { open_id: "ou_user" },
      operator_type: "user",
    });

    expect(parsed).toEqual({
      sourceMessageId: "om_reacted",
      chatId: "oc_chat",
      chatType: "group",
      messageId: "om_reacted:reaction:THUMBSUP:ou_user",
      senderOpenId: "ou_user",
      text: "[reacted with THUMBSUP to message om_reacted]",
      rootId: null,
      parentId: null,
    });
  });

  it("skips unsafe or unroutable reaction.created events", () => {
    expect(parseReactionCreatedEvent({
      message_id: "om_1",
      reaction_type: { emoji_type: "Typing" },
      user_id: { open_id: "ou_user" },
    })).toBeNull();
    expect(parseReactionCreatedEvent({
      message_id: "om_1",
      reaction_type: { emoji_type: "THUMBSUP" },
      user_id: { open_id: "ou_bot" },
      operator_type: "app",
      chat_id: "oc_chat",
    })).toBeNull();
    const unresolved = parseReactionCreatedEvent({
      message_id: "om_1",
      reaction_type: { emoji_type: "THUMBSUP" },
      user_id: { open_id: "ou_user" },
    });
    expect(unresolved).toMatchObject({
      sourceMessageId: "om_1",
      chatId: null,
      chatType: null,
    });
  });
});
