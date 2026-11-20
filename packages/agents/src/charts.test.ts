import { describe, expect, it } from "vitest";
import { chartFiles } from "./charts";
import type { Customer, LedgerEntry, Product } from "./store";

const customers: Customer[] = [{ id: "c1", name: "Ramesh", aliases: [], phone: null, language: null }];
const products: Product[] = [{ id: "p1", name: "Rice, Sona Masoori", aliases: [], unit: "kg", stockQty: 25, reorderLevel: 10, pricePaise: null }];
const entry = (kind: LedgerEntry["kind"], rupees: number, createdAt: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: createdAt,
  kind,
  amountPaise: rupees * 100,
  customerId: null,
  note: null,
  createdAt,
  ...extra,
});

describe("chartFiles", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  it("writes the khata as CSV, oldest first, in India time, with customer names", () => {
    const { files, ledgerRows } = chartFiles(
      [
        entry("payment_received", 200, "2026-11-18T20:00:00Z", { customerId: "c1", note: "upi" }), // 1:30 am on the 19th in India
        entry("sale", 1200.5, "2026-11-17T06:00:00Z"),
        entry("credit_given", 450, "2026-11-10T06:00:00Z", { customerId: "c1", note: 'rice, "sona" dal' }),
      ],
      customers,
      products,
      30,
      now,
    );
    expect(ledgerRows).toBe(3);
    expect(files["ledger.csv"]).toBe(
      'date,type,amount,customer,note\n2026-11-10,udhaar,450,Ramesh,"rice, ""sona"" dal"\n2026-11-17,sale,1200.5,,\n2026-11-19,payment,200,Ramesh,upi\n',
    );
    expect(files["stock.csv"]).toBe('product,stock,unit,reorder_at\n"Rice, Sona Masoori",25,kg,10\n');
  });

  it("keeps only the days asked for", () => {
    const { ledgerRows } = chartFiles([entry("sale", 100, "2026-11-18T06:00:00Z"), entry("sale", 100, "2026-10-01T06:00:00Z")], customers, products, 7, now);
    expect(ledgerRows).toBe(1);
  });
});
