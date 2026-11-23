import { defineConfig } from "vitest/config";

/**
 * The API layer is plain TypeScript: no React Native renderer, no device, no
 * network. Only the pure client/polling modules are tested here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: ["default"],
  },
});
