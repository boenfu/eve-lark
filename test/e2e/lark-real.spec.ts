import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ASK_BUTTON_VALUE_MARKER,
  ASK_FORM_VALUE_MARKER,
  CARDKIT_STREAMING_ELEMENT_ID,
  buildCardKitFinalCard,
  buildCardKitStreamingCard,
  buildTextCard,
} from "../../src/card.js";
import { createLarkChannel } from "../../src/channel.js";
import { createLarkSender } from "../../src/outbound.js";
import {
  __resetLongConnectionSingletonsForTests,
  postEventToWebhook,
  startLongConnection,
} from "../../src/long-connection.js";
import { LarkClient } from "../../src/lark-client.js";
import { resolveOptions } from "../../src/options.js";
import type { LarkChannelOptions, ResolvedLarkOptions } from "../../src/types.js";

if (process.env.E2E_LARK === "1" || process.env.E2E_LARK_LOAD_ENV === "1") {
  loadDotenv({ path: ".env.e2e.local", override: false });
}

const runRealE2E = process.env.E2E_LARK === "1";
const describeReal = runRealE2E ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const runId = `eve-lark-${randomUUID()}`;
const e2eCases = {
  outbound: "outbound text/post/card/reaction/media/payload/actions",
  cardkit: "CardKit v2 streaming lifecycle",
  inboundReply: "long-connection user text to bot reply",
  ackReaction: "ackReaction feedback on inbound user message",
  concurrentMessages: "per-chat queue serializes consecutive user messages",
  quoteReply: "agent replies quote the triggering user message",
  groupMention: "group @ and non-@ messages reach agent",
  groupSystemPrompt: "group-level systemPrompt reaches agent context",
  groupAllowlist: "group allowlist allows configured chat and drops others",
  command: "slash command interception",
  customCardAction: "custom card action handler reply/follow-up/edit",
  hitlForm: "HITL multi-question form card callback",
  hitlFreeform: "HITL freeform text interception",
  hitlOptionText: "HITL option-label text reply and invalid hint",
  hitlRetryTtl: "HITL card callback retry and TTL expiry",
  reaction: "reaction event as synthetic input",
  file: "file inbound and resource download",
} as const;
const caseNames = Object.values(e2eCases);
const caseResults: Array<{
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  error?: string;
}> = [];
let portOffset = 0;
let cachedBotOpenId: string | undefined;

interface CliMessage {
  content?: unknown;
  message_id?: string;
  msg_type?: string;
  sender?: {
    sender_type?: string;
    name?: string;
  };
}

interface RouteHandlerArgs {
  send: (message: unknown, opts: unknown) => Promise<{ id: string; continuationToken: string }>;
  getSession: unknown;
  receive: unknown;
  params: Record<string, string>;
  waitUntil: (p: Promise<unknown>) => void;
  requestIp: string | null;
}

type ChannelForTest = ReturnType<typeof createLarkChannel> & {
  __testEvents?: Record<string, (data: unknown, channel: unknown, ctx: unknown) => Promise<void> | void>;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in .env.e2e.local or export it before running pnpm test:e2e.`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function chatId(): string {
  return requiredEnv("E2E_LARK_CHAT_ID");
}

function nextPort(): number {
  const base = Number(process.env.E2E_LARK_PORT ?? "23080");
  return base + portOffset++;
}

function realOptions(overrides: LarkChannelOptions = {}): LarkChannelOptions {
  return {
    appId: requiredEnv("LARK_APP_ID"),
    appSecret: requiredEnv("LARK_APP_SECRET"),
    verificationToken: requiredEnv("LARK_VERIFICATION_TOKEN"),
    encryptKey: optionalEnv("LARK_ENCRYPT_KEY"),
    baseUrl: optionalEnv("LARK_BASE_URL"),
    ackReaction: false,
    requestTimeoutMs: 30_000,
    streamPatchIntervalMs: 250,
    streamCreateThresholdMs: 100,
    ...overrides,
  };
}

function resolvedOptions(overrides: LarkChannelOptions = {}): ResolvedLarkOptions {
  return resolveOptions(realOptions(overrides));
}

function realClient(overrides: LarkChannelOptions = {}): LarkClient {
  return new LarkClient(resolvedOptions({ mode: "webhook", ...overrides }));
}

async function tracked(name: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  try {
    await fn();
    caseResults.push({ name, status: "passed", durationMs: Date.now() - startedAt });
  } catch (error) {
    caseResults.push({
      name,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function runLarkCli(args: readonly string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("lark-cli", [...args], {
    timeout: 40_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

function firstStringByKey(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = firstStringByKey(child, key);
    if (found) return found;
  }
  return undefined;
}

function allStringsByKey(value: unknown, key: string, out: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return out;
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") out.push(record[key]);
  for (const child of Object.values(record)) {
    allStringsByKey(child, key, out);
  }
  return out;
}

function textFromChannelMessage(message: unknown): string {
  if (!Array.isArray(message)) return "";
  const textPart = message.find((part) => {
    return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text";
  }) as { text?: unknown } | undefined;
  return typeof textPart?.text === "string" ? textPart.text : "";
}

async function e2eBotOpenId(): Promise<string> {
  const fromEnv = optionalEnv("E2E_LARK_BOT_OPEN_ID") ?? optionalEnv("LARK_BOT_OPEN_ID");
  if (fromEnv) return fromEnv;
  if (cachedBotOpenId) return cachedBotOpenId;

  const json = await runLarkCli([
    "im",
    "chat.members",
    "bots",
    "--as",
    "user",
    "--chat-id",
    chatId(),
    "--format",
    "json",
  ]);
  const ids = [...new Set(allStringsByKey(json, "bot_id").filter((id) => id.startsWith("ou_")))];
  if (ids.length !== 1) {
    throw new Error(
      `Could not determine a single E2E bot open_id from chat members. Set E2E_LARK_BOT_OPEN_ID in .env.e2e.local. Found: ${ids.join(", ")}`,
    );
  }
  const [botOpenId] = ids as [string];
  cachedBotOpenId = botOpenId;
  return cachedBotOpenId;
}

async function sendUserText(text: string): Promise<string> {
  const json = await runLarkCli([
    "im",
    "+messages-send",
    "--as",
    "user",
    "--chat-id",
    chatId(),
    "--text",
    text,
    "--idempotency-key",
    `eve-lark-e2e-${randomUUID()}`,
    "--format",
    "json",
  ]) as { ok?: boolean; data?: { message_id?: string }; error?: unknown };
  if (json.ok !== true || !json.data?.message_id) {
    throw new Error(`lark-cli message send failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data.message_id;
}

async function sendUserTextContent(text: string): Promise<string> {
  const json = await runLarkCli([
    "im",
    "+messages-send",
    "--as",
    "user",
    "--chat-id",
    chatId(),
    "--msg-type",
    "text",
    "--content",
    JSON.stringify({ text }),
    "--idempotency-key",
    `eve-lark-e2e-${randomUUID()}`,
    "--format",
    "json",
  ]) as { ok?: boolean; data?: { message_id?: string }; error?: unknown };
  if (json.ok !== true || !json.data?.message_id) {
    throw new Error(`lark-cli raw text send failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data.message_id;
}

async function sendUserFile(relativePath: string): Promise<string> {
  const json = await runLarkCli([
    "im",
    "+messages-send",
    "--as",
    "user",
    "--chat-id",
    chatId(),
    "--file",
    relativePath,
    "--idempotency-key",
    `eve-lark-e2e-${randomUUID()}`,
    "--format",
    "json",
  ]) as { ok?: boolean; data?: { message_id?: string }; error?: unknown };
  if (json.ok !== true || !json.data?.message_id) {
    throw new Error(`lark-cli file send failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data.message_id;
}

async function uploadBotFile(relativePath: string, fileName: string): Promise<string> {
  const json = await runLarkCli([
    "api",
    "POST",
    "/open-apis/im/v1/files",
    "--as",
    "bot",
    "--data",
    JSON.stringify({ file_type: "stream", file_name: fileName }),
    "--file",
    `file=${relativePath}`,
    "--format",
    "json",
  ]);
  const fileKey = firstStringByKey(json, "file_key");
  if (!fileKey) {
    throw new Error(`bot file upload failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return fileKey;
}

async function addUserReaction(messageId: string, emojiType: string): Promise<string> {
  const json = await runLarkCli([
    "im",
    "reactions",
    "create",
    "--as",
    "user",
    "--message-id",
    messageId,
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    "--format",
    "json",
  ]);
  const reactionId = firstStringByKey(json, "reaction_id");
  if (!reactionId) {
    throw new Error(`lark-cli reaction create failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return reactionId;
}

async function deleteUserReaction(messageId: string, reactionId: string): Promise<void> {
  await deleteReaction("user", messageId, reactionId);
}

async function deleteReaction(actor: "user" | "bot", messageId: string, reactionId: string): Promise<void> {
  await runLarkCli([
    "im",
    "reactions",
    "delete",
    "--as",
    actor,
    "--message-id",
    messageId,
    "--reaction-id",
    reactionId,
    "--format",
    "json",
  ]);
}

async function listReactions(messageId: string, emojiType: string): Promise<unknown> {
  return runLarkCli([
    "im",
    "reactions",
    "list",
    "--as",
    "user",
    "--message-id",
    messageId,
    "--reaction-type",
    emojiType,
    "--params",
    JSON.stringify({ user_id_type: "open_id" }),
    "--format",
    "json",
  ]);
}

async function waitForReaction(messageId: string, emojiType: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await listReactions(messageId, emojiType);
    if (JSON.stringify(last).includes(emojiType)) {
      return firstStringByKey(last, "reaction_id") ?? firstStringByKey(last, "reaction_id_str") ?? "";
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${emojiType} reaction on ${messageId}. Last response: ${JSON.stringify(last).slice(0, 800)}`);
}

async function listRecentMessages(): Promise<CliMessage[]> {
  const json = await runLarkCli([
    "im",
    "+chat-messages-list",
    "--as",
    "user",
    "--chat-id",
    chatId(),
    "--page-size",
    "30",
    "--no-reactions",
    "--format",
    "json",
  ]) as { ok?: boolean; data?: { messages?: CliMessage[] }; error?: unknown };
  if (json.ok !== true) {
    throw new Error(`lark-cli message list failed: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json.data?.messages ?? [];
}

async function waitForMessageContaining(needle: string, timeoutMs = 60_000): Promise<CliMessage> {
  return waitForMessageWhere(
    (message) => JSON.stringify(message).includes(needle),
    timeoutMs,
    `message containing ${needle}`,
  );
}

async function waitForMessageWhere(
  predicate: (message: CliMessage) => boolean,
  timeoutMs: number,
  label: string,
): Promise<CliMessage> {
  const deadline = Date.now() + timeoutMs;
  let lastMessages: CliMessage[] = [];
  while (Date.now() < deadline) {
    lastMessages = await listRecentMessages();
    const found = lastMessages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Timed out waiting for ${label}. Recent messages: ${JSON.stringify(lastMessages).slice(0, 1000)}`,
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    }),
  ]);
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function headersFromNode(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else if (typeof value === "string") {
      out.set(key, value);
    }
  }
  return out;
}

async function readNodeRequestBody(req: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function getWebhookHandler(channel: ReturnType<typeof createLarkChannel>) {
  const route = channel.routes[0];
  if (!route || route.method !== "POST") {
    throw new Error("Expected lark channel to expose one POST route.");
  }
  return (route as unknown as {
    handler: (req: Request, args: RouteHandlerArgs) => Promise<Response>;
  }).handler;
}

function startWebhookServer(args: {
  channel: ChannelForTest;
  port: number;
  helpers: RouteHandlerArgs;
}): Server {
  const handler = getWebhookHandler(args.channel);
  return createServer((nodeReq, nodeRes) => {
    void (async () => {
      const body = await readNodeRequestBody(nodeReq);
      const req = new Request(`http://127.0.0.1:${args.port}${nodeReq.url ?? "/"}`, {
        method: nodeReq.method,
        headers: headersFromNode(nodeReq.headers),
        body,
      });
      const res = await handler(req, args.helpers);
      nodeRes.statusCode = res.status;
      res.headers.forEach((value, key) => nodeRes.setHeader(key, value));
      nodeRes.end(Buffer.from(await res.arrayBuffer()));
    })().catch((error) => {
      nodeRes.statusCode = 500;
      nodeRes.end(error instanceof Error ? error.message : String(error));
    });
  });
}

function parseResourceUrl(raw: string): { messageId: string; fileKey: string; type: "image" | "file" } {
  const url = new URL(raw);
  const match = url.pathname.match(/\/messages\/([^/]+)\/resources\/([^/]+)$/);
  const type = url.searchParams.get("type");
  if (!match?.[1] || !match[2] || (type !== "image" && type !== "file")) {
    throw new Error(`Unexpected Lark resource URL: ${raw}`);
  }
  return {
    messageId: decodeURIComponent(match[1]),
    fileKey: decodeURIComponent(match[2]),
    type,
  };
}

function makeRecordingHelpers(
  onSend: (message: unknown, opts: unknown) => Promise<void> | void,
  waits: Promise<unknown>[],
): RouteHandlerArgs {
  return {
    async send(message, opts) {
      await onSend(message, opts);
      const continuationToken = (opts as { continuationToken?: string }).continuationToken ?? "";
      return { id: `e2e_${randomUUID()}`, continuationToken };
    },
    getSession: () => null,
    receive: async () => undefined,
    params: {},
    waitUntil: (p) => {
      waits.push(p);
      void p.catch(() => {});
    },
    requestIp: "127.0.0.1",
  };
}

function askSessionContext(messageId = `om_${randomUUID().replaceAll("-", "")}`) {
  return {
    session: {
      id: `sess_${randomUUID()}`,
      auth: {
        initiator: {
          attributes: {
            chatId: chatId(),
            messageId,
            chatType: "group",
          },
        },
      },
    },
  };
}

async function requestInput(channel: ChannelForTest, data: unknown): Promise<void> {
  const inputRequested = channel.__testEvents?.["input.requested"];
  if (!inputRequested) throw new Error("input.requested test handler is not exposed.");
  await inputRequested(data, {}, askSessionContext());
}

async function captureCurrentMessageIds(): Promise<Set<string>> {
  return new Set(
    (await listRecentMessages())
      .map((message) => message.message_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

async function waitForNewAppCard(beforeIds: Set<string>, label: string): Promise<CliMessage> {
  const cardMessage = await waitForMessageWhere(
    (message) => {
      const isCardMessage = message.msg_type === "interactive" || message.msg_type === "nonsupport";
      return !!message.message_id &&
        !beforeIds.has(message.message_id) &&
        message.sender?.sender_type === "app" &&
        isCardMessage;
    },
    30_000,
    label,
  );
  if (!cardMessage.message_id) throw new Error(`${label} message_id missing from lark-cli response.`);
  return cardMessage;
}

async function waitForNewAppMessageOfType(
  beforeIds: Set<string>,
  msgType: string,
  label: string,
): Promise<CliMessage> {
  const message = await waitForMessageWhere(
    (item) => !!item.message_id &&
      !beforeIds.has(item.message_id) &&
      item.sender?.sender_type === "app" &&
      item.msg_type === msgType,
    45_000,
    label,
  );
  if (!message.message_id) throw new Error(`${label} message_id missing from lark-cli response.`);
  return message;
}

async function postAskButtonAction(args: {
  port: number;
  cardMessageId: string;
  requestId: string;
  optionId: string;
}): Promise<void> {
  await postEventToWebhook(
    {
      schema: "2.0",
      header: {
        event_id: `evt_${randomUUID()}`,
        event_type: "card.action.trigger",
        create_time: String(Math.floor(Date.now() / 1000)),
        token: requiredEnv("LARK_VERIFICATION_TOKEN"),
        app_id: requiredEnv("LARK_APP_ID"),
      },
      event: {
        open_id: "ou_e2e_synthetic_user",
        tenant_key: "tenant_e2e",
        open_message_id: args.cardMessageId,
        token: "token_e2e",
        action: {
          tag: "button",
          value: {
            [ASK_BUTTON_VALUE_MARKER]: true,
            requestId: args.requestId,
            optionId: args.optionId,
          },
        },
      },
    },
    {
      eveWebhookUrl: `http://127.0.0.1:${args.port}/lark/webhook`,
      encryptKey: optionalEnv("LARK_ENCRYPT_KEY"),
    },
  );
}

function makeReplyingHelpers(args: {
  channel: ChannelForTest;
  waits: Promise<unknown>[];
  expectedText: string;
  replyText: string;
  onInbound: (message: unknown, opts: unknown) => void;
  onReplyDone: (error?: unknown) => void;
}): RouteHandlerArgs {
  return {
    async send(message, opts) {
      const serialized = JSON.stringify(message);
      const sessionId = `e2e_${randomUUID()}`;
      const continuationToken = (opts as { continuationToken?: string }).continuationToken ?? "";
      const auth = (opts as { auth?: unknown }).auth;
      if (!serialized.includes(args.expectedText)) {
        return { id: sessionId, continuationToken };
      }
      args.onInbound(message, opts);
      setTimeout(() => {
        const turnStarted = args.channel.__testEvents?.["turn.started"];
        const completed = args.channel.__testEvents?.["message.completed"];
        if (!completed) {
          args.onReplyDone(new Error("message.completed test handler is not exposed."));
          return;
        }
        const turnId = `turn_${randomUUID()}`;
        const ctx = { session: { id: sessionId, auth: { initiator: auth } } };
        Promise.resolve()
          .then(() => turnStarted?.({ turnId }, {}, ctx))
          .then(() => completed(
            { message: args.replyText, turnId },
            {},
            ctx,
          )).then(
          () => args.onReplyDone(),
          (error) => args.onReplyDone(error),
        );
      }, 0);
      return { id: sessionId, continuationToken };
    },
    getSession: () => null,
    receive: async () => undefined,
    params: {},
    waitUntil: (p) => {
      args.waits.push(p);
      void p.catch(() => {});
    },
    requestIp: "127.0.0.1",
  };
}

async function withLongConnection(
  makeHelpers: (channel: ChannelForTest, waits: Promise<unknown>[]) => RouteHandlerArgs,
  fn: (ctx: { channel: ChannelForTest; waits: Promise<unknown>[]; port: number }) => Promise<void>,
  options: LarkChannelOptions = {},
): Promise<void> {
  const port = nextPort();
  const channel = createLarkChannel(realOptions({
    mode: "webhook",
    port,
    replyMode: "post",
    groupAllowFrom: [chatId()],
    ...options,
  })) as ChannelForTest;
  const waits: Promise<unknown>[] = [];
  const helpers = makeHelpers(channel, waits);
  const server = startWebhookServer({ channel, port, helpers });
  try {
    await listen(server, port);
    const resolved = resolvedOptions({
      mode: "long-connection",
      port,
      replyMode: "post",
      groupAllowFrom: [chatId()],
      ...options,
    });
    await startLongConnection({
      resolved,
      eveWebhookUrl: `http://127.0.0.1:${port}${resolved.webhookPath}`,
    });
    await fn({ channel, waits, port });
  } finally {
    await closeServer(server);
  }
}

function runNotice(status: "start" | "end"): string {
  if (status === "start") {
    return [
      "**eve-lark real E2E start**",
      "",
      `runId: \`${runId}\``,
      `chatId: \`${chatId()}\``,
      "",
      ...caseNames.map((name, index) => `${index + 1}. ${name}`),
    ].join("\n");
  }
  const passed = caseResults.filter((r) => r.status === "passed");
  const failed = caseResults.filter((r) => r.status === "failed");
  const lines = [
    "**eve-lark real E2E end**",
    "",
    `runId: \`${runId}\``,
    `result: ${failed.length === 0 ? "passed" : "failed"}`,
    `passed: ${passed.length}`,
    `failed: ${failed.length}`,
    "",
    ...caseResults.map((r) => {
      const suffix = r.status === "failed" && r.error ? ` - ${r.error.slice(0, 160)}` : "";
      return `${r.status === "passed" ? "✓" : "✗"} ${r.name} (${r.durationMs}ms)${suffix}`;
    }),
  ];
  return lines.join("\n");
}

describeReal("real Lark E2E", () => {
  beforeAll(async () => {
    await realClient({ replyMode: "post" }).sendPost({
      chatId: chatId(),
      content: runNotice("start"),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await realClient({ replyMode: "post" }).sendPost({
        chatId: chatId(),
        content: runNotice("end"),
      });
    } finally {
      await rm(".e2e-tmp", { recursive: true, force: true });
    }
  }, 60_000);

  afterEach(() => {
    __resetLongConnectionSingletonsForTests();
  });

  it("covers outbound text, post, native card, media, payload, reaction, and safe message actions", async () => tracked(e2eCases.outbound, async () => {
    const client = realClient({ replyMode: "post" });
    const textMarker = `eve-lark e2e text ${runId}`;
    const postMarker = `eve-lark e2e post ${runId}`;
    const cardMarker = `eve-lark e2e card ${runId}`;
    const payloadTextMarker = `eve-lark e2e payload text ${runId}`;
    const payloadCardMarker = `eve-lark e2e payload card ${runId}`;
    const payloadFileName = `${runId}-payload.txt`;
    const directFileName = `${runId}-direct.txt`;

    const textRes = await client.sendText({ chatId: chatId(), content: textMarker });
    expect(textRes.messageId).toMatch(/^om_/);
    await waitForMessageContaining(textMarker, 30_000);

    const postRes = await client.sendPost({ chatId: chatId(), content: postMarker });
    expect(postRes.messageId).toMatch(/^om_/);
    await waitForMessageContaining(postMarker, 30_000);

    const cardRes = await client.sendCard({ chatId: chatId(), card: buildTextCard(cardMarker) });
    expect(cardRes.messageId).toMatch(/^om_/);
    await waitForMessageContaining(cardMarker, 30_000);

    const beforeDirectFile = await captureCurrentMessageIds();
    const directFileRes = await client.uploadAndSendMedia({
      chatId: chatId(),
      media: { data: Buffer.from(`direct outbound media ${runId}`, "utf8"), fileName: directFileName },
    });
    expect(directFileRes.messageId).toMatch(/^om_/);
    await waitForNewAppMessageOfType(beforeDirectFile, "file", `direct outbound file ${directFileName}`);

    const beforeImage = await captureCurrentMessageIds();
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l1R7mQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageRes = await client.uploadAndSendMedia({
      chatId: chatId(),
      media: { data: onePixelPng, fileName: `${runId}.png` },
    });
    expect(imageRes.messageId).toMatch(/^om_/);
    await waitForNewAppMessageOfType(beforeImage, "image", "direct outbound image");

    const sender = createLarkSender(realOptions({ mode: "webhook", replyMode: "post" }));
    const beforePayload = await captureCurrentMessageIds();
    const payloadRes = await sender.sendPayload({
      chatId: chatId(),
      text: payloadTextMarker,
      channelData: {
        feishu: { card: buildTextCard(payloadCardMarker) as unknown as Record<string, unknown> },
      },
      media: [{
        data: Buffer.from(`payload outbound media ${runId}`, "utf8"),
        fileName: payloadFileName,
      }],
    });
    expect(payloadRes.messageId).toMatch(/^om_/);
    await waitForMessageContaining(payloadTextMarker, 30_000);
    await waitForMessageContaining(payloadCardMarker, 30_000);
    await waitForNewAppMessageOfType(beforePayload, "file", `payload outbound file ${payloadFileName}`);

    const userMessageId = await sendUserText(`eve-lark e2e reaction-target ${runId}`);
    const reaction = await client.addReaction({ messageId: userMessageId, emojiType: "THUMBSUP" });
    expect(reaction.reactionId).toBeTruthy();
    await client.removeReaction({ messageId: userMessageId, reactionId: reaction.reactionId });

    const members = await client.listChatMembers({ chatId: chatId() });
    expect(members.members.length).toBeGreaterThan(0);

    const forwardSource = await client.sendPost({
      chatId: chatId(),
      content: `eve-lark e2e forward source ${runId}`,
    });
    const forwarded = await client.forwardMessage({
      messageId: forwardSource.messageId,
      chatId: chatId(),
    });
    expect(forwarded.messageId).toMatch(/^om_/);

    const deleteSource = await client.sendText({
      chatId: chatId(),
      content: `eve-lark e2e delete source ${runId}`,
    });
    expect(deleteSource.messageId).toMatch(/^om_/);
    await client.deleteMessage({ messageId: deleteSource.messageId });
  }), 240_000);

  it("covers CardKit v2 streaming lifecycle", async () => tracked(e2eCases.cardkit, async () => {
    const marker = `eve-lark e2e cardkit ${runId}`;
    const client = realClient({ replyMode: "streaming-v2" });
    const created = await client.createCardEntity({
      card: buildCardKitStreamingCard({
        buffer: `${marker}\ncreating`,
        streamingMode: true,
      }),
    });

    expect(created.cardId).toBeTruthy();

    const sent = await client.sendCardByCardId({
      chatId: chatId(),
      cardId: created.cardId,
    });
    expect(sent.messageId).toMatch(/^om_/);

    await client.streamCardContent({
      cardId: created.cardId,
      elementId: CARDKIT_STREAMING_ELEMENT_ID,
      content: `${marker}\nstreamed`,
      sequence: 2,
    });
    await client.setCardStreamingMode({
      cardId: created.cardId,
      streamingMode: false,
      sequence: 3,
    });
    await client.updateCardKitCard({
      cardId: created.cardId,
      card: buildCardKitFinalCard(`${marker}\nfinal`),
      sequence: 4,
    });

    await waitForMessageContaining(marker, 30_000);
  }), 90_000);

  it("covers long-connection user text to bot reply", async () => tracked(e2eCases.inboundReply, async () => {
    const inboundText = `eve-lark e2e inbound ${runId}`;
    const replyText = `eve-lark e2e reply ${runId}`;
    let inboundSeen: ((value: unknown) => void) | undefined;
    let inboundFailed: ((error: unknown) => void) | undefined;
    let replyDone: ((value: void) => void) | undefined;
    let replyFailed: ((error: unknown) => void) | undefined;
    const inboundPromise = new Promise((resolve, reject) => {
      inboundSeen = resolve;
      inboundFailed = reject;
    });
    const replyPromise = new Promise<void>((resolve, reject) => {
      replyDone = resolve;
      replyFailed = reject;
    });

    try {
      await withLongConnection(
        (channel, waits) => makeReplyingHelpers({
          channel,
          waits,
          expectedText: inboundText,
          replyText,
          onInbound: (message) => inboundSeen?.(message),
          onReplyDone: (error) => {
            if (error) replyFailed?.(error);
            else replyDone?.();
          },
        }),
        async () => {
          const sentMessageId = await sendUserText(inboundText);
          expect(sentMessageId).toMatch(/^om_/);
          await withTimeout(inboundPromise, 75_000, "long-connection inbound event");
          await withTimeout(replyPromise, 75_000, "channel reply delivery");
          const reply = await waitForMessageContaining(replyText, 45_000);
          expect(reply.sender?.sender_type).toBe("app");
        },
      );
    } catch (error) {
      inboundFailed?.(error);
      replyFailed?.(error);
      throw error;
    }
  }), 150_000);

  it("covers ackReaction feedback on inbound user messages", async () => tracked(e2eCases.ackReaction, async () => {
    const marker = `eve-lark e2e ack reaction ${runId}`;
    const emojiType = "THUMBSUP";
    let reactionId: string | undefined;
    let resolveSeen: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });

    try {
      await withLongConnection(
        (_channel, waits) => makeRecordingHelpers((message) => {
          if (textFromChannelMessage(message) === marker) resolveSeen?.();
        }, waits),
        async ({ waits }) => {
          const messageId = await sendUserText(marker);
          await withTimeout(seen, 75_000, "ackReaction inbound marker");
          await waitForCondition(() => waits.length > 0, 5_000, "ackReaction background task");
          await Promise.all(waits.splice(0));
          reactionId = await waitForReaction(messageId, emojiType);
          expect(reactionId).toBeTruthy();
        },
        { ackReaction: emojiType },
      );
    } finally {
      if (reactionId) {
        const messages = await listRecentMessages().catch(() => []);
        const target = messages.find((message) => JSON.stringify(message).includes(marker));
        if (target?.message_id) {
          await deleteReaction("bot", target.message_id, reactionId).catch(() => undefined);
        }
      }
    }
  }), 120_000);

  it("covers per-chat queue serialization for consecutive user messages", async () => tracked(e2eCases.concurrentMessages, async () => {
    const readyMarker = `eve-lark e2e queue-ready ${runId}`;
    const firstMarker = `eve-lark e2e queue-first ${runId}`;
    const secondMarker = `eve-lark e2e queue-second ${runId}`;
    const order: string[] = [];
    let resolveReady: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers(async (message) => {
        const text = textFromChannelMessage(message);
        if (text === readyMarker) {
          resolveReady?.();
          return;
        }
        if (text === firstMarker) {
          order.push("first:start");
          await firstGate;
          order.push("first:end");
          return;
        }
        if (text === secondMarker) {
          order.push("second:start");
        }
      }, waits),
      async () => {
        await sendUserText(readyMarker);
        await withTimeout(ready, 75_000, "queue long-connection live marker");

        await sendUserText(firstMarker);
        await waitForCondition(() => order.includes("first:start"), 75_000, "first queued message start");
        await sendUserText(secondMarker);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(order).toEqual(["first:start"]);

        releaseFirst?.();
        await waitForCondition(() => order.includes("second:start"), 75_000, "second queued message start");
        expect(order).toEqual(["first:start", "first:end", "second:start"]);
      },
    );
  }), 180_000);

  it("covers agent replies quoting the triggering user message", async () => tracked(e2eCases.quoteReply, async () => {
    const inboundText = `eve-lark e2e quote inbound ${runId}`;
    const replyText = `eve-lark e2e quote reply ${runId}`;
    const replyApiCalls: string[] = [];
    let sourceMessageId = "";
    let inboundSeen: ((value: unknown) => void) | undefined;
    let replyDone: ((value: void) => void) | undefined;
    let replyFailed: ((error: unknown) => void) | undefined;
    const inboundPromise = new Promise((resolve) => {
      inboundSeen = resolve;
    });
    const replyPromise = new Promise<void>((resolve, reject) => {
      replyDone = resolve;
      replyFailed = reject;
    });
    const recordingFetch: typeof fetch = async (input, init) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const url = new URL(rawUrl);
      const method = (init?.method ?? "GET").toUpperCase();
      if (
        method === "POST" &&
        sourceMessageId &&
        url.pathname === `/open-apis/im/v1/messages/${encodeURIComponent(sourceMessageId)}/reply`
      ) {
        replyApiCalls.push(url.pathname);
      }
      return fetch(input, init);
    };

    await withLongConnection(
      (channel, waits) => makeReplyingHelpers({
        channel,
        waits,
        expectedText: inboundText,
        replyText,
        onInbound: (message) => inboundSeen?.(message),
        onReplyDone: (error) => {
          if (error) replyFailed?.(error);
          else replyDone?.();
        },
      }),
      async () => {
        sourceMessageId = await sendUserText(inboundText);
        await withTimeout(inboundPromise, 75_000, "quote inbound event");
        await withTimeout(replyPromise, 75_000, "quote reply delivery");
        const reply = await waitForMessageContaining(replyText, 45_000);
        if (!reply.message_id) throw new Error("quote reply message_id missing from lark-cli response.");
        expect(replyApiCalls).toEqual([`/open-apis/im/v1/messages/${encodeURIComponent(sourceMessageId)}/reply`]);
      },
      { replyMode: "post", fetch: recordingFetch },
    );
  }), 150_000);

  it("covers group @ and non-@ messages reaching the agent", async () => tracked(e2eCases.groupMention, async () => {
    const botOpenId = await e2eBotOpenId();
    const readyMarker = `eve-lark e2e mention-ready ${runId}`;
    const plainText = `eve-lark e2e group plain ${runId}`;
    const mentionedText = `eve-lark e2e group mentioned ${runId}`;
    const receivedTexts: string[] = [];
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message) => {
        const text = textFromChannelMessage(message);
        if (text === readyMarker) resolveReady?.();
        if (text === plainText || text === mentionedText) receivedTexts.push(text);
      }, waits),
      async () => {
        await sendUserText(readyMarker);
        await withTimeout(ready, 75_000, "mention long-connection live marker");

        await sendUserText(plainText);
        await waitForCondition(() => receivedTexts.includes(plainText), 75_000, "plain group message");

        await sendUserTextContent(`<at user_id="${botOpenId}">bot</at> ${mentionedText}`);
        await waitForCondition(() => receivedTexts.includes(mentionedText), 75_000, "mentioned group message");
        expect(receivedTexts).toEqual([plainText, mentionedText]);
      },
      { botOpenId },
    );
  }), 180_000);

  it("covers group-level systemPrompt reaching agent context", async () => tracked(e2eCases.groupSystemPrompt, async () => {
    const marker = `eve-lark e2e group prompt ${runId}`;
    const systemPrompt = `System prompt for ${runId}: answer briefly for this group.`;
    let capturedContext: unknown;
    let resolveSeen: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message, opts) => {
        if (textFromChannelMessage(message) !== marker) return;
        capturedContext = (opts as { context?: unknown }).context;
        resolveSeen?.();
      }, waits),
      async () => {
        await sendUserText(marker);
        await withTimeout(seen, 75_000, "group systemPrompt context marker");
        expect(capturedContext).toEqual([systemPrompt]);
      },
      { groupConfigs: [{ chatId: chatId(), systemPrompt }] },
    );
  }), 120_000);

  it("covers group allowlist allow and drop behavior", async () => tracked(e2eCases.groupAllowlist, async () => {
    const allowedMarker = `eve-lark e2e allowlist-allowed ${runId}`;
    const deniedMarker = `eve-lark e2e allowlist-denied ${runId}`;
    let resolveAllowed: (() => void) | undefined;
    const allowed = new Promise<void>((resolve) => {
      resolveAllowed = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message) => {
        if (textFromChannelMessage(message) === allowedMarker) resolveAllowed?.();
      }, waits),
      async () => {
        await sendUserText(allowedMarker);
        await withTimeout(allowed, 75_000, "group allowlist allowed marker");
      },
      { groupAllowFrom: [chatId()] },
    );
    __resetLongConnectionSingletonsForTests();

    const waits: Promise<unknown>[] = [];
    let deniedReachedAgent = false;
    const deniedChannel = createLarkChannel(realOptions({
      mode: "webhook",
      port: nextPort(),
      replyMode: "post",
      groupAllowFrom: [`oc_disallowed_${randomUUID().replaceAll("-", "")}`],
    })) as ChannelForTest;
    const deniedHandler = getWebhookHandler(deniedChannel);
    const deniedResponse = await deniedHandler(
      new Request("http://127.0.0.1/lark/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: "2.0",
          header: {
            event_id: `evt_${randomUUID()}`,
            event_type: "im.message.receive_v1",
            create_time: String(Math.floor(Date.now() / 1000)),
            token: requiredEnv("LARK_VERIFICATION_TOKEN"),
            app_id: requiredEnv("LARK_APP_ID"),
          },
          event: {
            message: {
              message_id: `om_${randomUUID().replaceAll("-", "")}`,
              chat_id: chatId(),
              message_type: "text",
              content: JSON.stringify({ text: deniedMarker }),
            },
            sender: {
              sender_id: { open_id: "ou_e2e_allowlist_denied" },
              sender_type: "user",
            },
            chat_type: "group",
          },
        }),
      }),
      makeRecordingHelpers((message) => {
        if (textFromChannelMessage(message) === deniedMarker) deniedReachedAgent = true;
      }, waits),
    );
    expect(deniedResponse.status).toBe(200);
    await Promise.all(waits);
    expect(deniedReachedAgent).toBe(false);
  }), 180_000);

  it("covers slash command interception", async () => tracked(e2eCases.command, async () => {
    const marker = `trace-${runId}`;
    let agentCalled = false;
    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message) => {
        if (JSON.stringify(message).includes(marker)) {
          agentCalled = true;
        }
      }, waits),
      async ({ waits }) => {
        await sendUserText(`/lark trace ${marker}`);
        await waitForMessageWhere(
          (message) => {
            const serialized = JSON.stringify(message);
            return message.sender?.sender_type === "app" &&
              serialized.includes(marker) &&
              serialized.includes("eve-lark trace");
          },
          45_000,
          `/lark trace response for ${marker}`,
        );
        await Promise.all(waits);
        expect(agentCalled).toBe(false);
      },
    );
  }), 90_000);

  it("covers custom card action handler reply, follow-up, and edit", async () => tracked(e2eCases.customCardAction, async () => {
    const port = nextPort();
    const sourceMarker = `eve-lark e2e custom-action source ${runId}`;
    const replyMarker = `eve-lark e2e custom-action reply ${runId}`;
    const followMarker = `eve-lark e2e custom-action follow-up ${runId}`;
    const editMarker = `eve-lark e2e custom-action edited ${runId}`;
    const waits: Promise<unknown>[] = [];
    const handled: Array<{ action: string; chatId?: string; messageId: string }> = [];
    const channel = createLarkChannel(realOptions({
      mode: "webhook",
      port,
      replyMode: "post",
      cardActionHandler: async (ctx) => {
        handled.push({ action: ctx.action, chatId: ctx.chatId, messageId: ctx.messageId });
        await ctx.respond.reply({ text: replyMarker });
        await ctx.respond.followUp({ text: followMarker });
        await ctx.respond.editMessage({ text: editMarker });
        return { toast: { type: "success", content: "Handled" } };
      },
    })) as ChannelForTest;
    const server = startWebhookServer({
      channel,
      port,
      helpers: makeRecordingHelpers(() => undefined, waits),
    });

    try {
      await listen(server, port);
      const source = await realClient({ replyMode: "post" }).sendCard({
        chatId: chatId(),
        card: buildTextCard(sourceMarker),
      });
      await waitForMessageContaining(sourceMarker, 45_000);
      await postEventToWebhook(
        {
          schema: "2.0",
          header: {
            event_id: `evt_${randomUUID()}`,
            event_type: "card.action.trigger",
            create_time: String(Math.floor(Date.now() / 1000)),
            token: requiredEnv("LARK_VERIFICATION_TOKEN"),
            app_id: requiredEnv("LARK_APP_ID"),
          },
          event: {
            open_id: "ou_e2e_synthetic_user",
            open_chat_id: chatId(),
            tenant_key: "tenant_e2e",
            open_message_id: source.messageId,
            token: "token_e2e",
            action: {
              tag: "button",
              value: {
                action: "e2e.custom_action",
                runId,
              },
            },
          },
        },
        {
          eveWebhookUrl: `http://127.0.0.1:${port}/lark/webhook`,
          encryptKey: optionalEnv("LARK_ENCRYPT_KEY"),
        },
      );

      await Promise.all(waits);
      await waitForMessageContaining(replyMarker, 45_000);
      await waitForMessageContaining(followMarker, 45_000);
      await waitForMessageContaining(editMarker, 45_000);
      expect(handled).toEqual([{ action: "e2e.custom_action", chatId: chatId(), messageId: source.messageId }]);
    } finally {
      await closeServer(server);
    }
  }), 150_000);

  it("covers HITL multi-question form card callback", async () => tracked(e2eCases.hitlForm, async () => {
    const port = nextPort();
    const marker = `eve-lark e2e hitl ${runId}`;
    const waits: Promise<unknown>[] = [];
    const submissions: unknown[] = [];
    const beforeIds = await captureCurrentMessageIds();
    const channel = createLarkChannel(realOptions({
      mode: "webhook",
      port,
      replyMode: "post",
    })) as ChannelForTest;
    const helpers = makeRecordingHelpers((message) => {
      submissions.push(message);
    }, waits);
    const server = startWebhookServer({ channel, port, helpers });

    try {
      await listen(server, port);
      const requestIdName = `q_name_${randomUUID()}`;
      const requestIdMode = `q_mode_${randomUUID()}`;
      const requestIds = [requestIdName, requestIdMode];
      await requestInput(
        channel,
        {
          turnId: `turn_${randomUUID()}`,
          requests: [
            {
              requestId: requestIdName,
              prompt: `${marker} name`,
              allowFreeform: true,
              display: "text",
            },
            {
              requestId: requestIdMode,
              prompt: `${marker} mode`,
              options: [
                { id: "fast", label: "Fast" },
                { id: "careful", label: "Careful" },
              ],
              display: "select",
            },
          ],
        },
      );

      const cardMessage = await waitForNewAppCard(beforeIds, "new HITL app card message");
      await postEventToWebhook(
        {
          schema: "2.0",
          header: {
            event_id: `evt_${randomUUID()}`,
            event_type: "card.action.trigger",
            create_time: String(Math.floor(Date.now() / 1000)),
            token: requiredEnv("LARK_VERIFICATION_TOKEN"),
            app_id: requiredEnv("LARK_APP_ID"),
          },
          event: {
            open_id: "ou_e2e_synthetic_user",
            tenant_key: "tenant_e2e",
            open_message_id: cardMessage.message_id,
            token: "token_e2e",
            action: {
              tag: "button",
              value: {
                [ASK_FORM_VALUE_MARKER]: true,
                requestIds,
              },
              form_value: {
                [requestIdName]: "Ada",
                [requestIdMode]: "fast",
              },
            },
          },
        },
        {
          eveWebhookUrl: `http://127.0.0.1:${port}/lark/webhook`,
          encryptKey: optionalEnv("LARK_ENCRYPT_KEY"),
        },
      );

      await waitForCondition(() => waits.length > 0, 2_000, "HITL callback background task");
      await Promise.all(waits);
      expect(submissions).toHaveLength(1);
      expect(JSON.stringify(submissions[0])).toContain(requestIdName);
      expect(JSON.stringify(submissions[0])).toContain(requestIdMode);
      expect(JSON.stringify(submissions[0])).toContain("fast");
    } finally {
      await closeServer(server);
    }
  }), 120_000);

  it("covers HITL freeform text interception", async () => tracked(e2eCases.hitlFreeform, async () => {
    const requestId = `q_free_${randomUUID()}`;
    const answer = `freeform answer ${runId}`;
    const readyMarker = `eve-lark e2e hitl-freeform-ready ${runId}`;
    const submissions: unknown[] = [];
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message) => {
        const serialized = JSON.stringify(message);
        if (serialized.includes(readyMarker)) {
          resolveReady?.();
        }
        if (serialized.includes(requestId)) {
          submissions.push(message);
        }
      }, waits),
      async ({ channel }) => {
        await sendUserText(readyMarker);
        await withTimeout(ready, 75_000, "freeform long-connection live marker");

        await requestInput(channel, {
          turnId: `turn_${randomUUID()}`,
          requests: [{
            requestId,
            prompt: `What should I remember for ${runId}?`,
            allowFreeform: true,
            display: "text",
          }],
        });

        await sendUserText(answer);
        await waitForCondition(() => submissions.length === 1, 75_000, "freeform input response");
        expect(submissions[0]).toEqual({ inputResponses: [{ requestId, text: answer }] });
      },
    );
  }), 120_000);

  it("covers HITL option-label text reply and invalid hint", async () => tracked(e2eCases.hitlOptionText, async () => {
    const optionRequestId = `q_option_${randomUUID()}`;
    const invalidRequestId = `q_invalid_${randomUUID()}`;
    const readyMarker = `eve-lark e2e hitl-option-ready ${runId}`;
    const optionSubmissions: unknown[] = [];
    const invalidSubmissions: unknown[] = [];
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    await withLongConnection(
      (_channel, waits) => makeRecordingHelpers((message) => {
        const serialized = JSON.stringify(message);
        if (serialized.includes(readyMarker)) resolveReady?.();
        if (serialized.includes(optionRequestId)) optionSubmissions.push(message);
        if (serialized.includes(invalidRequestId)) invalidSubmissions.push(message);
      }, waits),
      async ({ channel }) => {
        await sendUserText(readyMarker);
        await withTimeout(ready, 75_000, "option long-connection live marker");

        await requestInput(channel, {
          turnId: `turn_${randomUUID()}`,
          requests: [{
            requestId: optionRequestId,
            prompt: `Pick one by text for ${runId}`,
            options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
          }],
        });
        await sendUserText("yes");
        await waitForCondition(() => optionSubmissions.length === 1, 75_000, "option-label text input response");
        expect(optionSubmissions[0]).toEqual({ inputResponses: [{ requestId: optionRequestId, optionId: "yes" }] });

        const invalidPrompt = `Only Yes or No for ${runId}`;
        await requestInput(channel, {
          turnId: `turn_${randomUUID()}`,
          requests: [{
            requestId: invalidRequestId,
            prompt: invalidPrompt,
            options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
          }],
        });
        await sendUserText(`maybe ${runId}`);
        await waitForMessageWhere(
          (message) => {
            const serialized = JSON.stringify(message);
            return message.sender?.sender_type === "app" &&
              message.msg_type === "text" &&
              serialized.includes("This conversation is waiting for your answer") &&
              serialized.includes(invalidPrompt) &&
              serialized.includes("Yes") &&
              serialized.includes("No");
          },
          45_000,
          "pending-input invalid-answer hint",
        );
        expect(invalidSubmissions).toHaveLength(0);
      },
    );
  }), 180_000);

  it("covers HITL card callback retry and TTL expiry", async () => tracked(e2eCases.hitlRetryTtl, async () => {
    {
      const port = nextPort();
      const waits: Promise<unknown>[] = [];
      const submissions: unknown[] = [];
      let sendAttempts = 0;
      const channel = createLarkChannel(realOptions({
        mode: "webhook",
        port,
        replyMode: "post",
      })) as ChannelForTest;
      const helpers = makeRecordingHelpers((message) => {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new Error("synthetic injection temporarily unavailable");
        }
        submissions.push(message);
      }, waits);
      const server = startWebhookServer({ channel, port, helpers });

      try {
        await listen(server, port);

        const retryRequestId = `q_retry_${randomUUID()}`;
        const retryBeforeIds = await captureCurrentMessageIds();
        await requestInput(channel, {
          turnId: `turn_${randomUUID()}`,
          requests: [{
            requestId: retryRequestId,
            prompt: `Retry callback for ${runId}`,
            options: [{ id: "ok", label: "OK" }],
          }],
        });
        const retryCard = await waitForNewAppCard(retryBeforeIds, "retryable HITL card");

        await postAskButtonAction({
          port,
          cardMessageId: retryCard.message_id!,
          requestId: retryRequestId,
          optionId: "ok",
        });
        await waitForCondition(() => waits.length > 0, 2_000, "first retry callback background task");
        await Promise.all(waits.splice(0));
        expect(submissions).toHaveLength(0);

        await postAskButtonAction({
          port,
          cardMessageId: retryCard.message_id!,
          requestId: retryRequestId,
          optionId: "ok",
        });
        await waitForCondition(() => waits.length > 0, 2_000, "second retry callback background task");
        await Promise.all(waits.splice(0));
        expect(submissions).toEqual([{ inputResponses: [{ requestId: retryRequestId, optionId: "ok" }] }]);
      } finally {
        await closeServer(server);
      }
    }

    {
      const port = nextPort();
      const waits: Promise<unknown>[] = [];
      const ttlSubmissions: unknown[] = [];
      const channel = createLarkChannel(realOptions({
        mode: "webhook",
        port,
        replyMode: "post",
        askInputTtlMs: 800,
      })) as ChannelForTest;
      const helpers = makeRecordingHelpers((message) => {
        ttlSubmissions.push(message);
      }, waits);
      const server = startWebhookServer({ channel, port, helpers });

      try {
        await listen(server, port);

        const ttlRequestId = `q_ttl_${randomUUID()}`;
        const ttlBeforeIds = await captureCurrentMessageIds();
        await requestInput(channel, {
          turnId: `turn_${randomUUID()}`,
          requests: [{
            requestId: ttlRequestId,
            prompt: `TTL callback for ${runId}`,
            options: [{ id: "late", label: "Too Late" }],
          }],
        });
        const ttlCard = await waitForNewAppCard(ttlBeforeIds, "expiring HITL card");
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        await postAskButtonAction({
          port,
          cardMessageId: ttlCard.message_id!,
          requestId: ttlRequestId,
          optionId: "late",
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(ttlSubmissions).toHaveLength(0);
      } finally {
        await closeServer(server);
      }
    }
  }), 150_000);

  it("covers reaction event as synthetic input", async () => tracked(e2eCases.reaction, async () => {
    const target = await realClient({ replyMode: "post" }).sendPost({
      chatId: chatId(),
      content: `eve-lark e2e reaction event target ${runId}`,
    });
    let reactionId: string | undefined;
    let resolveSeen: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => {
      resolveSeen = resolve;
    });

    try {
      await withLongConnection(
        (_channel, waits) => makeRecordingHelpers((message) => {
          if (JSON.stringify(message).includes(`[reacted with THUMBSUP to message ${target.messageId}]`)) {
            resolveSeen?.();
          }
        }, waits),
        async () => {
          reactionId = await addUserReaction(target.messageId, "THUMBSUP");
          try {
            await withTimeout(seen, 75_000, "reaction.created long-connection event");
          } catch (error) {
            throw new Error(
              "Reaction event E2E did not receive im.message.reaction.created_v1. Ensure the app has bot scope im:message.reactions:read and the developer console subscribes to im.message.reaction.created_v1.",
              { cause: error },
            );
          }
        },
      );
    } finally {
      if (reactionId) {
        await deleteUserReaction(target.messageId, reactionId).catch(() => undefined);
      }
    }
  }), 120_000);

  it("covers file inbound and resource download", async () => tracked(e2eCases.file, async () => {
    const expected = `eve-lark e2e file payload ${runId}`;
    const relativePath = `.e2e-tmp/${runId}.txt`;
    const fileName = `${runId}.txt`;
    await mkdir(".e2e-tmp", { recursive: true });
    await writeFile(relativePath, expected, "utf8");
    const fileKey = await uploadBotFile(relativePath, fileName);

    let resolveReceived: (() => void) | undefined;
    const received = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    await withLongConnection(
        (channel, waits) => makeRecordingHelpers(async (message) => {
          void channel;
          const parts = Array.isArray(message) ? message : [];
          const filePart = parts.find((part) => {
            return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "file";
          }) as { data?: unknown; mediaType?: unknown } | undefined;
          if (!filePart) return;
          const resource = parseResourceUrl(String(filePart.data));
          const bytes = await realClient({ mode: "webhook" }).downloadResource(resource);
          expect(bytes.toString("utf8")).toBe(expected);
          resolveReceived?.();
        }, waits),
        async () => {
          const sent = await sendUserFile(fileKey);
          expect(sent).toMatch(/^om_/);
          await withTimeout(received, 90_000, "file inbound and download");
        },
    );
  }), 120_000);
});
