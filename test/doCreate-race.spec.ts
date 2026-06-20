import { describe, expect, it, vi } from "vitest";
import { StreamingCardController } from "../src/streaming-controller.js";

describe("doCreate/finalize race condition", () => {
  it("finalize waits for in-flight doCreate — only 1 sendCard, then patch", async () => {
    vi.useFakeTimers();
    try {
      const sendCardCalls: number[] = [];
      const patchCalls: string[] = [];
      let resolveSendCard!: (v: { messageId: string }) => void;
      const pendingSendCard = new Promise<{ messageId: string }>((r) => { resolveSendCard = r; });

      const client = {
        async sendCard() {
          sendCardCalls.push(sendCardCalls.length);
          return pendingSendCard; // doCreate awaits this — not resolved yet
        },
        async patchCard(args: { messageId: string }) {
          patchCalls.push(args.messageId);
        },
        async sendText() {
          return { messageId: "om_text" };
        },
      };

      const ctrl = new StreamingCardController(client, {
        chatId: "oc_test",
        patchIntervalMs: 5,
        createThresholdMs: 5,
      });

      // 1) delta → scheduleCreate (5ms timer)
      ctrl.appendDelta("partial");

      // 2) advance timer → doCreate starts, awaits sendCard (not resolved)
      await vi.advanceTimersByTimeAsync(10);
      expect(ctrl.getMessageId()).toBeUndefined(); // doCreate still in-flight

      // 3) finalize fires (message.completed) BEFORE doCreate resolves
      const finalizePromise = ctrl.finalize("full reply text");

      // 4) now resolve sendCard → doCreate completes, sets messageId
      resolveSendCard({ messageId: "om_card_A" });
      await vi.advanceTimersByTimeAsync(0);

      // 5) finalize should now see messageId (patch, not 2nd sendCard)
      await finalizePromise;

      // Assert: exactly 1 sendCard (doCreate), then patch on same card.
      // Pre-fix: finalize doesn't wait → reads messageId=undefined → 2nd sendCard (FAIL).
      expect(sendCardCalls).toHaveLength(1);
      expect(patchCalls).toContain("om_card_A");
    } finally {
      vi.useRealTimers();
    }
  });
});
