import { describe, expect, it, vi } from "vitest";
import {
  StreamingCardController,
} from "../src/streaming-controller.js";
import { LarkApiError } from "../src/errors.js";

interface RecordedCall {
  method:
    | "sendCard"
    | "patchCard"
    | "sendText"
    | "createCardEntity"
    | "sendCardByCardId"
    | "streamCardContent"
    | "setCardStreamingMode"
    | "updateCardKitCard";
  args: unknown;
}

function recordingClient(overrides: Partial<{
  sendCardResult: { messageId: string };
  sendCardShouldFail: boolean;
  streamCardContentError: unknown;
}> = {}): {
  client: unknown;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = {
    async sendCard(args: unknown) {
      calls.push({ method: "sendCard", args });
      if (overrides.sendCardShouldFail) {
        throw new Error("sendCard failed");
      }
      return overrides.sendCardResult ?? { messageId: "om_card_1" };
    },
    async patchCard(args: unknown) {
      calls.push({ method: "patchCard", args });
    },
    async sendText(args: unknown) {
      calls.push({ method: "sendText", args });
      return { messageId: "om_text_1" };
    },
    async createCardEntity(args: unknown) {
      calls.push({ method: "createCardEntity", args });
      return { cardId: "card_1" };
    },
    async sendCardByCardId(args: unknown) {
      calls.push({ method: "sendCardByCardId", args });
      return { messageId: "om_cardkit_1" };
    },
    async streamCardContent(args: unknown) {
      calls.push({ method: "streamCardContent", args });
      if (overrides.streamCardContentError) {
        throw overrides.streamCardContentError;
      }
    },
    async setCardStreamingMode(args: unknown) {
      calls.push({ method: "setCardStreamingMode", args });
    },
    async updateCardKitCard(args: unknown) {
      calls.push({ method: "updateCardKitCard", args });
    },
  };
  return { client, calls };
}

function makeController(client: unknown, overrides: Partial<{
  patchIntervalMs: number;
  createThresholdMs: number;
  useCardKitV2: boolean;
}> = {}) {
  return new StreamingCardController(client as never, {
    chatId: "oc_c",
    rootId: undefined,
    parentId: undefined,
    patchIntervalMs: overrides.patchIntervalMs ?? 10,
    createThresholdMs: overrides.createThresholdMs ?? 10,
    useCardKitV2: overrides.useCardKitV2,
  });
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("StreamingCardController", () => {
  it("creates a card on first delta after the threshold elapses", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client);
      ctrl.appendDelta("hello");
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(11);
      expect(calls.filter((c) => c.method === "sendCard")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles patch calls to patchIntervalMs while streaming", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { patchIntervalMs: 50, createThresholdMs: 5 });

      ctrl.appendDelta("a");
      await vi.advanceTimersByTimeAsync(6); // create card
      expect(calls.filter((c) => c.method === "sendCard")).toHaveLength(1);

      // Rapid deltas
      ctrl.appendDelta("b");
      ctrl.appendDelta("c");
      ctrl.appendDelta("d");
      await flushMicrotasks();
      const patchesAfterDeltas = calls.filter((c) => c.method === "patchCard").length;
      expect(patchesAfterDeltas).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(51);
      const patchesAfterThrottle = calls.filter((c) => c.method === "patchCard").length;
      expect(patchesAfterThrottle).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalize delivers the complete text via patchCard when a card exists", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5 });
      ctrl.appendDelta("partial");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("the full answer");
      const patches = calls.filter((c) => c.method === "patchCard");
      const lastPatch = patches[patches.length - 1];
      const md = (lastPatch?.args as {
        card: { elements: Array<{ tag: string; text?: { content?: string } }> }
      }).card.elements.find((e) => e.tag === "div" && !!e.text);
      expect(md?.text?.content).toContain("the full answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalize creates the card if creation never happened", async () => {
    vi.useRealTimers();
    const { client, calls } = recordingClient();
    const ctrl = makeController(client, { createThresholdMs: 1000 });
    await ctrl.finalize("never streamed, just deliver");
    expect(calls.filter((c) => c.method === "sendCard")).toHaveLength(1);
  });

  it("falls back to sendText when sendCard fails on creation", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient({ sendCardShouldFail: true });
      const ctrl = makeController(client, { createThresholdMs: 5 });
      ctrl.appendDelta("a");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("final answer");
      expect(calls.filter((c) => c.method === "sendText")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setStatus updates the status prefix in the next patch", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, patchIntervalMs: 5 });
      ctrl.appendDelta("x");
      await vi.advanceTimersByTimeAsync(6); // card created
      ctrl.setStatus("Calling tool: foo");
      await vi.advanceTimersByTimeAsync(6);
      const patch = calls
        .filter((c) => c.method === "patchCard")
        .pop();
      const md = (patch?.args as {
        card: { elements: Array<{ tag: string; text?: { content?: string } }> }
      }).card.elements.find((e) => e.tag === "div" && !!e.text);
      expect(md?.text?.content).toContain("Calling tool: foo");
    } finally {
      vi.useRealTimers();
    }
  });

  it("addToolCall renders the tool name in the next patch (and creates the card if idle)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, patchIntervalMs: 5 });
      // No appendDelta — controller is still idle. addToolCall must force a
      // card create so the user sees the tool call before any text.
      ctrl.addToolCall("get_weather");
      await vi.advanceTimersByTimeAsync(6); // create timer fires
      const create = calls.find((c) => c.method === "sendCard");
      const md = (create?.args as {
        card: { elements: Array<{ tag: string; text?: { content?: string } }> }
      }).card.elements.find((e) => e.tag === "div" && !!e.text);
      expect(md?.text?.content).toContain("⏳ get_weather");
    } finally {
      vi.useRealTimers();
    }
  });

  it("completeToolCall marks the running entry as done/failed (visible ✓ or ✗)", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, patchIntervalMs: 5 });
      ctrl.addToolCall("bash");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta("running…");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.completeToolCall("bash");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.addToolCall("fail_tool");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.completeToolCall("fail_tool", true);
      await vi.advanceTimersByTimeAsync(6);

      const lastPatch = calls.filter((c) => c.method === "patchCard").pop();
      const md = (lastPatch?.args as {
        card: { elements: Array<{ tag: string; text?: { content?: string } }> }
      }).card.elements.find((e) => e.tag === "div" && !!e.text);
      expect(md?.text?.content).toContain("✓ bash");
      expect(md?.text?.content).toContain("✗ fail_tool");
      // Tool history persists — neither entry was removed.
      expect(ctrl.getToolCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores duplicate addToolCall while a same-named tool is still running", () => {
    const { client } = recordingClient();
    const ctrl = makeController(client, { createThresholdMs: 5, patchIntervalMs: 5 });
    ctrl.addToolCall("bash");
    ctrl.addToolCall("bash"); // duplicate
    expect(ctrl.getToolCalls()).toHaveLength(1);
  });

  it("abort patches the existing card with an error when one exists", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5 });
      ctrl.appendDelta("partial");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.abort("turn failed");
      const lastPatch = calls.filter((c) => c.method === "patchCard").pop();
      const md = (lastPatch?.args as {
        card: { elements: Array<{ tag: string; text?: { content?: string } }> }
      }).card.elements.find((e) => e.tag === "div" && !!e.text);
      expect(md?.text?.content).toContain("turn failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalize is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5 });
      ctrl.appendDelta("partial");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("done");
      const firstCount = calls.length;
      await ctrl.finalize("done again");
      await ctrl.finalize("again");
      expect(calls.length).toBe(firstCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensureFinalized is safe to call multiple times and after finalize", async () => {
    vi.useRealTimers();
    const { client, calls } = recordingClient();
    const ctrl = makeController(client, { createThresholdMs: 5 });
    await ctrl.finalize("done");
    const after1 = calls.length;
    await ctrl.ensureFinalized();
    await ctrl.ensureFinalized();
    expect(calls.length).toBe(after1);
  });

  it("passes root_id and parent_id to sendCard when supplied", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = new StreamingCardController(client as never, {
        chatId: "oc_c",
        rootId: "om_root",
        parentId: "om_parent",
        patchIntervalMs: 10,
        createThresholdMs: 5,
      });
      ctrl.appendDelta("x");
      await vi.advanceTimersByTimeAsync(6);
      const send = calls.find((c) => c.method === "sendCard");
      expect((send?.args as { rootId?: string; parentId?: string }).rootId).toBe("om_root");
      expect((send?.args as { rootId?: string; parentId?: string }).parentId).toBe("om_parent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 creates a CardKit entity and sends the IM message by card_id", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, useCardKitV2: true });

      ctrl.appendDelta("hello");
      await vi.advanceTimersByTimeAsync(6);

      expect(calls.map((c) => c.method)).toEqual(["createCardEntity", "sendCardByCardId"]);
      expect(calls[1]!.args).toMatchObject({ chatId: "oc_c", cardId: "card_1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 streams patch content via CardKit element content sequence", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, {
        createThresholdMs: 5,
        patchIntervalMs: 5,
        useCardKitV2: true,
      });

      ctrl.appendDelta("a");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta("b");
      await vi.advanceTimersByTimeAsync(6);

      const stream = calls.find((c) => c.method === "streamCardContent");
      expect(stream?.args).toMatchObject({
        cardId: "card_1",
        content: "ab",
        sequence: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops intermediate CardKit streaming after an unavailable-message error", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient({
        streamCardContentError: new LarkApiError("Unavailable message", {
          code: 230099,
          body: { code: 230099, msg: "Unavailable message" },
        }),
      });
      const ctrl = makeController(client, {
        createThresholdMs: 5,
        patchIntervalMs: 5,
        useCardKitV2: true,
      });

      ctrl.appendDelta("hello");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta(" patch one");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta(" patch two");
      await vi.advanceTimersByTimeAsync(6);

      expect(calls.filter((c) => c.method === "streamCardContent")).toHaveLength(1);
      await ctrl.finalize("final");
      expect(calls.some((c) => c.method === "setCardStreamingMode")).toBe(true);
      expect(calls.some((c) => c.method === "updateCardKitCard")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders footer metrics on the terminal CardKit card", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, useCardKitV2: true });
      ctrl.setFooterMetrics({
        elapsedMs: 1234,
        tokens: 456,
        cachedTokens: 78,
        contextTokens: 9000,
        model: "gpt-5",
      });

      ctrl.appendDelta("hello");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("final");

      const terminal = calls.find((c) => c.method === "updateCardKitCard");
      const body = JSON.stringify((terminal?.args as { card?: unknown }).card);
      expect(body).toContain("Elapsed 1.2s");
      expect(body).toContain("Tokens 456");
      expect(body).toContain("Cache 78");
      expect(body).toContain("Context 9000");
      expect(body).toContain("gpt-5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 closes streaming mode before updating the terminal card", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, useCardKitV2: true });

      ctrl.appendDelta("partial");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("final answer");

      const terminalMethods = calls
        .filter((c) => c.method === "setCardStreamingMode" || c.method === "updateCardKitCard")
        .map((c) => c.method);
      expect(terminalMethods).toEqual(["setCardStreamingMode", "updateCardKitCard"]);
      expect(calls.find((c) => c.method === "setCardStreamingMode")?.args).toMatchObject({
        cardId: "card_1",
        streamingMode: false,
        sequence: 2,
      });
      expect(calls.find((c) => c.method === "updateCardKitCard")?.args).toMatchObject({
        cardId: "card_1",
        sequence: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 skips rate-limited CardKit frames without disabling terminal CardKit update", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient({
        streamCardContentError: new LarkApiError("rate limited", { code: 230020, body: { code: 230020 } }),
      });
      const ctrl = makeController(client, {
        createThresholdMs: 5,
        patchIntervalMs: 5,
        useCardKitV2: true,
      });

      ctrl.appendDelta("a");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta("b");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("final answer");

      expect(calls.some((c) => c.method === "streamCardContent")).toBe(true);
      expect(calls.some((c) => c.method === "patchCard")).toBe(false);
      expect(calls.map((c) => c.method)).toContain("setCardStreamingMode");
      expect(calls.map((c) => c.method)).toContain("updateCardKitCard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 disables intermediate CardKit streaming on table-limit errors but keeps final card update", async () => {
    vi.useFakeTimers();
    try {
      const tableLimitError = new LarkApiError("Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit", {
        code: 230099,
        body: { code: 230099, msg: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: card table number over limit" },
      });
      const { client, calls } = recordingClient({ streamCardContentError: tableLimitError });
      const ctrl = makeController(client, {
        createThresholdMs: 5,
        patchIntervalMs: 5,
        useCardKitV2: true,
      });

      ctrl.appendDelta("|a|\n|-|\n|b|");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta("\n\n|c|\n|-|\n|d|");
      await vi.advanceTimersByTimeAsync(6);
      ctrl.appendDelta("\n\nlater text");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("final answer");

      expect(calls.filter((c) => c.method === "streamCardContent")).toHaveLength(1);
      expect(calls.some((c) => c.method === "patchCard")).toBe(false);
      expect(calls.map((c) => c.method)).toContain("setCardStreamingMode");
      expect(calls.map((c) => c.method)).toContain("updateCardKitCard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("streaming-v2 separates reasoning tags from the final answer card", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = recordingClient();
      const ctrl = makeController(client, { createThresholdMs: 5, useCardKitV2: true });

      ctrl.appendDelta("<think>inspect context</think>visible answer");
      await vi.advanceTimersByTimeAsync(6);
      await ctrl.finalize("<think>inspect context</think>visible answer");

      const update = calls.find((c) => c.method === "updateCardKitCard");
      const card = (update?.args as {
        card?: { body?: { elements?: Array<{ tag: string; content?: string }> } };
      }).card;
      const markdown = card?.body?.elements?.filter((e) => e.tag === "markdown").map((e) => e.content ?? "").join("\n") ?? "";
      expect(markdown).toContain("inspect context");
      expect(markdown).toContain("visible answer");
      expect(markdown).not.toContain("<think>");
    } finally {
      vi.useRealTimers();
    }
  });
});
