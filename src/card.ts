import type { LarkCard, LarkCardButton, LarkInputRequest } from "./types.js";

const BASE_CONFIG = {
  wide_screen_mode: true,
  update_multi: true,
} as const;

/**
 * Build a simple single-shot card with the given markdown text. Renders via
 * `div` + `lark_md` so the font size is close to a native chat message
 * (the bare `markdown` element renders noticeably smaller).
 */
export function buildTextCard(text: string): LarkCard {
  return {
    config: { ...BASE_CONFIG },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
  };
}

/**
 * Build a streaming card with an optional status prefix and an answer buffer.
 */
export function buildStreamingCard(opts: { buffer: string; status?: string | undefined }): LarkCard {
  const lines: string[] = [];
  if (opts.status) {
    lines.push(`<font color='grey'>${opts.status}</font>`);
  }
  lines.push(opts.buffer.length > 0 ? opts.buffer : "_…_");
  return {
    config: { ...BASE_CONFIG },
    elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } }],
  };
}

/**
 * Build an error card displayed when a turn fails.
 */
export function buildErrorCard(message: string): LarkCard {
  return {
    config: { ...BASE_CONFIG },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `<font color='red'>⚠ ${message}</font>` } },
    ],
  };
}

/** Marker placed in every ask-card button value so the card-action handler
 *  can recognise our own callbacks (and ignore card actions from other
 *  sources on the same message). */
export const ASK_BUTTON_VALUE_MARKER = "__eveLarkAsk";

/**
 * Build a Feishu interactive card that surfaces an eve `ask_question`
 * input request. Each selectable option becomes a button whose `value`
 * carries `{__eveLarkAsk, requestId, optionId}` — when the user clicks,
 * Feishu's `card.action.trigger` callback returns that JSON to us.
 *
 * For `allowFreeform: true` with no options, renders just the prompt
 * (the user replies with a normal chat message, which the channel
 * intercepts as the freeform response).
 *
 * For `allowFreeform: true` WITH options, renders buttons AND a footer
 * hint that the user can also type a reply.
 */
export function buildAskCard(request: LarkInputRequest): LarkCard {
  const elements: LarkCard["elements"] = [
    { tag: "div", text: { tag: "lark_md", content: request.prompt } },
  ];

  if (request.options && request.options.length > 0) {
    const buttons: LarkCardButton[] = request.options.map((opt) => ({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: opt.style ?? "default",
      value: {
        [ASK_BUTTON_VALUE_MARKER]: true,
        requestId: request.requestId,
        optionId: opt.id,
      },
      ...(opt.description
        ? { confirm: { title: { tag: "plain_text", content: opt.label }, text: { tag: "plain_text", content: opt.description } } }
        : {}),
    }));
    elements.push({ tag: "action", actions: buttons });
  }

  if (request.allowFreeform) {
    const hint =
      request.options && request.options.length > 0
        ? "_…or reply to this chat with your own answer_"
        : "_Reply to this chat with your answer_";
    elements.push({ tag: "div", text: { tag: "lark_md", content: hint } });
  }

  return { config: { ...BASE_CONFIG }, elements };
}

/**
 * Build the "post-click" card body that replaces the ask-card once the user
 * has answered. Disables further clicks by removing the action row and
 * appending a "✓ <selected label>" line.
 */
export function buildAskAnsweredCard(
  request: LarkInputRequest,
  selected: { kind: "option"; label: string } | { kind: "freeform"; text: string },
): LarkCard {
  const elements: LarkCard["elements"] = [
    { tag: "div", text: { tag: "lark_md", content: request.prompt } },
  ];
  const summary =
    selected.kind === "option"
      ? `<font color='green'>✓ ${escapeMarkdown(selected.label)}</font>`
      : `<font color='green'>✓ ${escapeMarkdown(selected.text)}</font>`;
  elements.push({ tag: "div", text: { tag: "lark_md", content: summary } });
  return { config: { ...BASE_CONFIG }, elements };
}

/** Escape characters that have special meaning in lark_md so user-controlled
 *  strings can't inject formatting. */
function escapeMarkdown(s: string): string {
  return s.replace(/[*_`~\[\]]/g, (m) => `\\${m}`);
}

