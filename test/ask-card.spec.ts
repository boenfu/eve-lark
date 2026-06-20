import { describe, expect, it } from "vitest";
import {
  ASK_BUTTON_VALUE_MARKER,
  buildAskAnsweredCard,
  buildAskCard,
  buildAskFormCard,
} from "../src/card.js";
import type { LarkInputRequest } from "../src/types.js";

function sampleRequest(overrides: Partial<LarkInputRequest> = {}): LarkInputRequest {
  return {
    requestId: "req_1",
    prompt: "Deploy to production?",
    options: [
      { id: "yes", label: "Yes, deploy", style: "primary" },
      { id: "no", label: "No, cancel", style: "danger" },
    ],
    action: {
      kind: "tool-call",
      toolName: "ask_question",
      callId: "call_1",
      input: {},
    },
    ...overrides,
  };
}

function divLarkMdContent(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const e = el as { tag?: string; text?: { tag?: string; content?: string } };
  if (e.tag !== "div") return undefined;
  if (e.text?.tag !== "lark_md") return undefined;
  return e.text.content;
}

function formElements(card: unknown): Array<Record<string, unknown>> {
  const body = (card as { body?: { elements?: unknown } }).body;
  const form = Array.isArray(body?.elements)
    ? body.elements.find((el) => (el as { tag?: unknown })?.tag === "form")
    : undefined;
  const elements = (form as { elements?: unknown } | undefined)?.elements;
  return Array.isArray(elements) ? elements as Array<Record<string, unknown>> : [];
}

describe("buildAskCard", () => {
  it("renders prompt as a div+lark_md element", () => {
    const card = buildAskCard(sampleRequest());
    const prompt = card.elements.map(divLarkMdContent).find((c) => c?.includes("Deploy"));
    expect(prompt).toBe("Deploy to production?");
  });

  it("renders one button per option in an action element", () => {
    const card = buildAskCard(sampleRequest());
    const action = card.elements.find((e) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "action") as
      | { tag: "action"; actions: Array<{ tag: string; text: { content: string }; type?: string; value?: Record<string, unknown> }> }
      | undefined;
    expect(action).toBeDefined();
    expect(action!.actions).toHaveLength(2);
    expect(action!.actions[0]!.text.content).toBe("Yes, deploy");
    expect(action!.actions[0]!.type).toBe("primary");
    expect(action!.actions[1]!.text.content).toBe("No, cancel");
    expect(action!.actions[1]!.type).toBe("danger");
  });

  it("encodes requestId + optionId in each button value, marked with our sentinel", () => {
    const card = buildAskCard(sampleRequest());
    const action = card.elements.find((e) => typeof e === "object" && e !== null && (e as { tag?: string }).tag === "action") as
      | { tag: "action"; actions: Array<{ value?: Record<string, unknown> }> }
      | undefined;
    expect(action!.actions[0]!.value).toEqual({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_1",
      optionId: "yes",
    });
    expect(action!.actions[1]!.value).toEqual({
      [ASK_BUTTON_VALUE_MARKER]: true,
      requestId: "req_1",
      optionId: "no",
    });
  });

  it("appends a freeform hint when allowFreeform is true with options", () => {
    const card = buildAskCard(sampleRequest({ allowFreeform: true }));
    const hint = card.elements.map(divLarkMdContent).find((c) => c?.includes("or reply"));
    expect(hint).toBeTruthy();
  });

  it("renders only the prompt + freeform hint when no options (text-only reply)", () => {
    const card = buildAskCard(
      sampleRequest({
        options: undefined,
        allowFreeform: true,
        prompt: "What's your name?",
      }),
    );
    const actions = card.elements.filter((e) => typeof e === "object" && (e as { tag?: string }).tag === "action");
    expect(actions).toHaveLength(0);
    const hint = card.elements.map(divLarkMdContent).find((c) => c?.includes("Reply"));
    expect(hint).toBeTruthy();
  });
});

describe("buildAskAnsweredCard", () => {
  it("renders the selected option label with a green check, no buttons", () => {
    const card = buildAskAnsweredCard(sampleRequest(), {
      kind: "option",
      label: "Yes, deploy",
    });
    // No action element remains — buttons removed.
    const actions = card.elements.filter((e) => typeof e === "object" && (e as { tag?: string }).tag === "action");
    expect(actions).toHaveLength(0);
    // Summary line appears with green check.
    const summary = card.elements.map(divLarkMdContent).find((c) => c?.includes("✓"));
    expect(summary).toContain("Yes, deploy");
    expect(summary).toContain("<font color='green'>");
  });

  it("renders freeform text answer with a green check", () => {
    const card = buildAskAnsweredCard(sampleRequest(), {
      kind: "freeform",
      text: "maybe tomorrow",
    });
    const summary = card.elements.map(divLarkMdContent).find((c) => c?.includes("✓"));
    expect(summary).toContain("maybe tomorrow");
  });

  it("escapes markdown special chars in the selected label so they don't inject formatting", () => {
    const card = buildAskAnsweredCard(sampleRequest(), {
      kind: "option",
      label: "**not bold**",
    });
    const summary = card.elements.map(divLarkMdContent).find((c) => c?.includes("✓"));
    expect(summary).toContain("\\*\\*not bold\\*\\*");
  });
});

describe("buildAskCard — select_static rendering", () => {
  it("switches to select_static when options.length > 3", () => {
    const card = buildAskCard(
      sampleRequest({
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
          { id: "d", label: "D" },
        ],
      }),
    );
    const action = card.elements.find(
      (e) => typeof e === "object" && (e as { tag?: string }).tag === "action",
    ) as
      | { tag: "action"; actions: Array<{ tag: string; options?: Array<{ value: string }> }> }
      | undefined;
    expect(action).toBeDefined();
    expect(action!.actions).toHaveLength(1);
    expect(action!.actions[0]!.tag).toBe("select_static");
    expect(action!.actions[0]!.options?.map((o) => o.value)).toEqual(["a", "b", "c", "d"]);
  });

  it("forces select_static when display === 'select' even with few options", () => {
    const card = buildAskCard(sampleRequest({ display: "select" }));
    const action = card.elements.find(
      (e) => typeof e === "object" && (e as { tag?: string }).tag === "action",
    ) as
      | { tag: "action"; actions: Array<{ tag: string }> }
      | undefined;
    expect(action!.actions[0]!.tag).toBe("select_static");
  });

  it("forces buttons when display === 'confirmation' even with many options", () => {
    const card = buildAskCard(
      sampleRequest({
        display: "confirmation",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      }),
    );
    const action = card.elements.find(
      (e) => typeof e === "object" && (e as { tag?: string }).tag === "action",
    ) as
      | { tag: "action"; actions: Array<{ tag: string }> }
      | undefined;
    expect(action!.actions.every((a) => a.tag === "button")).toBe(true);
  });

  it("tags the select_static value with marker + requestId, NOT optionId (optionId arrives via action.option)", () => {
    const card = buildAskCard(sampleRequest({ display: "select" }));
    const action = card.elements.find(
      (e) => typeof e === "object" && (e as { tag?: string }).tag === "action",
    ) as
      | {
          tag: "action";
          actions: Array<{ value?: Record<string, unknown>; options?: Array<{ value: string }> }>;
        }
      | undefined;
    const select = action!.actions[0]!;
    expect(select.value?.[ASK_BUTTON_VALUE_MARKER]).toBe(true);
    expect(select.value?.requestId).toBe("req_1");
    expect(select.value?.optionId).toBeUndefined();
    // Each option's value is the optionId string; Feishu echoes the picked
    // one back as action.option on the card.action.trigger callback.
    expect(select.options?.[0]?.value).toBe("yes");
    expect(select.options?.[1]?.value).toBe("no");
  });

});

describe("buildAskFormCard — multi-select rendering", () => {
  it("renders form cards as schema 2.0 with a submit button", () => {
    const card = buildAskFormCard([
      sampleRequest({
        requestId: "req_name",
        prompt: "Name?",
        options: undefined,
        allowFreeform: true,
      }),
    ]);
    expect(card).toMatchObject({ schema: "2.0" });
    const submit = formElements(card).find((el) => el.tag === "button") as
      | { form_action_type?: string; value?: Record<string, unknown> }
      | undefined;
    expect(submit).toMatchObject({
      form_action_type: "submit",
      value: { __eveLarkAskForm: true, requestIds: ["req_name"] },
    });
  });

  it("renders multi_select_static when a request has multiSelect enabled", () => {
    const card = buildAskFormCard([
      sampleRequest({
        requestId: "req_scopes",
        prompt: "Scopes?",
        multiSelect: true,
        options: [
          { id: "read", label: "Read" },
          { id: "write", label: "Write" },
        ],
      }),
      sampleRequest({
        requestId: "req_comment",
        prompt: "Comment?",
        options: undefined,
        allowFreeform: true,
      }),
    ]);

    const select = formElements(card).find((el) => el.name === "req_scopes") as
      | { tag: string; name?: string; options?: Array<{ value: string }> }
      | undefined;
    expect(select).toMatchObject({
      tag: "multi_select_static",
      name: "req_scopes",
    });
    expect(select!.options?.map((o) => o.value)).toEqual(["read", "write"]);
  });
});
