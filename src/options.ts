import { LarkConfigError } from "./errors.js";
import type {
  LarkChannelOptions,
  LarkReplyMode,
  LarkTransportMode,
  ResolvedLarkOptions,
} from "./types.js";

const DEFAULTS = {
  baseUrl: "https://open.feishu.cn",
  webhookPath: "/lark/webhook",
  // "post" renders at native chat-message size with full markdown support
  // (bold, links, code, color tags). Cards render noticeably smaller because
  // Feishu treats them as "structured content". The tradeoff: post can't be
  // live-patched during streaming — users who want streaming should set
  // replyMode: "streaming" explicitly.
  replyMode: "post" as LarkReplyMode,
  streamPatchIntervalMs: 1000,
  streamCreateThresholdMs: 400,
  dedupTtlMs: 30 * 60 * 1000,
  dedupMaxEntries: 5000,
  requestTimeoutMs: 15000,
  maxRetries: 2,
  tokenRefreshBufferMs: 5 * 60 * 1000,
  signatureSkewMs: 5 * 60 * 1000,
  ackReaction: "Typing" as string | false,
  mode: "long-connection" as LarkTransportMode,
};

const ENV_KEYS = {
  appId: "LARK_APP_ID",
  appSecret: "LARK_APP_SECRET",
  verificationToken: "LARK_VERIFICATION_TOKEN",
  encryptKey: "LARK_ENCRYPT_KEY",
  baseUrl: "LARK_BASE_URL",
  botOpenId: "LARK_BOT_OPEN_ID",
  replyMode: "LARK_REPLY_MODE",
  mode: "LARK_MODE",
} as const;

export type ResolveEnv = Record<string, string | undefined>;

function defaultEnv(): ResolveEnv {
  if (typeof process !== "undefined" && process.env) {
    return process.env as ResolveEnv;
  }
  return {};
}

function pick(input: string | undefined, envValue: string | undefined): string | undefined {
  return input ?? envValue;
}

export function resolveOptions(
  options: LarkChannelOptions,
  env: ResolveEnv = defaultEnv(),
): ResolvedLarkOptions {
  const appId = pick(options.appId, env[ENV_KEYS.appId]);
  const appSecret = pick(options.appSecret, env[ENV_KEYS.appSecret]);
  const verificationToken = pick(
    options.verificationToken,
    env[ENV_KEYS.verificationToken],
  );

  if (!appId) {
    throw new LarkConfigError(
      `eve-lark: appId is required (option \`appId\` or env \`${ENV_KEYS.appId}\`)`,
    );
  }
  if (!appSecret) {
    throw new LarkConfigError(
      `eve-lark: appSecret is required (option \`appSecret\` or env \`${ENV_KEYS.appSecret}\`)`,
    );
  }
  if (!verificationToken) {
    throw new LarkConfigError(
      `eve-lark: verificationToken is required (option \`verificationToken\` or env \`${ENV_KEYS.verificationToken}\`)`,
    );
  }

  const rawBaseUrl = pick(options.baseUrl, env[ENV_KEYS.baseUrl]) ?? DEFAULTS.baseUrl;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");

  const replyModeEnv = env[ENV_KEYS.replyMode];
  const replyMode: LarkReplyMode =
    options.replyMode ??
    (replyModeEnv === "post" || replyModeEnv === "static" || replyModeEnv === "streaming" || replyModeEnv === "streaming-v2"
      ? replyModeEnv
      : DEFAULTS.replyMode);

  const modeEnv = env[ENV_KEYS.mode];
  const mode: LarkTransportMode =
    options.mode ??
    (modeEnv === "webhook" || modeEnv === "long-connection" ? modeEnv : DEFAULTS.mode);

  return {
    appId,
    appSecret,
    verificationToken,
    encryptKey: pick(options.encryptKey, env[ENV_KEYS.encryptKey]),
    baseUrl,
    botOpenId: pick(options.botOpenId, env[ENV_KEYS.botOpenId]),
    webhookPath: options.webhookPath ?? DEFAULTS.webhookPath,
    replyMode,
    streamPatchIntervalMs: options.streamPatchIntervalMs ?? DEFAULTS.streamPatchIntervalMs,
    streamCreateThresholdMs: options.streamCreateThresholdMs ?? DEFAULTS.streamCreateThresholdMs,
    dedupTtlMs: options.dedupTtlMs ?? DEFAULTS.dedupTtlMs,
    dedupMaxEntries: options.dedupMaxEntries ?? DEFAULTS.dedupMaxEntries,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    tokenRefreshBufferMs: options.tokenRefreshBufferMs ?? DEFAULTS.tokenRefreshBufferMs,
    signatureSkewMs: options.signatureSkewMs ?? DEFAULTS.signatureSkewMs,
    fetch: options.fetch ?? globalThis.fetch,
    ackReaction: options.ackReaction ?? DEFAULTS.ackReaction,
    mode,
    port:
      options.port ??
      (process.env.PORT ? Number(process.env.PORT) : 2000),
    allowFrom: options.allowFrom,
    groupAllowFrom: options.groupAllowFrom,
    groupConfigs: options.groupConfigs,
    asrProvider: options.asrProvider,
  };
}
