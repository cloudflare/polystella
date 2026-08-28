import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./fixtures/workerd/wrangler.jsonc" } })],
  test: {
    include: ["workerd-tests/**/*.test.ts"],
  },
});
