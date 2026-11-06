import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelLink, terminateOrder } from "./cashfree";
import { cancelOpenRequests, settlePayment } from "./payments";

vi.mock("./cashfree", async (original) => ({
  ...(await original<typeof import("./cashfree")>()),
  cancelLink: vi.fn(async () => ({})),
  terminateOrder: vi.fn(async () => ({})),
}));

type Row = Record<string, unknown>;

/** Just enough of the Supabase query builder: filters, update and insert over in-memory rows. */
function fakeDb(tables: Record<string, Row[]>) {
  const query = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let patch: Row | undefined;
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => (filters.push((r) => r[key] === value), q),
      in: (key: string, values: unknown[]) => (filters.push((r) => values.includes(r[key])), q),
      update: (values: Row) => ((patch = values), q),
      insert: async (row: Row) => (tables[table]!.push(row), { error: null }),
      then: (resolve: (result: { data: Row[]; error: null }) => void) => {
        const rows = tables[table]!.filter((r) => filters.every((f) => f(r)));
        if (patch) rows.forEach((r) => Object.assign(r, patch));
        resolve({ data: rows, error: null });
      },
    };
    return q;
  };
  return { from: query } as unknown as SupabaseClient;
}

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();
const owner = { merchant_id: "m1", customer_id: "ramesh" };

let links: Row[];
let qrs: Row[];
let db: SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
  links = [{ ...owner, id: "link1", cashfree_link_id: "cf_link", status: "active", amount_paid_paise: 0, expires_at: future }];
  qrs = [{ ...owner, id: "qr1", cashfree_order_id: "cf_order", status: "active", amount_paid_paise: 0, expires_at: future }];
  db = fakeDb({ payment_links: links, payment_qrs: qrs, ledger_entries: [], audit_log: [] });
});

describe("cancelOpenRequests", () => {
  it("cancels a customer's open link and QR", async () => {
    await cancelOpenRequests(db, "m1", "ramesh");
    expect(cancelLink).toHaveBeenCalledWith("cf_link");
    expect(terminateOrder).toHaveBeenCalledWith("cf_order");
    expect([links[0]!.status, qrs[0]!.status]).toEqual(["cancelled", "cancelled"]);
  });

  it("leaves other customers and finished requests alone", async () => {
    links.push({ merchant_id: "m1", customer_id: "fatima", id: "link2", cashfree_link_id: "other", status: "active", expires_at: future });
    links.push({ ...owner, id: "link3", cashfree_link_id: "paid", status: "paid", expires_at: future });
    await cancelOpenRequests(db, "m1", "ramesh");
    expect(cancelLink).toHaveBeenCalledTimes(1);
    expect(links[1]!.status).toBe("active");
    expect(links[2]!.status).toBe("paid");
  });

  it("keeps the row left out on purpose", async () => {
    await cancelOpenRequests(db, "m1", "ramesh", "qr1");
    expect(terminateOrder).not.toHaveBeenCalled();
    expect(qrs[0]!.status).toBe("active");
  });

  it("keeps a row open if Cashfree refuses, so a late payment can still be recorded", async () => {
    vi.mocked(cancelLink).mockRejectedValueOnce(new Error("link_not_active"));
    await cancelOpenRequests(db, "m1", "ramesh");
    expect(links[0]!.status).toBe("active");
    expect(qrs[0]!.status).toBe("cancelled");
  });

  it("closes expired requests without calling Cashfree", async () => {
    qrs[0]!.expires_at = past;
    await cancelOpenRequests(db, "m1", "ramesh");
    expect(terminateOrder).not.toHaveBeenCalled();
    expect(qrs[0]!.status).toBe("expired");
  });
});

describe("settlePayment", () => {
  it("records a payment once and closes the customer's other requests", async () => {
    const newlyPaid = await settlePayment(db, "payment_qrs", qrs[0] as never, 20000, "paid");
    expect(newlyPaid).toBe(20000);
    expect(qrs[0]!.status).toBe("paid");
    expect(links[0]!.status).toBe("cancelled");

    // The same payment reported again adds nothing.
    expect(await settlePayment(db, "payment_qrs", qrs[0] as never, 20000, "paid")).toBe(0);
  });
});
