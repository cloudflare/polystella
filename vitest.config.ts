import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests are tiny + pure; no need for jsdom/happy-dom.
    pool: "threads",
    // Single thread is faster than multi-worker for our suite —
    // ~1.2s vs ~1.6s when measured locally. Per-worker startup
    // dominates parallelism gains at this scale. Revisit when the
    // suite outgrows the per-worker overhead.
    threads: { singleThread: true },
  },
});
