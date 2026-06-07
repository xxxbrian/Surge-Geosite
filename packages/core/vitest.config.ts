import { defineConfig } from "vitest/config";
import os from "node:os";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    hookTimeout: 600_000,
    testTimeout: 600_000,
    maxConcurrency: Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 8) - 1)
  }
});
