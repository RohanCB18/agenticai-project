import { describe, expect, it } from "vitest";
import { chartFiles, chartTotals, chartWindow, nothingToChart, salesChartSkipsUdhaar } from "./charts";
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

describe("chartWindow", () => {
  // 21 Nov 2026, 2:30 am in India: still the 20th in UTC.
  const now = new Date("2026-11-20T21:00:00Z");

  it("works out the owner's periods in India time", () => {
    expect(chartWindow("this_month", now)).toEqual({ from: "2026-11-01", to: "2026-11-21", label: "1 Nov 2026 to 21 Nov 2026" });
    expect(chartWindow("last_month", now)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(chartWindow("last_7_days", now)).toMatchObject({ from: "2026-11-15", to: "2026-11-21" });
    expect(chartWindow("last_30_days", now)).toMatchObject({ from: "2026-10-23", to: "2026-11-21" });
  });

  it("crosses into the year before", () => {
    expect(chartWindow("last_month", new Date("2027-01-05T06:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
    expect(chartWindow("this_month", new Date("2027-01-01T06:00:00Z")).label).toBe("1 Jan 2027");
  });
});

describe("chartFiles", () => {
  const week = chartWindow("last_7_days", new Date("2026-11-19T12:00:00Z")); // 13 to 19 Nov

  it("writes the khata as CSV, oldest first, in India time, with customer names", () => {
    const { files, ledgerRows } = chartFiles(
      [
        entry("payment_received", 200, "2026-11-18T20:00:00Z", { customerId: "c1", note: "upi" }), // 1:30 am on the 19th in India
        entry("sale", 1200.5, "2026-11-17T06:00:00Z"),
        entry("credit_given", 450, "2026-11-13T06:00:00Z", { customerId: "c1", note: 'rice, "sona" dal' }),
      ],
      customers,
      products,
      week,
    );
    expect(ledgerRows).toBe(3);
    expect(files["ledger.csv"]).toBe(
      'date,type,amount,customer,note\n2026-11-13,udhaar,450,Ramesh,"rice, ""sona"" dal"\n2026-11-17,sale,1200.5,,\n2026-11-19,payment,200,Ramesh,upi\n',
    );
    expect(files["stock.csv"]).toBe('product,stock,unit,reorder_at\n"Rice, Sona Masoori",25,kg,10\n');
  });

  it("adds the khata up per day, every day of the period, with udhaar counted in sales", () => {
    const { files, totals } = chartFiles(
      [
        entry("credit_given", 450, "2026-11-13T06:00:00Z", { customerId: "c1" }),
        entry("credit_given", 300, "2026-11-13T09:00:00Z", { customerId: "c1" }),
        entry("sale", 100, "2026-11-15T06:00:00Z"),
        entry("expense", 50, "2026-11-15T07:00:00Z"),
      ],
      customers,
      products,
      week,
    );
    const daily = files["daily.csv"].trim().split("\n");
    expect(daily[0]).toBe("date,cash_sales,udhaar,sales,payments,expenses,supplier_payments");
    expect(daily.slice(1)).toEqual([
      "2026-11-13,0,750,750,0,0,0",
      "2026-11-14,0,0,0,0,0,0",
      "2026-11-15,100,0,100,0,50,0",
      "2026-11-16,0,0,0,0,0,0",
      "2026-11-17,0,0,0,0,0,0",
      "2026-11-18,0,0,0,0,0,0",
      "2026-11-19,0,0,0,0,0,0",
    ]);
    expect(chartTotals(totals)).toMatchObject({ sales: "₹850", cashSales: "₹100", udhaar: "₹750", expenses: "₹50" });
  });

  it("keeps only the period asked for", () => {
    const { ledgerRows } = chartFiles([entry("sale", 100, "2026-11-18T06:00:00Z"), entry("sale", 100, "2026-10-01T06:00:00Z")], customers, products, week);
    expect(ledgerRows).toBe(1);
  });
});

describe("nothingToChart", () => {
  const month = chartWindow("this_month", new Date("2026-11-21T06:00:00Z"));
  // What the live shop had: a month of udhaar and payments, no cash sale.
  const { totals } = chartFiles(
    [entry("credit_given", 450, "2026-11-07T06:00:00Z"), entry("payment_received", 100, "2026-11-07T07:00:00Z"), entry("credit_given", 300, "2026-11-10T06:00:00Z")],
    customers,
    products,
    month,
  );

  it("counts udhaar as sales, so a month of udhaar is something to draw", () => {
    expect(nothingToChart("sales", totals, 1, month)).toBeNull();
    expect(nothingToChart("udhaar", totals, 1, month)).toBeNull();
  });

  it("says what is missing, and for which days", () => {
    expect(nothingToChart("cash_sales", totals, 1, month)).toBe("no cash sales (1 Nov 2026 to 21 Nov 2026)");
    expect(nothingToChart("expenses", totals, 1, month)).toBe("no expenses (1 Nov 2026 to 21 Nov 2026)");
    expect(nothingToChart("stock", totals, 0, month)).toBe("no products in stock");
  });
});

describe("salesChartSkipsUdhaar", () => {
  it("catches a sales program that only counts cash sales", () => {
    expect(salesChartSkipsUdhaar("sales", 'df = pd.read_csv("ledger.csv")\nsales = df[df.type == "sale"]')).toBe(true);
    expect(salesChartSkipsUdhaar("sales", 'd = pd.read_csv("daily.csv")\nd.plot(x="date", y=["cash_sales", "udhaar"], stacked=True)')).toBe(false);
    expect(salesChartSkipsUdhaar("sales", 'd = pd.read_csv("daily.csv")\nd["sales"].plot()')).toBe(false);
    expect(salesChartSkipsUdhaar("cash_sales", 'sales = df[df.type == "sale"]')).toBe(false);
  });
});
