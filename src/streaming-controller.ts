import { buildErrorCard, buildStreamingCard, buildTextCard } from "./card.js";
import type { LarkCard } from "./types.js";

type State = "idle" | "creating" | "streaming" | "completed" | "aborted";

interface ControllerDeps {
  chatId: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
  patchIntervalMs: number;
  createThresholdMs: number;
}

interface LarkClientLike {
  sendCard(args: {
    chatId: string;
    card: LarkCard;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }>;
  patchCard(args: { messageId: string; card: LarkCard }): Promise<void>;
  sendText(args: {
    chatId: string;
    content: string;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }>;
}

/**
 * Streaming interactive-card state machine.
 *
 *   idle ──first delta──> creating ──sendCard ok──> streaming ──finalize──> completed
 *                            │
 *                            └──sendCard fail──> aborted (flag; static fallback on message.completed)
 *
 * The card is created lazily after `createThresholdMs` of the first delta, so
 * short turns can short-circuit straight to `finalize` (which sends the card
 * with the full answer in one shot). Once streaming, patches are throttled to
 * `patchIntervalMs`.
 *
 * If `sendCard` fails on creation, the controller flips to `fallbackToText`
 * and `finalize`/`ensureFinalized` deliver via `sendText` instead.
 */
export class StreamingCardController {
  private readonly deps: ControllerDeps;
  private readonly client: LarkClientLike;

  private state: State = "idle";
  private buffer = "";
  private status: string | undefined;
  private messageId: string | undefined;
  private fallbackToText = false;

  private createTimer: ReturnType<typeof setTimeout> | null = null;
  private patchTimer: ReturnType<typeof setTimeout> | null = null;
  private patchInFlight: Promise<void> | null = null;
  private patchScheduled = false;
  private lastPatchAt = 0;

  constructor(client: LarkClientLike, deps: ControllerDeps) {
    this.client = client;
    this.deps = deps;
  }

  appendDelta(text: string): void {
    if (this.state === "completed" || this.state === "aborted") return;
    this.buffer += text;
    if (this.state === "idle") {
      this.scheduleCreate();
    } else if (this.state === "streaming") {
      this.schedulePatch();
    }
  }

  setStatus(status: string): void {
    if (this.state === "completed" || this.state === "aborted") return;
    this.status = status;
    if (this.state === "streaming") {
      this.schedulePatch();
    }
  }

  async finalize(fullText: string): Promise<void> {
    if (this.state === "completed" || this.state === "aborted") return;
    this.cancelCreateTimer();
    this.cancelPatchTimer();
    this.buffer = fullText;

    if (this.fallbackToText) {
      await this.client.sendText({
        chatId: this.deps.chatId,
        content: fullText,
        rootId: this.deps.rootId,
        parentId: this.deps.parentId,
      });
      this.state = "completed";
      return;
    }

    if (this.messageId === undefined) {
      // Never managed to create a card. Send one with the full text in a
      // single shot so the user still gets a card reply.
      try {
        const res = await this.client.sendCard({
          chatId: this.deps.chatId,
          card: buildTextCard(fullText),
          rootId: this.deps.rootId,
          parentId: this.deps.parentId,
        });
        this.messageId = res.messageId;
        this.state = "completed";
      } catch {
        // Last-resort fallback: plain text.
        this.fallbackToText = true;
        await this.client.sendText({
          chatId: this.deps.chatId,
          content: fullText,
          rootId: this.deps.rootId,
          parentId: this.deps.parentId,
        });
        this.state = "completed";
      }
      return;
    }

    // Card already exists; flush the final state.
    if (this.patchInFlight) {
      try {
        await this.patchInFlight;
      } catch {
        // swallow; we'll attempt the final patch below
      }
    }
    await this.client.patchCard({
      messageId: this.messageId,
      card: buildStreamingCard({ buffer: fullText, status: undefined }),
    });
    this.state = "completed";
  }

  async abort(error: string): Promise<void> {
    if (this.state === "completed" || this.state === "aborted") return;
    this.cancelCreateTimer();
    this.cancelPatchTimer();
    if (this.messageId === undefined) {
      // No card to patch; mark fallback and let finalize/ensureFinalized
      // deliver a plain-text error if asked.
      this.fallbackToText = true;
      this.state = "aborted";
      return;
    }
    try {
      await this.client.patchCard({
        messageId: this.messageId,
        card: buildErrorCard(error),
      });
    } finally {
      this.state = "aborted";
    }
  }

  async ensureFinalized(): Promise<void> {
    if (this.state !== "completed" && this.state !== "aborted") {
      await this.finalize(this.buffer);
    }
  }

  isStreaming(): boolean {
    return this.state === "streaming" || this.state === "creating";
  }

  isCompleted(): boolean {
    return this.state === "completed" || this.state === "aborted";
  }

  private scheduleCreate(): void {
    if (this.createTimer) return;
    this.state = "creating";
    this.createTimer = setTimeout(() => {
      this.createTimer = null;
      void this.doCreate();
    }, this.deps.createThresholdMs);
  }

  private cancelCreateTimer(): void {
    if (this.createTimer) {
      clearTimeout(this.createTimer);
      this.createTimer = null;
    }
  }

  private async doCreate(): Promise<void> {
    if (this.state !== "creating") return;
    try {
      const res = await this.client.sendCard({
        chatId: this.deps.chatId,
        card: buildStreamingCard({ buffer: this.buffer, status: this.status }),
        rootId: this.deps.rootId,
        parentId: this.deps.parentId,
      });
      this.messageId = res.messageId;
      this.state = "streaming";
      this.lastPatchAt = Date.now();
    } catch (e) {
      console.warn(
        "[eve-lark] streaming card create failed; will deliver via plain text on finalize:",
        e instanceof Error ? e.message : e,
      );
      this.fallbackToText = true;
      this.state = "streaming"; // keep accepting deltas; finalize will deliver as text
    }
  }

  private schedulePatch(): void {
    if (this.patchScheduled) return;
    this.patchScheduled = true;
    const elapsed = Date.now() - this.lastPatchAt;
    const wait = Math.max(0, this.deps.patchIntervalMs - elapsed);
    this.patchTimer = setTimeout(() => {
      this.patchTimer = null;
      this.patchScheduled = false;
      void this.maybeFlushPatch();
    }, wait);
  }

  private cancelPatchTimer(): void {
    if (this.patchTimer) {
      clearTimeout(this.patchTimer);
      this.patchTimer = null;
    }
    this.patchScheduled = false;
  }

  private async maybeFlushPatch(): Promise<void> {
    if (this.state !== "streaming") return;
    if (this.patchInFlight) return;
    if (this.messageId === undefined) return;
    const card = buildStreamingCard({ buffer: this.buffer, status: this.status });
    this.patchInFlight = this.client
      .patchCard({ messageId: this.messageId, card })
      .catch((e) => {
        // Best-effort: the next delta will retry. Log so operators can see
        // when the card stream is degraded.
        console.warn(
          "[eve-lark] streaming card patch failed:",
          e instanceof Error ? e.message : e,
        );
      })
      .finally(() => {
        this.patchInFlight = null;
        this.lastPatchAt = Date.now();
      });
    await this.patchInFlight;
  }
}
