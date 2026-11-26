import { describe, expect, it, vi } from "vitest";
import { createBeneficiary, createTransfer, getTransfer, newBeneficiaryId, newTransferId, payoutStatus, type PayoutStatus } from "./cashfree-payouts";
import { sendFromBalance } from "./supplier-payouts";

vi.mock("./payments", () => ({ notifyOwner: vi.fn() }));

// Real calls to the Cashfree Payouts sandbox: adds a test supplier and pays it ₹1 of test money.
// Off by default: set PAYOUTS_LIVE=1 with the Payouts sandbox keys. Cashfree's test UPI IDs decide
// the outcome: success@upi is paid, failure@upi fails. The caller must pass Cashfree's 2FA (an
// allowed IP, or CASHFREE_PAYOUT_PUBLIC_KEY when the account uses Public Key).
const live = process.env.PAYOUTS_LIVE === "1" && process.env.CASHFREE_ENV !== "production";

/** Asks Cashfree until the transfer leaves "pending" or the time runs out. */
async function settle(transferId: string, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const transfer = await getTransfer(transferId);
    const status: PayoutStatus = payoutStatus(transfer.status);
    if (status !== "pending" || Date.now() - started > timeoutMs) return { status, transfer };
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function payTestSupplier(vpa: string) {
  const run = `${Date.now()}`;
  const beneficiary = await createBeneficiary({ beneficiaryId: `munshi_live_${run}`, name: "Sharma Traders", account: { vpa } });
  const started = await createTransfer({
    transferId: `munshi_live_${run}`,
    amountPaise: 100,
    beneficiaryId: beneficiary.beneficiary_id,
    mode: "upi",
    remarks: "Munshi live test",
  });
  const settled = await settle(started.transfer_id);
  console.log(`${vpa}: beneficiary ${beneficiary.beneficiary_status ?? "?"}, started ${started.status}, ended ${settled.transfer.status} (${settled.transfer.status_code ?? "-"})`);
  return { beneficiary, started, ...settled };
}

describe.skipIf(!live)("Cashfree Payouts sandbox", () => {
  it("pays a supplier's UPI ID and the transfer succeeds", { timeout: 90_000 }, async () => {
    const { started, status, transfer } = await payTestSupplier("success@upi");
    expect(started.transfer_id).toMatch(/^munshi_live_/);
    expect(status).toBe("success");
    expect(transfer.status).toBe("SUCCESS");
  });

  it("pays from the balance the way Munshi does after a haan, and hears how it went within seconds", { timeout: 60_000 }, async () => {
    const beneficiary = await createBeneficiary({ beneficiaryId: newBeneficiaryId(), name: "Sharma Traders", account: { vpa: "success@upi" } });
    const started = Date.now();
    const event = await sendFromBalance({ transferId: newTransferId(), amountPaise: 100, beneficiaryId: beneficiary.beneficiary_id, mode: "upi", remarks: "Munshi live test" });
    console.log(`sendFromBalance: ${event.status} (${event.statusCode ?? "-"}) in ${Date.now() - started} ms, UTR ${event.utr ?? "-"}`);
    expect(event.status).toBe("success");
  });

  it("reports a failed payout as failed, not paid", { timeout: 90_000 }, async () => {
    const outcome = await payTestSupplier("failure@upi").catch((error: Error) => error);
    // Cashfree may refuse the UPI ID up front or fail the transfer; either way nothing is paid.
    if (outcome instanceof Error) expect(outcome.message).toMatch(/Cashfree Payouts/);
    else expect(outcome.status).toBe("failed");
  });
});
