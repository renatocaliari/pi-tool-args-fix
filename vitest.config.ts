import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["repairs.ts"],
      thresholds: {
        // Based on cali-product-testing-ai-code: critical paths = 70% min
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
