import { describe, expect, it } from "vitest";
import { type Bill, BillReadError, billSummary, checkBill, planBill, readBill } from "./bills";

const bill: Bill = {
  supplierName: "Sharma Traders",
  billNumber: "1042",
  billDate: "05/11/2026",
  total: 2380,
  items: [
    { name: "Sona Masoori Rice", quantity: 25, unit: "kg", rate: 52, amount: 1300 },
    { name: "Nandini Milk 500ml", quantity: 40, unit: "pkt", rate: 27, amount: 1080 },
  ],
};

const products = [
  { id: "rice", name: "Sona Masoori Rice", aliases: [], stockQty: 18 },
  { id: "milk", name: "Nandini Milk", aliases: [], stockQty: 40 },
];

describe("checkBill", () => {
  it("accepts a bill whose arithmetic holds", () => {
    expect(checkBill(bill)).toEqual([]);
  });

  it("allows rupee rounding", () => {
    expect(checkBill({ ...bill, total: 2380.6 })).toEqual([]);
  });

  it("catches a misread digit in a line", () => {
    const misread = { ...bill, total: 2110, items: [{ ...bill.items[0]!, quantity: 20 }, bill.items[1]!] };
    expect(checkBill(misread)[0]).toContain("20 × 52 isn't 1300");
  });

  it("flags a total that doesn't match the items", () => {
    expect(checkBill({ ...bill, total: 2830 })[0]).toContain("add up to ₹2,380 but the total says ₹2,830");
  });

  it("flags anything it couldn't read", () => {
    const warnings = checkBill({ ...bill, total: null, items: [{ ...bill.items[0]!, quantity: null }] });
    expect(warnings).toContain("Sona Masoori Rice: couldn't read the quantity");
    expect(warnings).toContain("Couldn't read the bill total");
  });
});

describe("planBill", () => {
  it("matches known products and marks the rest as new", () => {
    const plan = planBill({ ...bill, items: [...bill.items, { name: "Sugar", quantity: 20, unit: "kg", rate: 44, amount: 880 }] }, products);
    expect(plan[0]).toMatchObject({ productId: "rice", stockBefore: 18 });
    expect(plan[1]).toMatchObject({ productId: "milk", productName: "Nandini Milk" });
    expect(plan[2]).toMatchObject({ productId: null });
  });

  it("matches a short name and bill names in other scripts", () => {
    const plan = planBill({ ...bill, items: [{ name: "Rice", quantity: 5, unit: "kg", rate: 50, amount: 250 }, { name: "नंदिनी मिल्क", quantity: 1, unit: "pkt", rate: 27, amount: 27 }] }, products);
    expect(plan[0]).toMatchObject({ productId: "rice" });
    expect(plan[1]).toMatchObject({ productId: "milk" });
  });

  it("won't guess between two close products", () => {
    const close = [
      { id: "a", name: "Toor Dal Premium", aliases: [], stockQty: 1 },
      { id: "b", name: "Toor Dal Regular", aliases: [], stockQty: 1 },
    ];
    expect(planBill({ ...bill, items: [{ name: "Toor Dal", quantity: 5, unit: "kg", rate: 140, amount: 700 }] }, close)[0]).toMatchObject({ productId: null });
  });
});

describe("billSummary", () => {
  it("shows what will change and any doubts", () => {
    const summary = billSummary(bill, planBill(bill, products), ["Couldn't read the bill total"]);
    expect(summary).toContain("Sharma Traders · Bill 1042 · ₹2,380");
    expect(summary).toContain("Sona Masoori Rice: +25 kg, stock 18 → 43");
    expect(summary).toContain("⚠️ Please check:");
  });

  it("labels new items", () => {
    expect(billSummary(bill, planBill(bill, []), [])).toContain("(new item)");
  });
});

describe("readBill", () => {
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  function fakeFetch(steps: Response[]) {
    const urls: string[] = [];
    const fn = (async (url: string) => {
      urls.push(url);
      return steps.shift()!;
    }) as unknown as typeof fetch;
    return { fn, urls };
  }

  it("creates the job, waits for it and cleans up the result", async () => {
    const { fn, urls } = fakeFetch([
      respond({ job_id: "j1", status: "queued" }, 201),
      respond({ status: "processing" }),
      respond({ status: "completed" }),
      respond({ result: { supplier_name: " Ganesh Traders ", total: "3,770", items: [{ name: "Rice", quantity: 25, unit: "kg", rate: 54, amount: 1350 }, { name: "" }] } }),
    ]);
    const read = await readBill({ apiKey: "k", image: new Blob(["x"]), fetch: fn, pollMs: 0 });
    expect(read).toMatchObject({ supplierName: "Ganesh Traders", billNumber: null, total: 3770 });
    expect(read.items).toHaveLength(1);
    expect(urls[0]).toContain("/doc-ai/v1/job/extract");
    expect(urls.at(-1)).toContain("/j1/results");
  });

  it("fails clearly when the job fails", async () => {
    const { fn } = fakeFetch([respond({ job_id: "j2", status: "failed" }, 201)]);
    await expect(readBill({ apiKey: "k", image: new Blob(["x"]), fetch: fn, pollMs: 0 })).rejects.toThrow(BillReadError);
  });
});
