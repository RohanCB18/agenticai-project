import { type Bill, billGstSummary, checkBillGst } from "@munshi/agents";
import { describe, expect, it } from "vitest";
import { configuredKnowledge } from "./knowledge";

// Checks a made-up wholesaler bill against the real GST knowledge base (Supabase + the embed
// function). Off by default: set GST_LIVE=1 with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and
// SUPABASE_EMBED_KEY. Rates are the ones in force from 22 September 2025. Against the local stack,
// `embed` answers 503 unless `supabase functions serve` runs: point SUPABASE_EMBED_URL at the hosted
// function, or the search runs on keywords and HSN codes only (the check still works).
const knowledge = process.env.GST_LIVE === "1" ? configuredKnowledge() : undefined;

const line = (name: string, hsn: string, gstRate: number, amount: number) => ({ name, quantity: 1, unit: "pc", rate: amount, amount, hsn, gstRate });

describe.skipIf(!knowledge)("bill GST check against the official rates", () => {
  it("flags old 18% on pulses and keeps correct lines quiet", { timeout: 60_000 }, async () => {
    const bill: Bill = {
      supplierName: "Sharma Traders",
      billNumber: "A-17",
      billDate: "14/11/2026",
      total: null,
      items: [
        line("Toor Dal 30kg bag", "0713", 18, 4200), // pulses: exempt loose, 5% packed; never 18%
        line("Sona Masoori Rice 25kg", "1006", 5, 1350), // packed rice: 5%
        line("Sugar 50kg", "1701", 5, 2200), // sugar: 5%
      ],
    };
    const check = await checkBillGst(bill, knowledge!);
    console.log(billGstSummary(check, bill.supplierName));
    expect(check).toMatchObject({ status: "checked", checked: 3, withoutHsn: 0, noEntry: [] });
    if (check?.status !== "checked") return;
    expect(check.overcharged.map((o) => [o.item, o.charged, o.official])).toEqual([["Toor Dal 30kg bag", 18, 5]]);
    expect(check.overcharged[0]!.citation).toMatch(/Notification No\. \d+\/\d{4}-Central Tax \(Rate\)/);
  });
});
