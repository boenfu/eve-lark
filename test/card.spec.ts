import { describe, expect, it } from "vitest";
import { buildStreamingCard, buildTextCard, buildErrorCard } from "../src/card.js";

describe("buildTextCard", () => {
  it("wraps text in a single markdown element", () => {
    const card = buildTextCard("hello");
    expect(card.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(card.elements).toHaveLength(1);
    expect(card.elements[0]).toEqual({ tag: "markdown", content: "hello" });
  });
});

describe("buildStreamingCard", () => {
  it("renders a placeholder status with no buffered text", () => {
    const card = buildStreamingCard({ buffer: "", status: "Thinking…" });
    const md = card.elements.find(
      (e): e is { tag: "markdown"; content: string } =>
        "tag" in e && e.tag === "markdown",
    );
    expect(md?.content).toContain("Thinking");
  });

  it("renders the buffered text when present", () => {
    const card = buildStreamingCard({ buffer: "partial answer", status: undefined });
    const md = card.elements.find(
      (e): e is { tag: "markdown"; content: string } =>
        "tag" in e && e.tag === "markdown",
    );
    expect(md?.content).toContain("partial answer");
  });

  it("combines status and buffer when both are present", () => {
    const card = buildStreamingCard({ buffer: "text", status: "Calling tool: foo" });
    const md = card.elements.find(
      (e): e is { tag: "markdown"; content: string } =>
        "tag" in e && e.tag === "markdown",
    );
    expect(md?.content).toContain("Calling tool: foo");
    expect(md?.content).toContain("text");
  });
});

describe("buildErrorCard", () => {
  it("renders the error message in the card", () => {
    const card = buildErrorCard("turn failed: x");
    const md = card.elements.find(
      (e): e is { tag: "markdown"; content: string } =>
        "tag" in e && e.tag === "markdown",
    );
    expect(md?.content).toContain("turn failed: x");
  });
});
