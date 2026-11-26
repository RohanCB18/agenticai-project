import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  askedAboutRepeat,
  askedAboutRepeatInParts,
  claimsUnbackedAction,
  completedActions,
  completedActionsInParts,
  missedEntry,
  NOT_RECORDED,
  NOTHING_SAVED,
  replyFooter,
  reportsEntry,
  receiptLines,
} from "./receipts";

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
        result("recordPayment", { status: "recorded", customer: "Fatima", amount: "₹200", nowOwes: "₹0", advance: "₹50" }),
        result("recordSale", { status: "recorded", kind: "expense", amount: "₹120" }),
        result("updateStock", { status: "updated", product: "Rice", stock: "50 kg" }),
        result("addCustomer", { status: "added", customer: { id: "c1", name: "Anand" } }),
        result("updateCustomer", { status: "updated", customer: "Fatima Begum", previousName: "Fatima", phone: "9800000002" }),
        result("sendPaymentLink", { status: "sent", url: "https://pay" }),
        result("lookupGst", { status: "found", entries: [] }),
        result("paySupplier", { status: "payout_started", supplier: "Sharma Traders", amount: "₹4,200", to: "UPI su•••@upi" }),
        result("paySupplier", { status: "paid", supplier: "Sharma Traders", amount: "₹1,500", to: "UPI su•••@upi", utr: "UTR9" }),
      ]),
    );
    expect(lines).toEqual([
      "🧾 Udhaar: Ramesh ₹450 · owes ₹900",
      "🧾 Payment: Fatima ₹200 · owes ₹0 (₹50 advance)",
      "🧾 Expense: ₹120",
      "🧾 Stock: Rice now 50 kg",
      "🧾 New customer: Anand",
      "🧾 Customer: Fatima Begum (was Fatima) · phone 9800000002",
      "💸 Paying Sharma Traders ₹4,200 to UPI su•••@upi from your Cashfree balance · started, Munshi will confirm",
      "💸 Paid Sharma Traders ₹1,500 to UPI su•••@upi from your Cashfree balance · UTR UTR9",
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
    "Sugar 5 kg stock kam kar diya. Sale ka amount kitna tha?",
    "Maggi ka stock badha diya.",
    "Reduced sugar stock by 5 kg.",
    "Sakkare stock kammi maadide.",
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
    "Sugar ka stock kam hai, 3 kg bacha hai.",
    "Kya sugar ka stock 5 kg kam karun?",
  ])("leaves answers that claim nothing alone: %s", (reply) => {
    expect(claimsUnbackedAction(reply, [])).toBe(false);
  });

  it("allows claims when a write action really happened", () => {
    expect(claimsUnbackedAction("Ramesh ka 450 likh diya.", [{ tool: "recordCredit", output: { status: "recorded" } }])).toBe(false);
  });
});

describe("reported entries that weren't recorded", () => {
  it("recognises an owner reporting money or goods changing hands", () => {
    for (const text of [
      "Ramesh ne 200 diye, ab kitna baaki hai?",
      "Fatima 100 rupayi kottru",
      "Ramesh avru 300 saaman togondru",
      "रमेश ने 150 रुपये दिए",
      "ಫಾತಿಮಾ 50 ರೂಪಾಯಿ ಕೊಟ್ಟರು",
      "Ramesh paid 300 in cash",
      "10 packet Maggi aaya",
    ]) {
      expect(reportsEntry(text), text).toBe(true);
    }
  });

  it("leaves questions and requests alone", () => {
    for (const text of ["Ramesh ka kitna baaki hai?", "Ramesh ka payment aaya?", "Ramesh ko 200 ka link bhejo", "Fatima ka QR dikhao", "Namaste", "Diya ka balance?"]) {
      expect(reportsEntry(text), text).toBe(false);
    }
  });

  it("flags only when nothing was saved and the reply doesn't ask", () => {
    const owner = "Ramesh ne 200 diye, ab kitna baaki hai?";
    expect(missedEntry(owner, "Ramesh ka balance 0 rupaye hai.", [])).toBe(true);
    expect(missedEntry(owner, "Ramesh ka kuch baaki nahi hai. Kya 200 advance ke roop mein likhun?", [])).toBe(false);
    expect(missedEntry(owner, "Ramesh ka ab 0 baaki hai.", [{ tool: "recordPayment", output: { status: "recorded" } }])).toBe(false);
    expect(missedEntry("Ramesh ka kitna baaki hai?", "Ramesh ka 450 baaki hai.", [])).toBe(false);
  });
});

describe("the web chat's view of a turn", () => {
  it("reads saved changes from chat message parts, including after an approval", () => {
    const parts = [
      { type: "step-start" },
      { type: "tool-getBalances", state: "output-available", output: { customers: [], total: "₹0" } },
      { type: "tool-recordCredit", state: "output-available", output: { status: "recorded", customer: "Ramesh", amount: "₹450", nowOwes: "₹1,250" } },
      { type: "tool-recordPayment", state: "output-available", output: { status: "possible_repeat" } },
      { type: "tool-recordSale", state: "input-available" },
      { type: "tool-paySupplier", state: "output-available", output: { status: "payout_started", supplier: "Sharma Traders", amount: "₹500", to: "UPI su•••@upi" } },
      { type: "text", text: "Ramesh ka 450 likh diya." },
    ];
    expect(completedActionsInParts(parts).map((a) => a.tool)).toEqual(["recordCredit", "paySupplier"]);
  });
});

describe("GST tag receipts", () => {
  it("writes the tag from the tool's output, and nothing until it is saved", () => {
    expect(receiptLines([{ tool: "setProductGst", output: { status: "tagged", product: "Maggi", hsn: "1902", gst: "5%" } }])).toEqual(["🧾 GST tag: Maggi · HSN 1902 · 5%"]);
    expect(completedActionsInParts([{ type: "tool-setProductGst", state: "output-available", output: { status: "choose_rate" } }])).toEqual([]);
  });
});

describe("replyFooter", () => {
  const credit = { tool: "recordCredit", output: { status: "recorded", customer: "Ramesh", amount: "₹450", nowOwes: "₹1,250" } };

  it("lists receipts and no warning when the change was saved", () => {
    expect(replyFooter({ ownerText: "Ramesh ne 450 ka saaman liya", reply: "Likh diya.", actions: [credit], awaitingApproval: false })).toEqual({
      receipts: ["🧾 Udhaar: Ramesh ₹450 · owes ₹1,250"],
      notice: null,
    });
  });

  it("doesn't warn when the reply asks about an entry a tool found saved minutes ago", () => {
    // Live: "yeh entry pehle bhi record hui thi. Kya yeh naya payment hai?" got "Nothing was saved".
    const reply = "Ramesh ne 20 rupaye diye, yeh entry pehle bhi record hui thi. Kya yeh naya payment hai?";
    expect(replyFooter({ ownerText: "Ramesh ne 20 diye", reply, actions: [], awaitingApproval: false }).notice).toBe(NOTHING_SAVED);
    expect(replyFooter({ ownerText: "Ramesh ne 20 diye", reply, actions: [], awaitingApproval: false, repeatAsked: true }).notice).toBeNull();

    const repeat = { type: "tool-recordPayment", state: "output-available", output: { status: "possible_repeat" } };
    expect(askedAboutRepeatInParts([{ type: "text" }, repeat])).toBe(true);
    expect(askedAboutRepeatInParts([{ ...repeat, output: { status: "recorded" } }])).toBe(false);
    const toolMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "1", toolName: "recordPayment", output: { type: "json", value: { status: "possible_repeat" } } }],
    } as unknown as ModelMessage;
    expect(askedAboutRepeat([toolMessage])).toBe(true);
  });

  it("warns when the reply claims a change no tool made", () => {
    expect(replyFooter({ ownerText: "Ramesh ne 450 ka saaman liya", reply: "Ramesh ka 450 likh diya.", actions: [], awaitingApproval: false }).notice).toBe(NOTHING_SAVED);
  });

  it("says when a reported entry wasn't recorded", () => {
    expect(replyFooter({ ownerText: "Ramesh ne 200 diye, ab kitna baaki hai?", reply: "Ramesh ka 0 baaki hai.", actions: [], awaitingApproval: false }).notice).toBe(NOT_RECORDED);
  });

  it("stays quiet while an approval waits, and doesn't warn twice", () => {
    expect(replyFooter({ ownerText: "Ramesh ne 200 diye", reply: "Link bhej diya.", actions: [], awaitingApproval: true }).notice).toBeNull();
    expect(replyFooter({ ownerText: "Ramesh ne 200 diye", reply: `Likh diya.\n\n${NOTHING_SAVED}`, actions: [], awaitingApproval: false }).notice).toBeNull();
  });
});
