import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLink, paidOnLinkOrders } from "./cashfree";
import { notifyOwner } from "./payments";
import { linkOutcome, maskedAccount, payoutNotice, reconcilePayouts, settleSupplierLink } from "./supplier-payouts";

vi.mock("./cashfree", async (original) => ({
  ...(await original<typeof import("./cashfree")>()),
  getLink: vi.fn(),
  paidOnLinkOrders: vi.fn(),
}));
vi.mock("./payments", () => ({ notifyOwner: vi.fn(async () => {}) }));

type Row = { merchant_id: string; transfer_id: string; provider: string; status: string; amount_paise: number; created_at: string; status_code?: string | null; status_description?: string | null };

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** supplier_payouts and settle_supplier_payout, enough for the status checks. */
function fakeDb(payouts: Row[]) {
  const from = () => {
    const filters: ((row: Row) => boolean)[] = [];
    const q = {
      select: () => q,
      eq: (key: keyof Row, value: unknown) => (filters.push((r) => r[key] === value), q),
      gte: (key: keyof Row, value: string) => (filters.push((r) => String(r[key]) >= value), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: payouts.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (resolve: (result: { data: Row[]; error: null }) => void) => resolve({ data: payouts.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  const rpc = async (_name: string, args: { p_transfer_id: string; p_status: string; p_status_code: string | null; p_status_description: string | null }) => {
    const row = payouts.find((p) => p.transfer_id === args.p_transfer_id)!;
    const changed = row.status === "pending" && args.p_status !== "pending";
    if (changed) Object.assign(row, { status: args.p_status, status_code: args.p_status_code, status_description: args.p_status_description });
    return { data: [{ merchant_id: row.merchant_id, supplier_id: "sup_1", supplier_name: "SHARMA TRADERS", amount_paise: row.amount_paise, status: row.status, changed }], error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

let payouts: Row[];
let db: SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  payouts = [{ merchant_id: "m1", transfer_id: "munshi_link1", provider: "easy_split", status: "pending", amount_paise: 10000, created_at: minutesAgo(2) }];
  db = fakeDb(payouts);
});

describe("linkOutcome", () => {
  it("counts a link paid in full as a payment, and an unpaid lapsed one as not made", () => {
    expect(linkOutcome("l", "paid", 10000, 10000)).toMatchObject({ status: "success" });
    // Cashfree warns a link can stay EXPIRED after a payment: the orders say what was paid.
    expect(linkOutcome("l", "expired", 10000, 10000)).toMatchObject({ status: "success" });
    expect(linkOutcome("l", "expired", 0, 10000)).toMatchObject({ status: "failed", description: "the payment page expired unpaid" });
    expect(linkOutcome("l", "cancelled", 0, 10000)).toMatchObject({ status: "failed", description: "the payment page was cancelled" });
    expect(linkOutcome("l", "active", 0, 10000)).toBeNull();
  });
});

describe("the Cashfree webhook for a supplier's link", () => {
  it("records the payment and tells the owner, once", async () => {
    expect(await settleSupplierLink(db, "munshi_link1", "paid", 10000)).toBe(true);
    expect(await settleSupplierLink(db, "munshi_link1", "paid", 10000)).toBe(true);
    expect(payouts[0]!.status).toBe("success");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", "✅ Paid SHARMA TRADERS ₹100. Cashfree sends it to their account at its next settlement.");
  });

  it("leaves customers' links to the customer payments code", async () => {
    expect(await settleSupplierLink(db, "munshi_customer_link", "paid", 45000)).toBe(false);
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});

describe("reconcilePayouts", () => {
  it("records a link paid without its webhook arriving", async () => {
    vi.mocked(getLink).mockResolvedValue({ link_status: "PAID", link_amount_paid: 100 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(10000);
    expect(await reconcilePayouts(db, "m1")).toBe(0);
    expect(payouts[0]!.status).toBe("success");
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", expect.stringContaining("✅ Paid SHARMA TRADERS ₹100"));
  });

  it("says a page that expired unpaid wasn't a payment", async () => {
    vi.mocked(getLink).mockResolvedValue({ link_status: "EXPIRED", link_amount_paid: 0 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(0);
    await reconcilePayouts(db, "m1");
    expect(payouts[0]).toMatchObject({ status: "failed", status_description: "the payment page expired unpaid" });
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", "❌ The ₹100 payment to SHARMA TRADERS wasn't made (the payment page expired unpaid). Nothing was paid.");
  });

  it("leaves a page still waiting for the owner, or one Cashfree couldn't answer about", async () => {
    vi.mocked(getLink).mockResolvedValue({ link_status: "ACTIVE", link_amount_paid: 0 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(0);
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getLink).mockRejectedValue(new Error("Cashfree get link didn't answer within 15 s"));
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    quiet.mockRestore();
    expect(payouts[0]!.status).toBe("pending");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("calls a page Cashfree never heard of not made, but only once it has had time", async () => {
    vi.mocked(getLink).mockRejectedValue(new Error("Cashfree get link failed (404): link not found"));
    vi.mocked(paidOnLinkOrders).mockResolvedValue(0);
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    payouts[0]!.created_at = minutesAgo(30);
    expect(await reconcilePayouts(db, "m1")).toBe(0);
    expect(payouts[0]!.status).toBe("failed");
  });

  it("only asks about this shop's Easy Split payments that are still waiting", async () => {
    payouts.push({ merchant_id: "m2", transfer_id: "munshi_other", provider: "easy_split", status: "pending", amount_paise: 100, created_at: minutesAgo(1) });
    payouts.push({ merchant_id: "m1", transfer_id: "munshi_done", provider: "easy_split", status: "success", amount_paise: 100, created_at: minutesAgo(1) });
    // Made through Cashfree Payouts before the move: a transfer, not a link.
    payouts.push({ merchant_id: "m1", transfer_id: "munshi_old", provider: "payouts", status: "pending", amount_paise: 100, created_at: minutesAgo(1) });
    vi.mocked(getLink).mockResolvedValue({ link_status: "ACTIVE", link_amount_paid: 0 });
    vi.mocked(paidOnLinkOrders).mockResolvedValue(0);
    await reconcilePayouts(db, "m1");
    expect(vi.mocked(getLink).mock.calls.map(([id]) => id)).toEqual(["munshi_link1"]);
  });
});

describe("what the owner sees", () => {
  it("masks where the money goes", () => {
    expect(maskedAccount({ payout_vpa: "sharmatraders@okhdfc", payout_account_last4: null })).toBe("UPI sh•••@okhdfc");
    expect(maskedAccount({ payout_vpa: null, payout_account_last4: "1191" })).toBe("bank ••••1191");
  });

  it("says nothing while the owner hasn't paid yet", () => {
    expect(payoutNotice({ supplier_name: "Sharma Traders", amount_paise: 10000, status: "pending" }, { utr: null, description: null })).toBeNull();
  });
});
