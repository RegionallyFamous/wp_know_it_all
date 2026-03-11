import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
  },
});
