import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "src/**/*.test.ts",
      "webapp/src/**/*.test.ts",
    ],
    environment: "node",
    globals: false,
  },
});
