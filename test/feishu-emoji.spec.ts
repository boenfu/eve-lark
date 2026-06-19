import { describe, expect, it } from "vitest";
import { VALID_FEISHU_EMOJI_TYPES, isValidFeishuEmojiType } from "../src/feishu-emoji.js";

describe("VALID_FEISHU_EMOJI_TYPES", () => {
  it("includes the camelCase 'Typing' (the bug-fix value)", () => {
    expect(VALID_FEISHU_EMOJI_TYPES.has("Typing")).toBe(true);
  });

  it("does NOT include all-caps 'TYPING' (case-sensitive)", () => {
    expect(VALID_FEISHU_EMOJI_TYPES.has("TYPING")).toBe(false);
  });

  it("includes common stable types", () => {
    expect(VALID_FEISHU_EMOJI_TYPES.has("THUMBSUP")).toBe(true);
    expect(VALID_FEISHU_EMOJI_TYPES.has("HEART")).toBe(true);
    expect(VALID_FEISHU_EMOJI_TYPES.has("OK")).toBe(true);
    expect(VALID_FEISHU_EMOJI_TYPES.has("PARTY")).toBe(true);
  });

  it("excludes plausible-looking but invalid types", () => {
    expect(VALID_FEISHU_EMOJI_TYPES.has("EYES")).toBe(false); // only EYESCLOSED exists
    expect(VALID_FEISHU_EMOJI_TYPES.has("ROCKET")).toBe(false);
    expect(VALID_FEISHU_EMOJI_TYPES.has("thumbsup")).toBe(false); // lowercase
  });
});

describe("isValidFeishuEmojiType", () => {
  it("returns true for valid types", () => {
    expect(isValidFeishuEmojiType("Typing")).toBe(true);
    expect(isValidFeishuEmojiType("THUMBSUP")).toBe(true);
  });

  it("returns false for invalid types (including case-mismatches)", () => {
    expect(isValidFeishuEmojiType("TYPING")).toBe(false);
    expect(isValidFeishuEmojiType("typing")).toBe(false);
    expect(isValidFeishuEmojiType("BOGUS")).toBe(false);
    expect(isValidFeishuEmojiType("")).toBe(false);
  });
});
