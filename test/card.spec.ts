import { describe, expect, it } from "vitest";
import { buildStreamingCard, buildTextCard, buildErrorCard } from "../src/card.js";

/** Helper: pull the lark_md content out of a div element. */
function divLarkMdContent(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const e = el as { tag?: string; text?: { tag?: string; content?: string } };
  if (e.tag !== "div") return undefined;
  if (e.text?.tag !== "lark_md") return undefined;
  return e.text.content;
}

describe("buildTextCard", () => {
  it("wraps text in a div+lark_md element (larger font than bare markdown)", () => {
    const card = buildTextCard("hello");
    expect(card.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(card.elements).toHaveLength(1);
    expect(card.elements[0]).toEqual({
      tag: "div",
      text: { tag: "lark_md", content: "hello" },
    });
  });
});

describe("buildStreamingCard", () => {
  it("renders a placeholder status with no buffered text", () => {
    const card = buildStreamingCard({ buffer: "", status: "Thinking…" });
    const content = card.elements.map(divLarkMdContent).find((c) => c !== undefined);
    expect(content).toContain("Thinking");
  });

  it("renders the buffered text when present", () => {
    const card = buildStreamingCard({ buffer: "partial answer", status: undefined });
    const content = card.elements.map(divLarkMdContent).find((c) => c !== undefined);
    expect(content).toContain("partial answer");
  });

  it("combines status and buffer when both are present", () => {
    const card = buildStreamingCard({ buffer: "text", status: "Calling tool: foo" });
    const content = card.elements.map(divLarkMdContent).find((c) => c !== undefined);
    expect(content).toContain("Calling tool: foo");
    expect(content).toContain("text");
  });

  it("renders tool-call history above the buffer when provided", () => {
    const card = buildStreamingCard({
      buffer: "the answer",
      toolCalls: [
        { name: "get_weather", state: "done" },
        { name: "bash", state: "running" },
        { name: "fail_tool", state: "failed" },
      ],
    });
    const content = card.elements.map(divLarkMdContent).find((c) => c !== undefined) ?? "";
    expect(content).toContain("✓ get_weather");
    expect(content).toContain("⏳ bash");
    expect(content).toContain("✗ fail_tool");
    // Tool lines appear BEFORE the buffer
    const toolIdx = content.indexOf("get_weather");
    const bufIdx = content.indexOf("the answer");
    expect(toolIdx).toBeLessThan(bufIdx);
  });

  it("omits the tool line when toolCalls is empty or undefined", () => {
    const noTools = buildStreamingCard({ buffer: "x", toolCalls: [] });
    const noToolsContent = noTools.elements.map(divLarkMdContent).find((c) => c !== undefined) ?? "";
    expect(noToolsContent).not.toContain("✓");
    expect(noToolsContent).not.toContain("⏳");
    expect(noToolsContent).not.toContain("✗");

    const undefinedTools = buildStreamingCard({ buffer: "x" });
    const undefinedContent = undefinedTools.elements.map(divLarkMdContent).find((c) => c !== undefined) ?? "";
    expect(undefinedContent).not.toContain("✓");
  });
});

describe("buildErrorCard", () => {
  it("renders the error message in the card", () => {
    const card = buildErrorCard("turn failed: x");
    const content = card.elements.map(divLarkMdContent).find((c) => c !== undefined);
    expect(content).toContain("turn failed: x");
  });
});
