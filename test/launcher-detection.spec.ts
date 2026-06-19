import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEveStartLauncher } from "../src/long-connection.js";

describe("isEveStartLauncher", () => {
  const originalArgv = process.argv;
  const originalEnv = process.env.EVE_LARK_FORCE_WS;

  beforeEach(() => {
    process.argv = ["node", "/some/path", "irrelevant"];
    delete process.env.EVE_LARK_FORCE_WS;
  });
  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.EVE_LARK_FORCE_WS;
    else process.env.EVE_LARK_FORCE_WS = originalEnv;
  });

  it("returns true for pnpm-style eve start", () => {
    process.argv = [
      "node",
      "/x/.pnpm/eve@0.11.4/node_modules/eve/bin/eve.js",
      "start",
    ];
    expect(isEveStartLauncher()).toBe(true);
  });

  it("returns true for npm-style eve start", () => {
    process.argv = ["node", "/proj/node_modules/eve/bin/eve.js", "start"];
    expect(isEveStartLauncher()).toBe(true);
  });

  it("returns true for eve.MJS / eve.CJS variants", () => {
    process.argv = ["node", "/proj/node_modules/eve/bin/eve.mjs", "start"];
    expect(isEveStartLauncher()).toBe(true);
    process.argv = ["node", "/proj/node_modules/eve/bin/eve.cjs", "start"];
    expect(isEveStartLauncher()).toBe(true);
  });

  it("returns true for bin shim (no extension)", () => {
    process.argv = ["node", "/proj/node_modules/eve/bin/eve", "start"];
    expect(isEveStartLauncher()).toBe(true);
  });

  it("returns false for eve dev (single-process, must start WSClient)", () => {
    process.argv = ["node", "/proj/node_modules/eve/bin/eve.js", "dev"];
    expect(isEveStartLauncher()).toBe(false);
  });

  it("returns false for spawned nitro server child", () => {
    process.argv = ["node", "/proj/.output/server/index.mjs"];
    expect(isEveStartLauncher()).toBe(false);
  });

  it("returns false for arbitrary node script", () => {
    process.argv = ["node", "/somewhere/my-bot.mjs"];
    expect(isEveStartLauncher()).toBe(false);
  });

  it("EVE_LARK_FORCE_WS=1 forces 'not launcher' regardless of argv", () => {
    process.env.EVE_LARK_FORCE_WS = "1";
    process.argv = ["node", "/proj/node_modules/eve/bin/eve.js", "start"];
    expect(isEveStartLauncher()).toBe(false);
  });
});
