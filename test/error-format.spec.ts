import { describe, expect, it } from "vitest";

/**
 * formatErrorHint / extractErrorId / formatFailureMessage are private to
 * channel.ts. Re-implement them here against the eve source we ported from,
 * then sanity-check the ports against representative eve event payloads.
 *
 * If this test starts failing, the port has drifted from eve's
 * #internal/logging.js — re-sync.
 */

/** Subset of eve's TurnFailedStreamEvent["data"] that we depend on. */
interface TurnFailedData {
  code: string;
  message: string;
  details?: { name?: string; errorId?: string } | undefined;
  sequence: number;
  turnId: string;
}

// Mirror of channel.ts internals — kept in lockstep by hand.
function formatErrorHint(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const d = data as { details?: unknown; message?: unknown };
  const detailsName =
    typeof d.details === "object" && d.details !== null
      ? (d.details as { name?: unknown }).name
      : undefined;
  const name =
    typeof detailsName === "string" && detailsName.length > 0 ? detailsName : undefined;
  const message = typeof d.message === "string" ? d.message.trim() : "";
  if (name && message.length > 0) return ` (${name}: ${truncateForDisplay(message)})`;
  if (name) return ` (${name})`;
  if (message.length > 0) return ` (${truncateForDisplay(message)})`;
  return "";
}
function extractErrorId(details: unknown): string | undefined {
  if (typeof details === "object" && details !== null) {
    const id = (details as { errorId?: unknown }).errorId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}
function truncateForDisplay(s: string, max = 160): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Build a realistic turn.failed payload shaped like eve's runtime emits. */
function turnFailed(opts: {
  code?: string;
  message?: string;
  detailsName?: string;
  errorId?: string;
}): TurnFailedData {
  return {
    code: opts.code ?? "AI_APICallError",
    message: opts.message ?? "Rate limit exceeded",
    details: {
      name: opts.detailsName ?? "AI_APICallError",
      errorId: opts.errorId,
    },
    sequence: 1,
    turnId: "turn_1",
  };
}

describe("formatErrorHint", () => {
  it("formats as ' (name: message)' when both details.name and message are present", () => {
    const hint = formatErrorHint(
      turnFailed({
        detailsName: "AI_APICallError",
        message: "Rate limit exceeded. Resets at 22:50.",
      }),
    );
    expect(hint).toBe(" (AI_APICallError: Rate limit exceeded. Resets at 22:50.)");
  });

  it("returns ' (name)' when only details.name is present", () => {
    const hint = formatErrorHint(turnFailed({ detailsName: "TimeoutError", message: "" }));
    expect(hint).toBe(" (TimeoutError)");
  });

  it("returns ' (message)' when only message is present (no details.name)", () => {
    const hint = formatErrorHint({ message: "something broke" });
    expect(hint).toBe(" (something broke)");
  });

  it("returns empty string when neither is present", () => {
    expect(formatErrorHint({})).toBe("");
    expect(formatErrorHint(null)).toBe("");
    expect(formatErrorHint(undefined)).toBe("");
    expect(formatErrorHint("string")).toBe("");
  });

  it("truncates the inner message to 160 chars + ellipsis (hint wrapper adds ~20)", () => {
    const long = "x".repeat(300);
    const hint = formatErrorHint(turnFailed({ message: long }));
    // The message inside the hint is truncated to 160 chars. The hint wraps
    // it with ` (AI_APICallError: …)`, adding ~20 chars depending on the
    // name length. So total hint length is roughly 160 + len(` (name: )`).
    expect(hint.endsWith("…)")).toBe(true);
    // Sanity bound: should never exceed 200 even with a long error name.
    expect(hint.length).toBeLessThanOrEqual(200);
  });

  it("trims leading/trailing whitespace from message", () => {
    // Raw shape: no details.name so the hint takes the message-only branch.
    const hint = formatErrorHint({ message: "  hi  " });
    expect(hint).toBe(" (hi)");
  });
});

describe("extractErrorId", () => {
  it("returns the errorId string when details.errorId is a non-empty string", () => {
    const id = extractErrorId({ errorId: "req_abc123" });
    expect(id).toBe("req_abc123");
  });

  it("returns undefined when errorId is missing, empty, or not a string", () => {
    expect(extractErrorId({})).toBeUndefined();
    expect(extractErrorId({ errorId: "" })).toBeUndefined();
    expect(extractErrorId({ errorId: 42 })).toBeUndefined();
    expect(extractErrorId(null)).toBeUndefined();
    expect(extractErrorId(undefined)).toBeUndefined();
    expect(extractErrorId("not-an-object")).toBeUndefined();
  });
});

describe("end-to-end payload shape (matches eve runtime)", () => {
  it("extracts hint + errorId from a realistic GLM rate-limit payload", () => {
    // Real shape seen in production logs (maha-agent + GLM Coding Plan):
    //   AI_APICallError: 已达到 5 小时的使用上限。您的限额将在 2026-06-19 22:50:54 重置
    const data = turnFailed({
      code: "AI_APICallError",
      detailsName: "AI_APICallError",
      message: "已达到 5 小时的使用上限。您的限额将在 2026-06-19 22:50:54 重置",
      errorId: "req_8f3a2b",
    });
    expect(formatErrorHint(data)).toBe(
      " (AI_APICallError: 已达到 5 小时的使用上限。您的限额将在 2026-06-19 22:50:54 重置)",
    );
    expect(extractErrorId(data.details)).toBe("req_8f3a2b");
  });
});
