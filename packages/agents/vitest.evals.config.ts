import { defineConfig } from "vitest/config";

// Evals call the real Sarvam API, so they never run with the unit tests, and run one file at a
// time: in parallel they hit Sarvam's rate limit and the errors drown the results.
export default defineConfig({ cacheDir: "node_modules/.vitest-evals", test: { include: ["evals/**/*.eval.ts"], fileParallelism: false } });
