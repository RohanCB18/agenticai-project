import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { claimsUnbackedAction, completedActions, receiptLines } from "./receipts";

const result = (toolName: string, value: Record<string, unknown>): ModelMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: `call_${toolName}`, toolName, output: { type: "json", value: value as never } }],
});

describe("completedActions", () => {
  it("counts only saved changes", () => {
    const actions = completedActions([
      result("recordCredit", { status: "recorded", customer: "Ramesh", amount: "₹450", nowOwes: "₹900" }),
      result("getBalances", { customers: [] }),
      result("recordPayment", { status: "customer_not_found", name: "Suresh" }),
      { role: "assistant", content: "Ramesh ka 450 likh diya" },
    ]);
    expect(actions).toEqual([{ tool: "recordCredit", output: expect.objectContaining({ customer: "Ramesh" }) }]);
  });
});

describe("receiptLines", () => {
  it("writes each saved change from the tool's own output", () => {
    const lines = receiptLines(
      completedActions([
        result("recordCredit", { status: "recorded", customer: "Ramesh", amount: "₹450", nowOwes: "₹900" }),
        result("recordPayment", { status: "recorded", customer: "Fatima", amount: "₹200", nowOwes: "₹0" }),
        result("recordSale", { status: "recorded", kind: "expense", amount: "₹120" }),
        result("updateStock", { status: "updated", product: "Rice", stock: "50 kg" }),
        result("addCustomer", { status: "added", customer: { id: "c1", name: "Anand" } }),
        result("sendPaymentLink", { status: "sent", url: "https://pay" }),
      ]),
    );
    expect(lines).toEqual([
      "🧾 Udhaar: Ramesh ₹450 · owes ₹900",
      "🧾 Payment: Fatima ₹200 · owes ₹0",
      "🧾 Expense: ₹120",
      "🧾 Stock: Rice now 50 kg",
      "🧾 New customer: Anand",
    ]);
  });
});

describe("claimsUnbackedAction", () => {
  it.each([
    "Ramesh ka 450 udhaar likh diya.",
    "Ramesh ka 450 record ho gaya, ab 900 baaki hai.",
    "Recorded ₹450 for Ramesh.",
    "Ramesh ge 450 udhaar bardide.",
    "रमेश का 450 लिख दिया।",
    "ರಮೇಶ್ ಗೆ 450 ಉದಾರ್ ಬರೆದಿದೆ.",
    "Payment link bhej diya.",
  ])("catches a claim with no action behind it: %s", (reply) => {
    expect(claimsUnbackedAction(reply, [])).toBe(true);
  });

  it.each([
    "Ramesh ka ₹450 baaki hai.",
    "Ramesh owes ₹450.",
    "Ramesh ge 450 baaki ide.",
    "Kya main Ramesh ka 450 likh doon?",
    "Should I record ₹450 for Ramesh?",
    "Rice 50 kg stock mein hai.",
    "रमेश का 450 बाकी है।",
  ])("leaves answers that claim nothing alone: %s", (reply) => {
    expect(claimsUnbackedAction(reply, [])).toBe(false);
  });

  it("allows claims when a write action really happened", () => {
    expect(claimsUnbackedAction("Ramesh ka 450 likh diya.", [{ tool: "recordCredit", output: { status: "recorded" } }])).toBe(false);
  });
});
