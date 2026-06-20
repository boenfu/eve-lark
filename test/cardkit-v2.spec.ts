import { describe, expect, it } from "vitest";
import { buildCardKitStreamingCard, buildCardKitFinalCard } from "../src/card.js";

describe("CardKit v2 card builders", () => {
  describe("buildCardKitStreamingCard", () => {
    it("uses schema 2.0 with body.elements and config.streaming_mode", () => {
      const card = buildCardKitStreamingCard({ buffer: "hello", streamingMode: true });
      expect(card).toMatchObject({
        schema: "2.0",
        config: { streaming_mode: true, wide_screen_mode: true },
        body: {
          elements: expect.arrayContaining([
            expect.objectContaining({ tag: "div" }),
          ]),
        },
      });
    });

    it("renders the buffer in a div+lark_md element", () => {
      const card = buildCardKitStreamingCard({ buffer: "partial answer", streamingMode: true });
      const div = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "div",
      ) as { text?: { content?: string } } | undefined;
      expect(div?.text?.content).toContain("partial answer");
    });

    it("includes status prefix when provided", () => {
      const card = buildCardKitStreamingCard({
        buffer: "answer",
        status: "🔧 bash",
        streamingMode: true,
      });
      const div = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "div",
      ) as { text?: { content?: string } } | undefined;
      expect(div?.text?.content).toContain("🔧 bash");
      expect(div?.text?.content).toContain("answer");
    });

    it("renders placeholder when buffer is empty", () => {
      const card = buildCardKitStreamingCard({ buffer: "", streamingMode: true });
      const div = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "div",
      ) as { text?: { content?: string } } | undefined;
      expect(div?.text?.content).toContain("…");
    });

    it("sets streaming_mode to false for final card", () => {
      const card = buildCardKitStreamingCard({ buffer: "done", streamingMode: false });
      expect(card.config.streaming_mode).toBe(false);
    });
  });

  describe("buildCardKitFinalCard", () => {
    it("produces a non-streaming card with the full text", () => {
      const card = buildCardKitFinalCard("the complete answer");
      expect(card.schema).toBe("2.0");
      expect(card.config.streaming_mode).toBe(false);
      const div = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "div",
      ) as { text?: { content?: string } } | undefined;
      expect(div?.text?.content).toContain("the complete answer");
    });
  });
});
