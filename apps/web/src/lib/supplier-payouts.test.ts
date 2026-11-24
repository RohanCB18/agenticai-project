import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTransfer, type Transfer } from "./cashfree-payouts";
import { notifyOwner } from "./payments";
import { reconcilePayouts, watchPayouts } from "./supplier-payouts";

vi.mock("./cashfree-payouts", async (original) => ({
  ...(await original<typeof import("./cashfree-payouts")>()),
  getTransfer: vi.fn(),
}));
vi.mock("./payments", () => ({ notifyOwner: vi.fn(async () => {}) }));

type Payout = { merchant_id: string; transfer_id: string; status: string; amount_paise: number; created_at: string; status_code?: string | null };

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** supplier_payouts and settle_supplier_payout, enough for the status checks. */
function fakeDb(payouts: Payout[]) {
  const from = () => {
    const filters: ((row: Payout) => boolean)[] = [];
    const q = {
      select: () => q,
      eq: (key: keyof Payout, value: unknown) => (filters.push((r) => r[key] === value), q),
      gte: (key: keyof Payout, value: string) => (filters.push((r) => String(r[key]) >= value), q),
      order: () => q,
      limit: () => q,
      then: (resolve: (result: { data: Payout[]; error: null }) => void) => resolve({ data: payouts.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  };
  const rpc = async (_name: string, args: { p_transfer_id: string; p_status: string; p_status_code: string | null }) => {
    const row = payouts.find((p) => p.transfer_id === args.p_transfer_id)!;
    const changed = row.status === "pending" && args.p_status !== "pending";
    if (changed) Object.assign(row, { status: args.p_status, status_code: args.p_status_code });
    return { data: [{ merchant_id: row.merchant_id, supplier_id: "sup_1", supplier_name: "SHARMA TRADERS", amount_paise: row.amount_paise, status: row.status, changed }], error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const answer = (byId: Record<string, Partial<Transfer> | Error>) =>
  vi.mocked(getTransfer).mockImplementation(async (id) => {
    const reply = byId[id];
    if (reply instanceof Error) throw reply;
    return { transfer_id: id, status: "RECEIVED", ...reply };
  });

let payouts: Payout[];
let db: SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  payouts = [{ merchant_id: "m1", transfer_id: "munshi_a", status: "pending", amount_paise: 390000, created_at: minutesAgo(2) }];
  db = fakeDb(payouts);
});

describe("reconcilePayouts", () => {
  it("records a payout Cashfree rejected, and tells the owner what to fix", async () => {
    // Live: RECEIVED, then REJECTED a second later, and no webhook ever came.
    answer({ munshi_a: { status: "REJECTED", status_code: "ERROR_SELECTING_FUND_SOURCE", status_description: "Error selecting fund source" } });
    expect(await reconcilePayouts(db, "m1")).toBe(0);
    expect(payouts[0]).toMatchObject({ status: "failed", status_code: "ERROR_SELECTING_FUND_SOURCE" });
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", expect.stringContaining("❌ The ₹3,900 payment to SHARMA TRADERS failed (Cashfree couldn't pick an account"));
  });

  it("tells the owner a payout landed, once", async () => {
    answer({ munshi_a: { status: "SUCCESS", transfer_utr: "UTR9" } });
    await reconcilePayouts(db, "m1");
    await reconcilePayouts(db, "m1");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", "✅ Paid SHARMA TRADERS ₹3,900. UTR UTR9.");
  });

  it("leaves one still on its way, or one Cashfree couldn't answer about", async () => {
    answer({ munshi_a: { status: "RECEIVED" } });
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer({ munshi_a: new Error("Cashfree Payouts transfer status failed (403): IP not whitelisted") });
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    quiet.mockRestore();
    expect(payouts[0]!.status).toBe("pending");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("calls one Cashfree never heard of failed, but only once it has had time", async () => {
    answer({ munshi_a: new Error("Cashfree Payouts transfer status failed (404): transfer not found") });
    expect(await reconcilePayouts(db, "m1")).toBe(1);
    payouts[0]!.created_at = minutesAgo(30);
    expect(await reconcilePayouts(db, "m1")).toBe(0);
    expect(payouts[0]!.status).toBe("failed");
    expect(notifyOwner).toHaveBeenCalledWith(db, "m1", expect.stringContaining("Cashfree has no record of this payment"));
  });

  it("only asks about this shop's payouts that are still pending", async () => {
    payouts.push({ merchant_id: "m2", transfer_id: "munshi_other", status: "pending", amount_paise: 100, created_at: minutesAgo(1) });
    payouts.push({ merchant_id: "m1", transfer_id: "munshi_done", status: "success", amount_paise: 100, created_at: minutesAgo(1) });
    answer({ munshi_a: { status: "RECEIVED" } });
    await reconcilePayouts(db, "m1");
    expect(vi.mocked(getTransfer).mock.calls.map(([id]) => id)).toEqual(["munshi_a"]);
  });
});

describe("watchPayouts", () => {
  it("checks every few seconds and stops once nothing is on its way", async () => {
    const sleep = vi.fn(async () => {});
    let checks = 0;
    vi.mocked(getTransfer).mockImplementation(async (id) => ({ transfer_id: id, status: ++checks < 3 ? "RECEIVED" : "SUCCESS" }));
    expect(await watchPayouts(db, "m1", { forMs: 40_000, everyMs: 4_000, sleep })).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("gives up when the time is up", async () => {
    const sleep = vi.fn(async () => {});
    answer({ munshi_a: { status: "RECEIVED" } });
    expect(await watchPayouts(db, "m1", { forMs: 12_000, everyMs: 4_000, sleep })).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
