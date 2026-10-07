import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node", // core logic is pure; no DOM needed
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
