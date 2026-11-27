import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLink, createPaymentLink, getLink, paidOnLinkOrders } from "./cashfree";
import { cancelSale, checkSale, linkPaid, lowAfterSale, newCounterLinkId, openPaymentPage, settleCounterLink } from "./counter";

vi.mock("./cashfree", async (original) => ({
  ...(await original<typeof import("./cashfree")>()),
  getLink: vi.fn(),
  paidOnLinkOrders: vi.fn(),
  createPaymentLink: vi.fn(),
  cancelLink: vi.fn(async () => ({})),
}));

type Sale = { id: string; merchant_id: string; status: string; total_paise: number; cashfree_link_id: string | null; payment_url?: string | null };
type Product = { id: string; merchant_id: string; name: string; unit: string; stock_qty: number; reorder_level: number | null };

/** counter_sales, products and settle_counter_sale: enough for the bill's checks. */
function fakeDb(sales: Sale[], products: Product[] = []) {
  const settled: string[] = [];
  const tables: Record<string, Record<string, unknown>[]> = { counter_sales: sales, products };
  const from = (table: string) => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    let patch: Record<string, unknown> | null = null;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q = {
      select: () => q,
      update: (values: Record<string, unknown>) => ((patch = values), q),
      eq: (key: string, value: unknown) => (filters.push((r) => r[key] === value), q),
      in: (key: string, values: unknown[]) => (filters.push((r) => values.includes(r[key])), q),
      maybeSingle: async () => {
        const [row] = rows();
        if (row && patch) Object.assign(row, patch);
        return { data: row ?? null, error: null };
      },
      then: (resolve: (result: { data: unknown; error: null }) => void) => {
        if (patch) for (const row of rows()) Object.assign(row, patch);
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  const rpc = async (_name: string, args: { p_sale_id: string; p_merchant_id: string }) => {
    const sale = sales.find((s) => s.id === args.p_sale_id && s.merchant_id === args.p_merchant_id && s.status === "open");
    if (!sale) return { data: false, error: null };
    sale.status = "paid";
    settled.push(sale.id);
    return { data: true, error: null };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, settled };
}

let sales: Sale[];

beforeEach(() => {
  vi.clearAllMocks();
  sales = [{ id: "s1", merchant_id: "m1", status: "open", total_paise: 19000, cashfree_link_id: "counter_1" }];
});

describe("a UPI bill at the counter", () => {
  it("is recorded once Cashfree has the whole amount, however often it is reported", async () => {
    const { db, settled } = fakeDb(sales);
    expect(await settleCounterLink(db, "counter_1", "paid", 19000)).toEqual({ merchantId: "m1", saleId: "s1", recorded: true });
    expect(await settleCounterLink(db, "counter_1", "paid", 19000)).toEqual({ merchantId: "m1", saleId: "s1", recorded: false });
    expect(settled).toEqual(["s1"]);
  });

  it("waits while it is unpaid, and leaves other links to their own code", async () => {
    const { db, settled } = fakeDb(sales);
    expect(await settleCounterLink(db, "counter_1", "active", 0)).toEqual({ merchantId: "m1", saleId: "s1", recorded: false });
    expect(await settleCounterLink(db, "munshi_customer_link", "paid", 45000)).toBe(false);
    expect(settled).toEqual([]);
  });

  it("is checked with Cashfree while the till waits, without its webhook", async () => {
    const { db, settled } = fakeDb(sales);
    vi.mocked(getLink).mockResolvedValue({ link_status: "ACTIVE", link_amount_paid: 0 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(0);
    expect(await checkSale(db, "m1", "s1")).toEqual({ status: "open", recorded: false });
    // Cashfree warns a link can stay EXPIRED after a payment: its orders say what was paid.
    vi.mocked(getLink).mockResolvedValue({ link_status: "EXPIRED", link_amount_paid: 0 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(19000);
    expect(await checkSale(db, "m1", "s1")).toEqual({ status: "paid", recorded: true });
    expect(await checkSale(db, "m1", "s1")).toEqual({ status: "paid", recorded: false });
    expect(settled).toEqual(["s1"]);
  });

  it("never shows another shop's bill", async () => {
    const { db } = fakeDb(sales);
    await expect(checkSale(db, "m2", "s1")).rejects.toThrow("No such bill");
  });

  it("can be cancelled while unpaid, closing its page; a paid one can't", async () => {
    const { db } = fakeDb(sales);
    expect(await cancelSale(db, "m1", "s1")).toBe(true);
    expect(sales[0]!.status).toBe("cancelled");
    expect(cancelLink).toHaveBeenCalledWith("counter_1");
    sales[0]!.status = "paid";
    expect(await cancelSale(db, "m1", "s1")).toBe(false);
  });

  it("gets a Cashfree page with no SMS, saved before Cashfree is asked, and a QR for the screen", async () => {
    const { db } = fakeDb(sales);
    vi.mocked(createPaymentLink).mockImplementation(async (input) => {
      // A webhook racing the answer must already find the bill by its link.
      expect(sales[0]!.cashfree_link_id).toBe(input.linkId);
      return { cf_link_id: 1, link_id: input.linkId, link_url: "https://payments-test.cashfree.com/links/x", link_status: "ACTIVE", link_amount: 190, link_amount_paid: 0, link_expiry_time: "" };
    });
    const items = [{ productId: "rice", name: "Rice", unit: "kg", quantity: 1.5, pricePaise: 6000, amountPaise: 9000 }];
    const page = await openPaymentPage(db, { id: "s1", merchantId: "m1", shopName: "RCB general stores", phone: null, items, totalPaise: 19000 });
    expect(page.url).toBe("https://payments-test.cashfree.com/links/x");
    expect(page.qr).toMatch(/^data:image\/png;base64,/);
    expect(vi.mocked(createPaymentLink).mock.calls[0]![0]).toMatchObject({ amountPaise: 19000, sendSms: false, customer: { name: "RCB general stores", phone: "9999999999" } });
    expect(sales[0]!.payment_url).toBe("https://payments-test.cashfree.com/links/x");
  });
});

describe("after a bill", () => {
  it("names what it took to its alert level, the owner's or Munshi's default", async () => {
    const { db } = fakeDb(sales, [
      { id: "rice", merchant_id: "m1", name: "Rice", unit: "kg", stock_qty: 59, reorder_level: 60 },
      { id: "oil", merchant_id: "m1", name: "Sunflower oil", unit: "ltr", stock_qty: 4, reorder_level: null },
      { id: "dal", merchant_id: "m1", name: "Toor dal", unit: "kg", stock_qty: 40, reorder_level: null },
    ]);
    expect(await lowAfterSale(db, "m1", ["rice", "oil", "dal"])).toEqual(["Rice (59 kg left)", "Sunflower oil (4 ltr left)"]);
  });

  it("counts a link paid in full, or marked paid", () => {
    expect(linkPaid("active", 19000, 19000)).toBe(true);
    expect(linkPaid("paid", 0, 19000)).toBe(true);
    expect(linkPaid("active", 18999, 19000)).toBe(false);
    expect(newCounterLinkId()).toMatch(/^counter_[0-9a-f]{32}$/);
  });
});
