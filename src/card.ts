import type { LarkCard, LarkCardButton, LarkInputRequest } from "./types.js";

/**
 * One tool call's renderable state. Mirror of the same name in
 * streaming-controller.ts to avoid a circular import (controller imports
 * card builders, not vice versa).
 */
export interface ToolCallEntry {
  name: string;
  state: "running" | "done" | "failed";
}

/**
 * Render tool calls as a single grey-on-grey lark_md block above the answer
 * buffer. Running tools get `⏳`, completed get `✓` (green), failed get `✗`
 * (red). One line per tool so the user can see the full call history even
 * after the turn ends. Returns undefined when there are no tool calls so
 * callers can skip pushing an empty line.
 */
export function renderToolCalls(calls: readonly ToolCallEntry[]): string | undefined {
  if (calls.length === 0) return undefined;
  return calls
    .map((c) => {
      if (c.state === "running") return `<font color='blue'>⏳ ${c.name}</font>`;
      if (c.state === "failed") return `<font color='red'>✗ ${c.name}</font>`;
      return `<font color='green'>✓ ${c.name}</font>`;
    })
    .join("\n");
}

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
 * Build a streaming card with optional status prefix, tool-call history,
 * answer buffer, and inline ask UI. Tool calls render first (so the user
 * sees what the agent is doing / has done), then status, then the streamed
 * text. If `askRequest` is set, the prompt renders below the text and an
 * `action` row of option buttons is appended so the user can answer inline
 * on the SAME card — no separate ask-card, no separate reply card.
 */
export function buildStreamingCard(opts: {
  buffer: string;
  status?: string | undefined;
  toolCalls?: readonly ToolCallEntry[] | undefined;
  askRequest?: LarkInputRequest | null | undefined;
}): LarkCard {
  const lines: string[] = [];
  const toolLine = renderToolCalls(opts.toolCalls ?? []);
  if (toolLine) lines.push(toolLine);
  if (opts.status) {
    lines.push(`<font color='grey'>${opts.status}</font>`);
  }
  lines.push(opts.buffer.length > 0 ? opts.buffer : "_…_");
  if (opts.askRequest) {
    lines.push(`**${opts.askRequest.prompt}**`);
    if (opts.askRequest.allowFreeform && (opts.askRequest.options?.length ?? 0) === 0) {
      lines.push(`<font color='grey'>_Reply to this chat with your answer_</font>`);
    }
  }
  const elements: LarkCard["elements"] = [
    { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
  ];
  // Append option buttons as an action row when the ask has selectable options.
  // (select_static threshold is handled in buildAskCard; for the inline case
  // we always render buttons since the card already exists and we want
  // one-tap answering.)
  if (opts.askRequest?.options && opts.askRequest.options.length > 0) {
    const buttons: LarkCardButton[] = opts.askRequest.options.map((opt) => ({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: opt.style ?? "default",
      value: {
        [ASK_BUTTON_VALUE_MARKER]: true,
        requestId: opts.askRequest!.requestId,
        optionId: opt.id,
      },
    }));
    elements.push({ tag: "action", actions: buttons });
  }
  return { config: { ...BASE_CONFIG }, elements };
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
export const ASK_FORM_VALUE_MARKER = "__eveLarkAskForm";

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

export function buildAskFormCard(requests: readonly LarkInputRequest[]): LarkCard {
  const elements: LarkCard["elements"] = [];
  for (const request of requests) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: request.prompt } });
    const options = request.options ?? [];
    if (options.length > 0) {
      elements.push({
        tag: "action",
        actions: [{
          tag: "select_static",
          name: request.requestId,
          placeholder: { tag: "plain_text", content: "Select an option..." },
          options: options.map((opt) => ({
            text: { tag: "plain_text", content: opt.label },
            value: opt.id,
          })),
        }],
      });
    } else {
      elements.push({
        tag: "input",
        name: request.requestId,
        placeholder: { tag: "plain_text", content: "Type your answer..." },
      });
    }
  }
  elements.push({
    tag: "action",
    actions: [{
      tag: "button",
      text: { tag: "plain_text", content: "Submit" },
      type: "primary",
      value: {
        [ASK_FORM_VALUE_MARKER]: true,
        requestIds: requests.map((request) => request.requestId),
      },
    }],
  });
  return { config: { ...BASE_CONFIG }, elements };
}

export function buildAskExpiredCard(requests: readonly LarkInputRequest[]): LarkCard {
  const prompt = requests.map((request) => request.prompt).join("\n\n");
  return {
    config: { ...BASE_CONFIG },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: prompt } },
      { tag: "div", text: { tag: "lark_md", content: "<font color='grey'>This request expired.</font>" } },
    ],
  };
}

/**
 * Build the "post-click" card body that replaces the ask-card once the user
 * has answered. Disables further clicks by removing the action row and
 * appending a "✓ <selected label>" line.
 *
 * `priorBuffer` is optional streaming text from the controller when the ask
 * was rendered inline on a streaming card — preserves the prior turn's text
 * above the answered prompt instead of wiping it.
 */
export function buildAskAnsweredCard(
  request: LarkInputRequest,
  selected: { kind: "option"; label: string } | { kind: "freeform"; text: string },
  priorBuffer?: string | undefined,
): LarkCard {
  const elements: LarkCard["elements"] = [];
  if (priorBuffer && priorBuffer.length > 0) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: priorBuffer } });
  }
  elements.push({ tag: "div", text: { tag: "lark_md", content: request.prompt } });
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

export const CARDKIT_STREAMING_ELEMENT_ID = "eve_lark_answer";

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
 *
 * Uses the v2 `markdown` element (not `div+lark_md`) because CardKit v2
 * renders `markdown` at native chat-message size, while `div+lark_md` in v2
 * defaults to a larger / "card-like" size that looks unnatural in a chat
 * thread. (v1 interactive cards render `div+lark_md` at native size; v2
 * flips the defaults — pick the element that gives the look you want.)
 */
export function buildCardKitStreamingCard(opts: {
  buffer: string;
  status?: string | undefined;
  streamingMode: boolean;
  toolCalls?: readonly ToolCallEntry[] | undefined;
  askRequest?: LarkInputRequest | null | undefined;
}): CardKitV2Card {
  const lines: string[] = [];
  const toolLine = renderToolCalls(opts.toolCalls ?? []);
  if (toolLine) lines.push(toolLine);
  if (opts.status) {
    lines.push(`<font color='grey'>${opts.status}</font>`);
  }
  lines.push(opts.buffer.length > 0 ? opts.buffer : "_…_");
  if (opts.askRequest) {
    lines.push(`**${opts.askRequest.prompt}**`);
    if (opts.askRequest.allowFreeform && (opts.askRequest.options?.length ?? 0) === 0) {
      lines.push(`<font color='grey'>_Reply to this chat with your answer_</font>`);
    }
  }
  const elements: CardKitV2Card["body"]["elements"] = [
    { tag: "markdown", element_id: CARDKIT_STREAMING_ELEMENT_ID, content: lines.join("\n\n") },
  ];
  if (opts.askRequest?.options && opts.askRequest.options.length > 0) {
    const buttons = opts.askRequest.options.map((opt) => ({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: opt.style ?? "default",
      value: {
        [ASK_BUTTON_VALUE_MARKER]: true,
        requestId: opts.askRequest!.requestId,
        optionId: opt.id,
      },
    }));
    elements.push({ tag: "action", actions: buttons });
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: opts.streamingMode,
      wide_screen_mode: true,
      update_multi: true,
    },
    body: { elements },
  };
}

/**
 * Build a non-streaming CardKit v2 card with the final text. Used as the
 * terminal patch when the turn completes.
 */
export function buildCardKitFinalCard(
  text: string,
  toolCalls?: readonly ToolCallEntry[] | undefined,
  askRequest?: LarkInputRequest | null | undefined,
): CardKitV2Card {
  const lines: string[] = [];
  const toolLine = renderToolCalls(toolCalls ?? []);
  if (toolLine) lines.push(toolLine);
  lines.push(text);
  if (askRequest) {
    lines.push(`**${askRequest.prompt}**`);
  }
  const elements: CardKitV2Card["body"]["elements"] = [
    { tag: "markdown", content: lines.join("\n\n") },
  ];
  if (askRequest?.options && askRequest.options.length > 0) {
    const buttons = askRequest.options.map((opt) => ({
      tag: "button",
      text: { tag: "plain_text", content: opt.label },
      type: opt.style ?? "default",
      value: {
        [ASK_BUTTON_VALUE_MARKER]: true,
        requestId: askRequest!.requestId,
        optionId: opt.id,
      },
    }));
    elements.push({ tag: "action", actions: buttons });
  }
  return {
    schema: "2.0",
    config: { streaming_mode: false, wide_screen_mode: true, update_multi: true },
    body: { elements },
  };
}
