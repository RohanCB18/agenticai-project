"use client";

import { useActionState, useState } from "react";
import { addPayoutAccount, type PayoutAccountState } from "./actions";

const field = "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function PayoutAccountForm() {
  const [method, setMethod] = useState<"upi" | "bank">("upi");
  const [state, action, pending] = useActionState<PayoutAccountState, FormData>(addPayoutAccount, {});

  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div>
        <p className="font-medium">Add a supplier Munshi can pay</p>
        <p className="text-sm text-muted">
          Munshi pays only accounts added here, and asks for your OK every time. You pay a Cashfree payment page, and Cashfree sends the money on to
          this account.
        </p>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        Supplier name, as on their orders
        <input name="name" required className={field} placeholder="Sharma Traders" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          Supplier&apos;s phone
          <input name="phone" required inputMode="tel" className={field} placeholder="98XXXXXXXX" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Supplier&apos;s GSTIN or PAN
          <input name="taxId" required className={`${field} uppercase`} placeholder="On their bill, like 29ABCDE1234F1Z5" autoComplete="off" />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        Supplier&apos;s email (optional: Cashfree&apos;s settlement emails go to yours if left out)
        <input name="email" type="email" className={field} placeholder="accounts@sharmatraders.in" autoComplete="off" />
      </label>

      <fieldset className="flex gap-4 text-sm">
        <legend className="mb-1.5">Pay by</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="method" value="upi" checked={method === "upi"} onChange={() => setMethod("upi")} /> UPI ID
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="method" value="bank" checked={method === "bank"} onChange={() => setMethod("bank")} /> Bank account
        </label>
      </fieldset>

      {method === "upi" ? (
        <label className="flex flex-col gap-1.5 text-sm">
          UPI ID
          <input name="vpa" required className={field} placeholder="sharmatraders@okhdfc" autoComplete="off" />
        </label>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            Account number
            <input name="account" required inputMode="numeric" className={field} autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            IFSC
            <input name="ifsc" required className={`${field} uppercase`} placeholder="HDFC0001234" autoComplete="off" />
          </label>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmed" className="mt-1" />
        <span>I confirmed these details with the supplier myself, by phone or in person. Money sent to a wrong account is hard to get back.</span>
      </label>

      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.saved && <p className="text-sm text-accent">{state.saved}</p>}

      <button type="submit" disabled={pending} className="self-start rounded-md bg-accent px-4 py-2.5 font-medium text-on-accent disabled:opacity-60">
        {pending ? "Adding to Cashfree…" : "Save account"}
      </button>
    </form>
  );
}
