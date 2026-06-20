import type { LarkCard, LarkCardButton, LarkInputRequest } from "./types.js";

const BASE_CONFIG = {
  wide_screen_mode: true,
  update_multi: true,
} as const;

/**
 * Build a Feishu interactive card that surfaces an eve `authorization.required`
 * event: the agent needs the user to sign in to an external service. Renders
 * the connection's display name, a URL button that opens the auth URL, and
 * the user code (if present) so the user can copy-paste it.
 */
export function buildAuthCard(opts: {
  displayName: string;
  url: string;
  userCode?: string | undefined;
}): LarkCard {
  const elements: LarkCard["elements"] = [
    { tag: "div", text: { tag: "lark_md", content: `Sign in to **${escapeMarkdown(opts.displayName)}** to continue.` } },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: `Sign in with ${opts.displayName}` },
          type: "primary",
          url: opts.url,
        },
      ],
    },
  ];
  if (opts.userCode) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `Verification code: \`${escapeMarkdown(opts.userCode)}\`` },
    });
  }
  return { config: { ...BASE_CONFIG }, elements };
}

/**
 * Build the "post-authorization" card that replaces the auth card once the
 * user completes (or declines, or fails) the external sign-in.
 */
export function buildAuthCompletedCard(opts: {
  displayName: string;
  outcome: "authorized" | "declined" | "failed" | "timed-out" | string;
  reason?: string | undefined;
}): LarkCard {
  const outcomeLabel: Record<string, string> = {
    authorized: "✓",
    declined: "✗",
    failed: "⚠",
    "timed-out": "⏱",
  };
  const glyph = outcomeLabel[opts.outcome] ?? "•";
  const outcomeText: Record<string, string> = {
    authorized: "connected",
    declined: "declined",
    failed: "failed",
    "timed-out": "timed out",
  };
  const label = outcomeText[opts.outcome] ?? opts.outcome;
  const suffix = opts.reason ? ` — ${escapeMarkdown(opts.reason)}` : "";
  return {
    config: { ...BASE_CONFIG },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `**${escapeMarkdown(opts.displayName)}**: ${glyph} ${label}${suffix}` },
      },
    ],
  };
}

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

/** Above this many options, switch from buttons to a dropdown menu so the
 *  card stays readable. Below it, buttons give one-tap answering. */
const ASK_OPTIONS_BUTTON_MAX = 3;

/**
 * Build a Feishu interactive card that surfaces an eve `ask_question`
 * input request.
 *
 * Render choice:
 * - `display === "select"` OR options > {@link ASK_OPTIONS_BUTTON_MAX}:
 *   a single `select_static` dropdown. The selected optionId comes back in
 *   `action.option` (Feishu's select callback shape).
 * - Otherwise (display "confirmation" or short option list): one button per
 *   option. Each button's `value` carries `{__eveLarkAsk, requestId,
 *   optionId}`; Feishu returns it via `action.value` on click.
 *
 * For `allowFreeform: true` with no options, renders just the prompt (the
 * user replies with a normal chat message, which the channel intercepts).
 * For `allowFreeform: true` WITH options, renders the picker AND a footer
 * hint that the user can also type a reply.
 */
export function buildAskCard(request: LarkInputRequest): LarkCard {
  const elements: LarkCard["elements"] = [
    { tag: "div", text: { tag: "lark_md", content: request.prompt } },
  ];

  const optionCount = request.options?.length ?? 0;
  if (optionCount > 0) {
    const useSelect =
      request.display === "select" || optionCount > ASK_OPTIONS_BUTTON_MAX;
    if (useSelect) {
      elements.push({
        tag: "action",
        actions: [
          {
            tag: "select_static",
            placeholder: { tag: "plain_text", content: "Select an option…" },
            options: request.options!.map((opt) => ({
              text: { tag: "plain_text", content: opt.label },
              value: opt.id,
            })),
            // Marker carries requestId; optionId is returned via action.option.
            value: {
              [ASK_BUTTON_VALUE_MARKER]: true,
              requestId: request.requestId,
              __larkSelect: true,
            },
          },
        ],
      });
    } else {
      const buttons: LarkCardButton[] = request.options!.map((opt) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: opt.style ?? "default",
        value: {
          [ASK_BUTTON_VALUE_MARKER]: true,
          requestId: request.requestId,
          optionId: opt.id,
        },
        ...(opt.description
          ? {
              confirm: {
                title: { tag: "plain_text", content: opt.label },
                text: { tag: "plain_text", content: opt.description },
              },
            }
          : {}),
      }));
      elements.push({ tag: "action", actions: buttons });
    }
  }

  if (request.allowFreeform) {
    const hint =
      optionCount > 0
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

// ---------------------------------------------------------------------------
// CardKit v2 (schema 2.0) card builders. Used by replyMode: "streaming-v2".
// The CardKit v2 schema wraps elements in `body.elements` (vs v1's bare
// `elements`) and supports `config.streaming_mode` for live-patched cards
// that render at near-native font size.
// ---------------------------------------------------------------------------

export interface CardKitV2Card {
  schema: "2.0";
  config: {
    streaming_mode: boolean;
    wide_screen_mode?: boolean;
    update_multi?: boolean;
  };
  body: {
    elements: Array<{ tag: string; text?: { tag: string; content: string }; [k: string]: unknown }>;
  };
}

/**
 * Build a CardKit v2 card body for streaming. `streamingMode: true` for
 * intermediate patches, `false` for the final card.
 */
export function buildCardKitStreamingCard(opts: {
  buffer: string;
  status?: string | undefined;
  streamingMode: boolean;
}): CardKitV2Card {
  const lines: string[] = [];
  if (opts.status) {
    lines.push(`<font color='grey'>${opts.status}</font>`);
  }
  lines.push(opts.buffer.length > 0 ? opts.buffer : "_…_");
  return {
    schema: "2.0",
    config: {
      streaming_mode: opts.streamingMode,
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
      ],
    },
  };
}

/**
 * Build a non-streaming CardKit v2 card with the final text. Used as the
 * terminal patch when the turn completes.
 */
export function buildCardKitFinalCard(text: string): CardKitV2Card {
  return {
    schema: "2.0",
    config: { streaming_mode: false, wide_screen_mode: true, update_multi: true },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: text } },
      ],
    },
  };
}

