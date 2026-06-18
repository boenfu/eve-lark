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

function parseContent(messageType: string, rawContent: string): ParsedContent {
  if (!rawContent) return { text: "", files: [] };
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return { text: "", files: [] };
  }

  switch (messageType) {
    case "text": {
      const text = typeof content.text === "string" ? content.text : "";
      return { text, files: [] };
    }
    case "image": {
      const imageKey = typeof content.image_key === "string" ? content.image_key : "";
      if (!imageKey) return { text: "", files: [] };
      return {
        text: "",
        files: [{ fileKey: imageKey, mediaType: "image/png", kind: "image" }],
      };
    }
    case "file": {
      const fileKey = typeof content.file_key === "string" ? content.file_key : "";
      if (!fileKey) return { text: "", files: [] };
      const fileName = typeof content.file_name === "string" ? content.file_name : undefined;
      return {
        text: "",
        files: [{ fileKey, mediaType: mimeFromExt(fileName), kind: "file" }],
      };
    }
    case "post": {
      const locale = (content.zh_cn ?? content.en_us ?? content.ja_jp ?? null) as
        | { content?: unknown[][] }
        | null;
      if (!locale?.content) return { text: "", files: [] };
      const text = locale.content
        .flatMap((line) =>
          (line ?? [])
            .filter((node): node is { tag: string; text?: unknown } => {
              if (typeof node !== "object" || node === null) return false;
              const tag = (node as { tag?: unknown }).tag;
              const text = (node as { text?: unknown }).text;
              return tag === "text" && typeof text === "string";
            })
            .map((node) => node.text as string),
        )
        .join(" ");
      return { text, files: [] };
    }
    default:
      // audio, media, sticker, share_chat, share_user, interactive — not in v1 scope.
      return { text: "", files: [] };
  }
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

  const chatType = event.chat_type === "group" ? "group" : "p2p";
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
