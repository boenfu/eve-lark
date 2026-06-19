import type { LarkCard } from "./types.js";

const BASE_CONFIG = {
  wide_screen_mode: true,
  update_multi: true,
} as const;

/**
 * Build a simple single-shot card with the given markdown text.
 */
export function buildTextCard(text: string): LarkCard {
  return {
    config: { ...BASE_CONFIG },
    elements: [{ tag: "markdown", content: text }],
  };
}

/**
 * Build a streaming card with an optional status prefix and an answer buffer.
 *
 * Format:
 *   <optional status prefix in muted tone>
 *   <buffer>
 */
export function buildStreamingCard(opts: { buffer: string; status?: string | undefined }): LarkCard {
  const lines: string[] = [];
  if (opts.status) {
    lines.push(`<font color='grey'>${opts.status}</font>`);
  }
  lines.push(opts.buffer.length > 0 ? opts.buffer : "_…_");
  return {
    config: { ...BASE_CONFIG },
    elements: [{ tag: "markdown", content: lines.join("\n\n") }],
  };
}

/**
 * Build an error card displayed when a turn fails. `message` is rendered
 * verbatim under a red warning glyph — the caller is responsible for
 * prefixing/shape (most callers pass the raw error string and we wrap it).
 */
export function buildErrorCard(message: string): LarkCard {
  return {
    config: { ...BASE_CONFIG },
    elements: [
      { tag: "markdown", content: `<font color='red'>⚠ ${message}</font>` },
    ],
  };
}
