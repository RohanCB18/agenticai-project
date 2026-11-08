import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import type { Route } from "../src/desks";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { detectLanguage } from "../src/voice";
import { CASES, HELD_OUT_FROM, seededStore, WRITE_TOOLS, type EvalCase } from "./cases";

// Runs every case against real Sarvam and scores the tools the agent chose.
//   npm run eval -w @munshi/agents                       (needs SARVAM_API_KEY)
//   EVAL_LABEL=baseline EVAL_REPEATS=2 npm run eval ...  (names the results file, repeats each case)
//   EVAL_SPECIALISTS=0 ...                               (one agent with every tool, no desks)

const key = process.env.SARVAM_API_KEY;
const label = process.env.EVAL_LABEL ?? "run";
const repeats = Number(process.env.EVAL_REPEATS ?? 1);
const specialists = process.env.EVAL_SPECIALISTS !== "0";
// Sarvam rate-limits bursts; errors from that are reported apart from wrong answers.
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);

type Row = EvalCase & {
  heldOut: boolean;
  called: string[];
  pass: boolean;
  wrongWrites: string[];
  desk: string | null;
  ms: number;
  routerMs: number;
  routedBy: string | null;
  inputTokens: number;
  outputTokens: number;
  reply: string;
  error?: string;
};

async function runCase(c: EvalCase): Promise<Row> {
  const store = await seededStore();
  let route: Route | null = null;
  const agent = createKhataAgent({
    model: sarvamModel(key!),
    store,
    shopName: "Sri Ganesh Stores",
    language: "hi",
    channel: "telegram",
    approvalSecret: "eval-only-secret",
    detectLanguage: (text) => detectLanguage({ apiKey: key!, text }),
    specialists,
    onRoute: (r) => void (route = r),
  });
  const started = Date.now();
  try {
    const result = await agent.generate({ messages: [{ role: "user", content: c.text }] });
    const called = [...new Set(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)))];
    const routed = route as Route | null;
    const wrongWrites = called.filter((tool) => WRITE_TOOLS.has(tool) && !c.expect.includes(tool));
    return {
      ...c,
      heldOut: CASES.indexOf(c) >= HELD_OUT_FROM,
      called,
      wrongWrites,
      pass: c.expect.every((tool) => called.includes(tool)) && wrongWrites.length === 0,
      desk: routed?.desk ?? null,
      ms: Date.now() - started,
      routerMs: routed?.ms ?? 0,
      routedBy: routed?.by ?? null,
      // The router's own call counts: it is part of what each message costs.
      inputTokens: (result.totalUsage.inputTokens ?? 0) + (routed?.tokens ?? 0),
      outputTokens: result.totalUsage.outputTokens ?? 0,
      reply: result.text.trim().slice(0, 120),
    };
  } catch (error) {
    return { ...c, heldOut: CASES.indexOf(c) >= HELD_OUT_FROM, called: [], wrongWrites: [], pass: false, desk: null, ms: Date.now() - started, routerMs: 0, routedBy: null, inputTokens: 0, outputTokens: 0, reply: "", error: String(error).slice(0, 200) };
  }
}

it.skipIf(!key)("tool choice across languages", { timeout: 1_800_000 }, async () => {
  const queue = Array.from({ length: repeats }, () => CASES).flat();
  const rows: Row[] = [];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) rows.push(await runCase(c));
    }),
  );

  const passed = rows.filter((r) => r.pass).length;
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const sum = (pick: (r: Row) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const summary = {
    label,
    runs: rows.length,
    passed,
    heldOut: `${rows.filter((r) => r.heldOut && r.pass).length}/${rows.filter((r) => r.heldOut).length}`,
    wrongWrites: rows.filter((r) => r.wrongWrites.length).length,
    errors: rows.filter((r) => r.error).length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p90Ms: sorted[Math.floor(sorted.length * 0.9)],
    avgInputTokens: Math.round(sum((r) => r.inputTokens) / rows.length),
    avgOutputTokens: Math.round(sum((r) => r.outputTokens) / rows.length),
    avgRouterMs: Math.round(sum((r) => r.routerMs) / rows.length),
    handOffs: rows.filter((r) => r.called.includes("handOff")).length,
    routerFallbacks: rows.filter((r) => r.routedBy === "fallback").length,
    desks: Object.fromEntries([...new Set(rows.map((r) => r.desk))].map((desk) => [String(desk), rows.filter((r) => r.desk === desk).length])),
  };

  mkdirSync("evals/results", { recursive: true });
  writeFileSync(`evals/results/${label}.json`, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
  for (const r of rows.filter((row) => !row.pass)) console.log(`MISS ${JSON.stringify(r.text)} expected ${r.expect.join(",") || "nothing"} got ${r.called.join(",") || "nothing"}${r.error ? ` error ${r.error}` : ""}`);
});
