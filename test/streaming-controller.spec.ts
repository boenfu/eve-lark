import { describe, expect, it, vi } from "vitest";
import {
  StreamingCardController,
} from "../src/streaming-controller.js";

interface RecordedCall {
  method: "sendCard" | "patchCard" | "sendText";
  args: unknown;
}

function recordingClient(overrides: Partial<{
  sendCardResult: { messageId: string };
  sendCardShouldFail: boolean;
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
  };
  return { client, calls };
}

function makeController(client: unknown, overrides: Partial<{
  patchIntervalMs: number;
  createThresholdMs: number;
}> = {}) {
  return new StreamingCardController(client as never, {
    chatId: "oc_c",
    rootId: undefined,
    parentId: undefined,
    patchIntervalMs: overrides.patchIntervalMs ?? 10,
    createThresholdMs: overrides.createThresholdMs ?? 10,
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
});
