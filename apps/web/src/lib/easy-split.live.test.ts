import { describe, expect, it } from "vitest";
import { createPaymentLink, createVendor, getLink, getVendor, newVendorId } from "./cashfree";

// Real calls to the Cashfree sandbox for paying suppliers with Easy Split: adds a test supplier as
// a vendor (Cashfree's test UPI ID and example KYC values) and makes a ₹1 payment page split to it.
// Nothing is paid. Off by default: set EASY_SPLIT_LIVE=1 with the sandbox payment keys.
const live = process.env.EASY_SPLIT_LIVE === "1" && process.env.CASHFREE_ENV !== "production";

describe.skipIf(!live)("Cashfree Easy Split sandbox", () => {
  it("adds a supplier and makes a payment page that pays them", { timeout: 60_000 }, async () => {
    const vendorId = newVendorId();
    const vendor = await createVendor({
      vendorId,
      name: "Sharma Traders",
      email: "sharma.traders@example.com",
      phone: "9999999999",
      account: { vpa: "success@upi" },
      kyc: { pan: "BIAPA2934N" },
    });
    expect(["IN_BANK_VALIDATION", "ACTIVE"]).toContain(vendor.status);
    expect(await getVendor(vendorId)).toMatchObject({ vendor_id: vendorId });

    const linkId = `munshi_live_${Date.now()}`;
    const link = await createPaymentLink({
      linkId,
      amountPaise: 100,
      purpose: "Payment to Sharma Traders, through Munshi (live test)",
      customer: { name: "Test Owner", phone: "9999999999" },
      expiresAt: new Date(Date.now() + 60 * 60_000),
      splits: [{ vendorId, amountPaise: 100 }],
    });
    console.log(`vendor ${vendorId}: ${vendor.status}; page ${link.link_id}: ${link.link_status} ${link.link_url}`);
    expect(link.link_url).toMatch(/^https:\/\//);
    expect(await getLink(linkId)).toMatchObject({ link_status: "ACTIVE" });
  });
});
