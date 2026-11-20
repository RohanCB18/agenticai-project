import { describe, expect, it } from "vitest";
import { createSandboxChartRunner } from "./charts";

// Runs real chart programs in a real Vercel Sandbox. Off by default: set CHART_SANDBOX_LIVE=1 and
// CHART_SANDBOX_SNAPSHOT, with Vercel credentials (VERCEL_OIDC_TOKEN, e.g. from `vercel link`).
const live = process.env.CHART_SANDBOX_LIVE === "1" && process.env.CHART_SANDBOX_SNAPSHOT;

const files = {
  "ledger.csv": "date,type,amount,customer,note\n2026-11-17,sale,1200,,\n2026-11-18,sale,950,,\n2026-11-18,udhaar,450,Ramesh,rice\n",
  "stock.csv": "product,stock,unit,reorder_at\nRice,25,kg,10\n",
};

describe.skipIf(!live)("charts in a Vercel Sandbox", () => {
  const runner = live ? createSandboxChartRunner(process.env.CHART_SANDBOX_SNAPSHOT!) : null!;

  it("draws a chart from the CSV and prints its summary", async () => {
    const result = await runner.run({
      files,
      code: `import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv("ledger.csv")
sales = df[df.type == "sale"].groupby("date").amount.sum()
sales.plot(kind="bar", figsize=(8, 4.5), title="Sales")
plt.tight_layout(); plt.savefig("chart.png", dpi=150)
print(f"Total sales Rs {sales.sum():.0f}")`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // a PNG
    expect(result.stdout).toBe("Total sales Rs 2150");
  }, 60_000);

  it("gives back the error of a broken program, for the agent to fix", async () => {
    const result = await runner.run({ files, code: `import pandas as pd\npd.read_csv("ledger.csv")["no_such_column"]` });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("no_such_column") });
  }, 60_000);

  it("has no internet", async () => {
    const result = await runner.run({ files, code: `import urllib.request\nurllib.request.urlopen("https://example.com", timeout=5)` });
    expect(result.ok).toBe(false);
  }, 60_000);
});
