import { defineConfig } from "vitest/config";

// Runs the real `hermes acp` against the local OpenAI mock; needs Hermes installed.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
