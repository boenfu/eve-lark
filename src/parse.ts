import type {
  LarkInboundEvent,
  LarkInboundFile,
  LarkInboundResult,
  LarkMention,
  LarkRawMention,
} from "./types.js";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function mimeFromExt(filename: string | undefined): string {
  if (!filename) return "application/octet-stream";
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[filename.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

function mentionFromRaw(m: LarkRawMention, botOpenId: string | undefined): LarkMention {
  const isOpenIdOfBot =
    !!botOpenId && !!m.id.open_id && m.id.open_id === botOpenId;
  const isAll = !!m.id.open_id && m.id.open_id === "all";
  return {
    key: m.key,
    id: {
      openId: m.id.open_id,
      userId: m.id.user_id,
      unionId: m.id.union_id,
    },
    name: m.name,
    idType: m.id_type ?? "open_id",
    isOpenIdOfBot,
    isAll,
  };
}

function stripBotMentions(text: string, mentions: LarkMention[]): string {
  // Feishu ships mentions as opaque placeholders (e.g. "@_user_1") in the text
  // body alongside a structured mentions array. Rewrite them to something the
  // model can read:
  //   - the bot itself: dropped (the model already knows it's being addressed)
  //   - @all: replaced with a literal "@all" token
  //   - other users: replaced with "@<display name>"
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    if (m.isOpenIdOfBot) {
      out = out.split(m.key).join("");
    } else if (m.isAll) {
      out = out.split(m.key).join("@all");
    } else {
      out = out.split(m.key).join(`@${m.name}`);
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

interface ParsedContent {
  text: string;
  files: LarkInboundFile[];
}

type ContentConverter = (content: Record<string, unknown>) => ParsedContent;

export interface LarkParseExpandOptions {
  fetchMessageContent?: (messageId: string) => Promise<string | null | undefined>;
  fetchMergedMessages?: (messageId: string) => Promise<readonly LarkInboundEvent[]>;
}

function parseContent(messageType: string, rawContent: string): ParsedContent {
  if (!rawContent) return { text: "", files: [] };
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return { text: "", files: [] };
  }

  return (CONTENT_CONVERTERS.get(messageType) ?? convertUnknown)(content);
}

const CONTENT_CONVERTERS = new Map<string, ContentConverter>([
  ["text", convertText],
  ["image", convertImage],
  ["file", convertFile],
  ["post", convertPost],
  ["audio", convertAudio],
  ["media", convertVideo],
  ["video", convertVideo],
  ["sticker", convertSticker],
  ["share_chat", convertShareChat],
  ["share_user", convertShareUser],
  ["location", convertLocation],
  ["todo", convertTodo],
  ["vote", convertVote],
  ["system", convertSystem],
  ["interactive", convertInteractive],
  ["merge_forward", () => ({ text: "<forwarded_messages/>", files: [] })],
]);

function convertText(content: Record<string, unknown>): ParsedContent {
  return { text: typeof content.text === "string" ? content.text : "", files: [] };
}

function convertImage(content: Record<string, unknown>): ParsedContent {
  const imageKey = readString(content.image_key);
  if (!imageKey) return { text: "", files: [] };
  return {
    text: "",
    files: [{ fileKey: imageKey, mediaType: "image/png", kind: "image" }],
  };
}

function convertFile(content: Record<string, unknown>): ParsedContent {
  const fileKey = readString(content.file_key);
  if (!fileKey) return { text: "", files: [] };
  const fileName = readString(content.file_name);
  return {
    text: "",
    files: [{
      fileKey,
      ...(fileName ? { fileName } : {}),
      mediaType: mimeFromExt(fileName),
      kind: "file",
    }],
  };
}

function convertPost(content: Record<string, unknown>): ParsedContent {
  const locale = (content.zh_cn ?? content.en_us ?? content.ja_jp ?? null) as
    | { content?: unknown[][] }
    | null;
  if (!locale?.content) return { text: "", files: [] };
  const text = locale.content
    .map((line) => line.flatMap(convertPostNode).join(" "))
    .filter(Boolean)
    .join(" ");
  return { text, files: [] };
}

function convertPostNode(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const tag = readString(node.tag);
  if (tag === "text") {
    const text = readString(node.text);
    return text ? [text] : [];
  }
  if (tag === "at") {
    const name = readString(node.user_name) ?? readString(node.text);
    return name ? [`@${name}`] : [];
  }
  return [];
}

function convertAudio(content: Record<string, unknown>): ParsedContent {
  const fileKey = readString(content.file_key);
  if (!fileKey) return { text: "[audio]", files: [] };
  const duration = readNumber(content.duration);
  const durationAttr = duration !== undefined ? ` duration="${formatDuration(duration)}"` : "";
  return {
    text: `<audio key="${escapeAttr(fileKey)}"${durationAttr}/>`,
    files: [{
      fileKey,
      mediaType: "audio/ogg",
      kind: "audio",
      ...(duration !== undefined ? { duration } : {}),
    }],
  };
}

function convertVideo(content: Record<string, unknown>): ParsedContent {
  const fileKey = readString(content.file_key);
  if (!fileKey) return { text: "[video]", files: [] };
  const fileName = readString(content.file_name);
  const duration = readNumber(content.duration);
  const nameAttr = fileName ? ` name="${escapeAttr(fileName)}"` : "";
  const durationAttr = duration !== undefined ? ` duration="${formatDuration(duration)}"` : "";
  return {
    text: `<video key="${escapeAttr(fileKey)}"${nameAttr}${durationAttr}/>`,
    files: [{
      fileKey,
      ...(fileName ? { fileName } : {}),
      mediaType: mimeFromExt(fileName) === "application/octet-stream" ? "video/mp4" : mimeFromExt(fileName),
      kind: "video",
      ...(duration !== undefined ? { duration } : {}),
    }],
  };
}

function convertSticker(content: Record<string, unknown>): ParsedContent {
  const fileKey = readString(content.file_key);
  if (!fileKey) return { text: "[sticker]", files: [] };
  return {
    text: `<sticker key="${escapeAttr(fileKey)}"/>`,
    files: [{ fileKey, mediaType: "image/png", kind: "sticker" }],
  };
}

function convertShareChat(content: Record<string, unknown>): ParsedContent {
  return { text: `<group_card id="${escapeAttr(readString(content.chat_id) ?? "")}"/>`, files: [] };
}

function convertShareUser(content: Record<string, unknown>): ParsedContent {
  return { text: `<contact_card id="${escapeAttr(readString(content.user_id) ?? "")}"/>`, files: [] };
}

function convertLocation(content: Record<string, unknown>): ParsedContent {
  const name = readString(content.name);
  const lat = readString(content.latitude);
  const lng = readString(content.longitude);
  const attrs = [
    name ? ` name="${escapeAttr(name)}"` : "",
    lat && lng ? ` coords="lat:${escapeAttr(lat)},lng:${escapeAttr(lng)}"` : "",
  ].join("");
  return { text: `<location${attrs}/>`, files: [] };
}

function convertTodo(content: Record<string, unknown>): ParsedContent {
  const summary = isRecord(content.summary) ? content.summary : {};
  const title = readString(summary.title);
  const body = Array.isArray(summary.content)
    ? summary.content.map((line) => Array.isArray(line) ? line.flatMap(convertPostNode).join("") : "").filter(Boolean).join("\n")
    : "";
  const due = readString(content.due_time);
  const parts = [title, body, due ? `Due: ${millisToDatetime(due)}` : ""].filter(Boolean);
  return { text: `<todo>\n${parts.join("\n") || "[todo]"}\n</todo>`, files: [] };
}

function convertVote(content: Record<string, unknown>): ParsedContent {
  const topic = readString(content.topic);
  const options = Array.isArray(content.options)
    ? content.options.filter((opt): opt is string => typeof opt === "string")
    : [];
  return { text: `<vote>\n${[topic, ...options.map((opt) => `- ${opt}`)].filter(Boolean).join("\n") || "[vote]"}\n</vote>`, files: [] };
}

function convertSystem(content: Record<string, unknown>): ParsedContent {
  const template = readString(content.template);
  if (!template) return { text: "[system message]", files: [] };
  const replacements: Record<string, string> = {
    "{from_user}": readStringArray(content.from_user).join(", "),
    "{to_chatters}": readStringArray(content.to_chatters).join(", "),
    "{divider_text}": isRecord(content.divider_text) ? readString(content.divider_text.text) ?? "" : "",
  };
  let text = template;
  for (const [key, value] of Object.entries(replacements)) {
    text = text.split(key).join(value);
  }
  return { text: text.trim(), files: [] };
}

function convertInteractive(content: Record<string, unknown>): ParsedContent {
  const texts = collectCardText(content).filter(Boolean);
  return {
    text: texts.length > 0 ? `<card>\n${texts.join("\n")}\n</card>` : "<card/>",
    files: [],
  };
}

function convertUnknown(): ParsedContent {
  return { text: "", files: [] };
}

function collectCardText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectCardText);
  if (!isRecord(value)) return [];
  const out: string[] = [];
  const content = readString(value.content);
  const text = readString(value.text);
  if (content) out.push(content);
  if (text) out.push(text);
  for (const [key, nested] of Object.entries(value)) {
    if (key === "tag" || key === "type" || key === "template" || key === "schema" || key === "element_id") continue;
    if (nested !== content && nested !== text) {
      out.push(...collectCardText(nested));
    }
  }
  return dedupeStrings(out);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${ms}ms`;
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds.toFixed(1)}s`;
}

function millisToDatetime(ms: string): string {
  const num = Number(ms);
  if (!Number.isFinite(num)) return ms;
  const d = new Date(num + 8 * 60 * 60 * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function parseInbound(
  event: LarkInboundEvent,
  botOpenId?: string,
): LarkInboundResult {
  const messageType = event.message.message_type;
  const parsed = parseContent(messageType, event.message.content);
  const rawMentions = event.message.mentions ?? [];
  const mentions = rawMentions.map((m) => mentionFromRaw(m, botOpenId));

  const senderOpenId =
    event.sender.sender_id.open_id ??
    event.sender.sender_id.user_id ??
    event.sender.sender_id.union_id ??
    "";

  const text =
    messageType === "text"
      ? stripBotMentions(parsed.text, mentions)
      : parsed.text;

  const rawChatType = event.chat_type ?? event.message.chat_type;
  const chatType = rawChatType === "group" ? "group" : "p2p";
  const senderType = event.sender.sender_type === "app" ? "app" : "user";

  return {
    text,
    files: parsed.files,
    chatId: event.message.chat_id,
    rootId: event.message.root_id ?? null,
    parentId: event.message.parent_id ?? null,
    messageId: event.message.message_id,
    senderOpenId,
    senderType,
    chatType,
    mentions,
  };
}

export async function parseInboundAsync(
  event: LarkInboundEvent,
  botOpenId?: string,
  expand?: LarkParseExpandOptions,
): Promise<LarkInboundResult> {
  if (event.message.message_type === "interactive" && expand?.fetchMessageContent) {
    const content = await expand.fetchMessageContent(event.message.message_id);
    if (content) {
      return parseInbound({
        ...event,
        message: { ...event.message, content },
      }, botOpenId);
    }
  }

  if (event.message.message_type === "merge_forward" && expand?.fetchMergedMessages) {
    const children = await expand.fetchMergedMessages(event.message.message_id);
    const parsedChildren = await Promise.all(
      children.map((child) => parseInboundAsync(child, botOpenId, expand)),
    );
    const text = [
      "<forwarded_messages>",
      ...parsedChildren.map((child) => {
        const body = child.text.trim() || (child.files.length > 0 ? "[attachment]" : "[empty]");
        return `${child.senderOpenId}: ${body}`;
      }),
      "</forwarded_messages>",
    ].join("\n");
    const base = parseInbound(event, botOpenId);
    return {
      ...base,
      text,
      files: parsedChildren.flatMap((child) => child.files),
    };
  }

  return parseInbound(event, botOpenId);
}
