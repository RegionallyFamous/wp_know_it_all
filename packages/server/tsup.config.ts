import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node22",
  // MCP SDK is ESM-only with top-level await — must not be bundled
  external: ["@modelcontextprotocol/sdk", "better-sqlite3", "express"],
  noExternal: [],
});
