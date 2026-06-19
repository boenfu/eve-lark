import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  platform: "node",
  keepNames: true,
  // The channel dynamic-imports the lark SDK only when mode="long-connection".
  // Keep it external so users who only use mode="webhook" don't pay the
  // ~5 MB install.
  external: ["@larksuiteoapi/node-sdk"],
});
