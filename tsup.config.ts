import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node22",
  platform: "node",
  keepNames: true,
  // The SDK is a hard runtime dep (declared in package.json `dependencies`),
  // but we still mark it external so it resolves from the consumer's
  // node_modules rather than being bundled into our tarball.
  external: ["@larksuiteoapi/node-sdk"],
});
