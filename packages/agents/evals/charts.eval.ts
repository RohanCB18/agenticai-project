import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ChartRunner } from "../src/charts";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { MemoryStore } from "../src/testing/memory-store";

// Real Sarvam asked for charts of a shop like the live one that got a "No sales data" picture:
// this month's udhaar and payments, no cash sale. Checks what makeChart was asked for. Programs
// aren't run here (no sandbox): each is saved, with its files, to <tmp>/munshi-chart-eval to read
// and run by hand.
//   npm run eval -w @munshi/agents -- charts     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;
const OUT = join(tmpdir(), "munshi-chart-eval");

async function liveLikeShop() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh" });
  // Days ago that stay inside this month, whatever day it is.
  const dayOfMonth = Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(8));
  const ago = (days: number) => Math.min(days, dayOfMonth - 1);
  await store.addPastEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id, note: "saaman" }, ago(14));
  await store.addPastEntry({ kind: "payment_received", amountPaise: 10000, customerId: ramesh.id, note: "cash" }, ago(14));
  await store.addPastEntry({ kind: "payment_received", amountPaise: 35000, customerId: ramesh.id, note: "UPI" }, ago(14));
  await store.addPastEntry({ kind: "credit_given", amountPaise: 30000, customerId: ramesh.id, note: "saaman" }, ago(11));
  await store.addPastEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id, note: "saaman" }, 0);
  store.products.push({ id: "p1", name: "Rice", aliases: [], unit: "kg", stockQty: 50, reorderLevel: 60, pricePaise: null });
  return store;
}

const CASES = [
  { name: "sales-this-month", text: "Is mahine ki sale chart mein dikhao", about: "sales", period: "this_month", status: "chart_ready" },
  { name: "udhaar-this-week", text: "Is hafte ka udhaar graph dikhao", about: "udhaar", period: "last_7_days", status: "chart_ready" },
  { name: "cash-only", text: "Is mahine ki sirf cash sale ka chart dikhao", about: "cash_sales", period: "this_month", status: "nothing_to_chart" },
] as const;

for (const c of CASES) {
  it.skipIf(!key)(c.text, { timeout: 180_000 }, async () => {
    const store = await liveLikeShop();
    let runs = 0;
    const charts: ChartRunner = {
      run: async ({ code, files }) => {
        const dir = join(OUT, `${c.name}-${++runs}`);
        mkdirSync(dir, { recursive: true });
        for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
        writeFileSync(join(dir, "chart.py"), `import matplotlib\nmatplotlib.use("Agg")\n${code}`);
        return { ok: true, png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), stdout: "" };
      },
    };
    const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "RCB general stores", language: "hi", channel: "telegram", charts });
    const result = await agent.generate({ messages: [{ role: "user", content: c.text }] });

    const calls = result.steps.flatMap((s) => s.toolCalls).filter((call) => call.toolName === "makeChart");
    const outputs = result.steps.flatMap((s) => s.toolResults).filter((r) => r.toolName === "makeChart").map((r) => r.output as { status: string });
    console.log(
      `${c.text}\n  asked: ${calls.map((call) => JSON.stringify({ about: (call.input as { about: string }).about, period: (call.input as { period: string }).period })).join(" then ")}\n  got: ${outputs.map((o) => o.status).join(" then ")}\n  reply: ${result.text.trim()}\n  programs: ${runs ? OUT : "none ran"}`,
    );
    expect(calls[0]?.input).toMatchObject({ about: c.about, period: c.period });
    expect(outputs.at(-1)?.status).toBe(c.status);
  });
}
