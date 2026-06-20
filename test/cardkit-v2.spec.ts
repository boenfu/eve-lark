import { describe, expect, it } from "vitest";
import { buildCardKitStreamingCard, buildCardKitFinalCard } from "../src/card.js";
import type { ToolCallEntry } from "../src/card.js";

describe("CardKit v2 card builders", () => {
  describe("buildCardKitStreamingCard", () => {
    it("uses schema 2.0 with body.elements and config.streaming_mode", () => {
      const card = buildCardKitStreamingCard({ buffer: "hello", streamingMode: true });
      expect(card).toMatchObject({
        schema: "2.0",
        config: { streaming_mode: true, wide_screen_mode: true },
        body: {
          elements: expect.arrayContaining([
            expect.objectContaining({ tag: "markdown" }),
          ]),
        },
      });
    });

    it("renders the buffer in a markdown element (v2 native-size default)", () => {
      const card = buildCardKitStreamingCard({ buffer: "partial answer", streamingMode: true });
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      expect(md?.content).toContain("partial answer");
    });

    it("includes status prefix when provided", () => {
      const card = buildCardKitStreamingCard({
        buffer: "answer",
        status: "🔧 bash",
        streamingMode: true,
      });
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      expect(md?.content).toContain("🔧 bash");
      expect(md?.content).toContain("answer");
    });

    it("renders placeholder when buffer is empty", () => {
      const card = buildCardKitStreamingCard({ buffer: "", streamingMode: true });
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      expect(md?.content).toContain("…");
    });

    it("sets streaming_mode to false for final card", () => {
      const card = buildCardKitStreamingCard({ buffer: "done", streamingMode: false });
      expect(card.config.streaming_mode).toBe(false);
    });

    it("renders tool-call history above the buffer when provided", () => {
      const toolCalls: ToolCallEntry[] = [
        { name: "get_weather", state: "done" },
        { name: "bash", state: "running" },
        { name: "fail_tool", state: "failed" },
      ];
      const card = buildCardKitStreamingCard({
        buffer: "the answer",
        streamingMode: true,
        toolCalls,
      });
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      const content = md?.content ?? "";
      // Done = green ✓, running = blue ⏳, failed = red ✗
      expect(content).toContain("✓ get_weather");
      expect(content).toContain("⏳ bash");
      expect(content).toContain("✗ fail_tool");
      // Tool lines appear BEFORE the buffer (split by the \n\n joiner)
      const parts = content.split("\n\n");
      const toolIdx = parts.findIndex((p) => p.includes("get_weather"));
      const bufIdx = parts.findIndex((p) => p.includes("the answer"));
      expect(toolIdx).toBeLessThan(bufIdx);
    });
  });

  describe("buildCardKitFinalCard", () => {
    it("produces a non-streaming card with the full text", () => {
      const card = buildCardKitFinalCard("the complete answer");
      expect(card.schema).toBe("2.0");
      expect(card.config.streaming_mode).toBe(false);
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      expect(md?.content).toContain("the complete answer");
    });

    it("renders tool history above the final text when provided", () => {
      const card = buildCardKitFinalCard("done", [
        { name: "bash", state: "done" },
      ]);
      const md = card.body.elements.find(
        (e: unknown) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "markdown",
      ) as { content?: string } | undefined;
      expect(md?.content).toContain("✓ bash");
      expect(md?.content).toContain("done");
    });
  });
});
