import {
  buildCardKitFinalCard,
  buildCardKitStreamingCard,
  buildErrorCard,
  buildStreamingCard,
  buildTextCard,
} from "./card.js";
import type { LarkInputRequest } from "./types.js";

type State = "idle" | "creating" | "streaming" | "completed" | "aborted";

/**
 * One tool call's renderable state. Tracked across the turn so the user can
 * see what the agent did, not just the final text. Persistent: a fast tool
 * that completes between patches still shows up because we accumulate rather
 * than overwrite.
 */
export interface ToolCallEntry {
  name: string;
  state: "running" | "done" | "failed";
}

interface ControllerDeps {
  chatId: string;
  rootId?: string | undefined;
  parentId?: string | undefined;
  patchIntervalMs: number;
  createThresholdMs: number;
  /** When true, use CardKit v2 schema (schema 2.0 + streaming_mode) instead
   *  of v1 interactive cards. Better font size, slightly different API path. */
  useCardKitV2?: boolean | undefined;
}

interface LarkClientLike {
  sendCard(args: {
    chatId: string;
    card: unknown;
    rootId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }>;
  patchCard(args: { messageId: string; card: unknown }): Promise<void>;
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
  /** Active HITL input request, when set via `setAskRequest`. The card
   *  builder appends prompt + buttons to the same streaming card so the
   *  user can answer inline instead of getting a separate ask-card. */
  private askRequest: LarkInputRequest | null = null;
  /** Tool calls made during this turn, in order. Rendered above the buffer
   *  so users can see what the agent is doing / has done, Claude-Code-style. */
  private toolCalls: ToolCallEntry[] = [];

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

  /**
   * Record the start of a tool call. Renders as `🔧 name` (or `⏳ name` while
   * running). Persistent across patches — won't be lost if the tool completes
   * between throttled patches.
   *
   * Schedules a patch regardless of state (idle/creating/streaming) so the
   * user sees the call even when no text has streamed yet, which is the
   * common case (model often calls a tool before any visible output).
   */
  addToolCall(name: string): void {
    if (this.state === "completed" || this.state === "aborted") return;
    // Don't add a duplicate running entry for the same name (some tools
    // batch-call with the same name in one actions.requested event).
    if (this.toolCalls.some((t) => t.name === name && t.state === "running")) {
      return;
    }
    this.toolCalls.push({ name, state: "running" });
    // Kick the create if we're idle (so the card appears showing the tool
    // call before any text delta). Otherwise patch.
    if (this.state === "idle") {
      this.scheduleCreate();
    } else if (this.state === "streaming") {
      this.schedulePatch();
    }
  }

  /**
   * Mark the most-recently-started running entry for `name` as done/failed.
   * Rendered as `✓ name` (green) or `✗ name` (red). Stays visible — the
   * entry is not removed, so the user sees the full tool history at the
   * end of the turn.
   */
  completeToolCall(name: string, failed = false): void {
    for (let i = this.toolCalls.length - 1; i >= 0; i--) {
      const entry = this.toolCalls[i];
      if (entry && entry.name === name && entry.state === "running") {
        entry.state = failed ? "failed" : "done";
        break;
      }
    }
    if (this.state === "streaming") {
      this.schedulePatch();
    }
  }

  /** Read-only view of tool calls (for card builders). */
  getToolCalls(): readonly ToolCallEntry[] {
    return this.toolCalls;
  }

  /** Current streaming buffer (for handleCardAction to preserve when patching
   *  the "answered" state of an inline ask card). */
  getBuffer(): string {
    return this.buffer;
  }

  /** Card message id (so input.requested can reuse the existing card instead
   *  of creating a separate ask-card). */
  getMessageId(): string | undefined {
    return this.messageId;
  }

  /** Active HITL request being rendered inline on this card, or null. */
  getAskRequest(): LarkInputRequest | null {
    return this.askRequest;
  }

  /**
   * Render an `ask_question` request inline on this card by appending prompt
   * + option buttons below the streaming text. Patches immediately so the
   * user sees the buttons as soon as the agent asks.
   *
   * If the prior turn already finalized (state="completed"), transition back
   * to "streaming" so the next patch can update the same card. The card
   * keeps its messageId — no new card is sent.
   */
  setAskRequest(req: LarkInputRequest): void {
    if (this.state === "aborted") return;
    this.askRequest = req;
    if (this.state === "completed" && this.messageId) {
      this.state = "streaming";
    }
    if (this.state === "streaming") {
      this.schedulePatch();
    }
  }

  /** Clear the inline ask request (e.g. after the user clicked an option). */
  clearAskRequest(): void {
    this.askRequest = null;
  }

  /**
   * Reset per-turn state for the next turn within the same session. Clears
   * the streaming buffer, tool-call history, status, and any inline ask —
   * but keeps the card messageId and transitions back to "streaming" so the
   * next message.appended patches the SAME card. Without this, the second
   * turn's message.completed would create a brand-new card and the user
   * would see N cards for N turns within one logical conversation.
   *
   * Called from the channel's `turn.started` event handler.
   */
  resetForNewTurn(): void {
    this.buffer = "";
    this.status = undefined;
    this.toolCalls = [];
    this.askRequest = null;
    this.fallbackToText = false;
    this.cancelCreateTimer();
    this.cancelPatchTimer();
    this.patchInFlight = null;
    this.patchScheduled = false;
    // Keep messageId; transition back to "streaming" so the next delta patches.
    if (this.messageId) {
      this.state = "streaming";
    } else {
      this.state = "idle";
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
          card: this.deps.useCardKitV2
            ? buildCardKitFinalCard(fullText, this.toolCalls, this.askRequest)
            : buildTextCard(fullText),
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
      card: this.deps.useCardKitV2
        ? buildCardKitStreamingCard({ buffer: fullText, streamingMode: false, toolCalls: this.toolCalls, askRequest: this.askRequest })
        : buildStreamingCard({ buffer: fullText, status: undefined, toolCalls: this.toolCalls, askRequest: this.askRequest }),
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
        card: this.deps.useCardKitV2
          ? buildCardKitStreamingCard({ buffer: this.buffer, status: this.status, streamingMode: true, toolCalls: this.toolCalls, askRequest: this.askRequest })
          : buildStreamingCard({ buffer: this.buffer, status: this.status, toolCalls: this.toolCalls, askRequest: this.askRequest }),
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
    const card = this.deps.useCardKitV2
      ? buildCardKitStreamingCard({ buffer: this.buffer, status: this.status, streamingMode: true, toolCalls: this.toolCalls, askRequest: this.askRequest })
      : buildStreamingCard({ buffer: this.buffer, status: this.status, toolCalls: this.toolCalls, askRequest: this.askRequest });
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
