import { defineConfig } from "vitest/config";

// Per-package cache so turbo can run test suites in parallel without clobbering one shared cache.
export default defineConfig({ cacheDir: "node_modules/.vitest" });
