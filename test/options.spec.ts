import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOptions } from "../src/options.js";
import { LarkConfigError } from "../src/errors.js";

const REQUIRED_ENV = {
  LARK_APP_ID: "cli_test_app",
  LARK_APP_SECRET: "secret_test_app",
  LARK_VERIFICATION_TOKEN: "tok_verify",
};

function makeEnv(extra: Record<string, string | undefined> = {}) {
  return { ...REQUIRED_ENV, ...extra };
}

describe("resolveOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses explicit values when provided", () => {
    const opts = resolveOptions(
      {
        appId: "explicit_app",
        appSecret: "explicit_secret",
        verificationToken: "explicit_token",
      },
      makeEnv(),
    );
    expect(opts.appId).toBe("explicit_app");
    expect(opts.appSecret).toBe("explicit_secret");
    expect(opts.verificationToken).toBe("explicit_token");
  });

  it("falls back to env vars when option is undefined", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.appId).toBe("cli_test_app");
    expect(opts.appSecret).toBe("secret_test_app");
    expect(opts.verificationToken).toBe("tok_verify");
  });

  it("throws LarkConfigError when appId is missing", () => {
    expect(() =>
      resolveOptions({}, { ...REQUIRED_ENV, LARK_APP_ID: undefined }),
    ).toThrow(LarkConfigError);
  });

  it("throws LarkConfigError when appSecret is missing", () => {
    expect(() =>
      resolveOptions({}, { ...REQUIRED_ENV, LARK_APP_SECRET: undefined }),
    ).toThrow(LarkConfigError);
  });

  it("throws LarkConfigError when verificationToken is missing", () => {
    expect(() =>
      resolveOptions(
        {},
        { ...REQUIRED_ENV, LARK_VERIFICATION_TOKEN: undefined },
      ),
    ).toThrow(LarkConfigError);
  });

  it("defaults baseUrl to https://open.feishu.cn", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.baseUrl).toBe("https://open.feishu.cn");
  });

  it("honors LARK_BASE_URL env for international Lark", () => {
    const opts = resolveOptions(
      {},
      makeEnv({ LARK_BASE_URL: "https://open.larksuite.com" }),
    );
    expect(opts.baseUrl).toBe("https://open.larksuite.com");
  });

  it("strips a trailing slash from baseUrl", () => {
    const opts = resolveOptions(
      { baseUrl: "https://open.feishu.cn/" },
      makeEnv(),
    );
    expect(opts.baseUrl).toBe("https://open.feishu.cn");
  });

  it("defaults webhookPath to /lark/webhook", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.webhookPath).toBe("/lark/webhook");
  });

  it("defaults replyMode to streaming", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.replyMode).toBe("streaming");
  });

  it("defaults dedupTtlMs to 30 minutes", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.dedupTtlMs).toBe(30 * 60 * 1000);
  });

  it("defaults dedupMaxEntries to 5000", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.dedupMaxEntries).toBe(5000);
  });

  it("defaults fetch to globalThis.fetch", () => {
    const opts = resolveOptions({}, makeEnv());
    expect(opts.fetch).toBe(globalThis.fetch);
  });

  it("uses provided fetch override", () => {
    const custom = vi.fn() as unknown as typeof fetch;
    const opts = resolveOptions({ fetch: custom }, makeEnv());
    expect(opts.fetch).toBe(custom);
  });

  it("loads encryptKey from option or env when set", () => {
    expect(
      resolveOptions({ encryptKey: "from_opt" }, makeEnv()).encryptKey,
    ).toBe("from_opt");
    expect(
      resolveOptions({}, makeEnv({ LARK_ENCRYPT_KEY: "from_env" })).encryptKey,
    ).toBe("from_env");
  });

  it("returns undefined encryptKey when neither option nor env is set", () => {
    expect(resolveOptions({}, makeEnv()).encryptKey).toBeUndefined();
  });

  it("reads LARK_MODE to switch transport", () => {
    expect(
      resolveOptions({}, makeEnv({ LARK_MODE: "webhook" })).mode,
    ).toBe("webhook");
    expect(
      resolveOptions({}, makeEnv({ LARK_MODE: "long-connection" })).mode,
    ).toBe("long-connection");
    // Unknown value falls back to default.
    expect(
      resolveOptions({}, makeEnv({ LARK_MODE: "bogus" })).mode,
    ).toBe("long-connection");
  });

  it("option overrides LARK_MODE env", () => {
    expect(
      resolveOptions({ mode: "webhook" }, makeEnv({ LARK_MODE: "long-connection" })).mode,
    ).toBe("webhook");
  });

  it("reads LARK_REPLY_MODE to switch streaming/static", () => {
    expect(
      resolveOptions({}, makeEnv({ LARK_REPLY_MODE: "static" })).replyMode,
    ).toBe("static");
    expect(
      resolveOptions({}, makeEnv({ LARK_REPLY_MODE: "streaming" })).replyMode,
    ).toBe("streaming");
    expect(
      resolveOptions({}, makeEnv({ LARK_REPLY_MODE: "bogus" })).replyMode,
    ).toBe("streaming");
  });

  it("preserves all timing/limit overrides", () => {
    const opts = resolveOptions(
      {
        streamPatchIntervalMs: 500,
        streamCreateThresholdMs: 200,
        requestTimeoutMs: 8000,
        maxRetries: 3,
        tokenRefreshBufferMs: 60000,
        signatureSkewMs: 120000,
      },
      makeEnv(),
    );
    expect(opts.streamPatchIntervalMs).toBe(500);
    expect(opts.streamCreateThresholdMs).toBe(200);
    expect(opts.requestTimeoutMs).toBe(8000);
    expect(opts.maxRetries).toBe(3);
    expect(opts.tokenRefreshBufferMs).toBe(60000);
    expect(opts.signatureSkewMs).toBe(120000);
  });
});
