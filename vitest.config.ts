import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Concurrent native PowerShell/ACL suites can starve the bounded security
    // checker on Windows runners. Keep file isolation and in-test concurrency.
    fileParallelism: process.platform !== "win32",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
