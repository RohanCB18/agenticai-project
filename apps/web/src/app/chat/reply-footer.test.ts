import type { KhataUIMessage } from "@munshi/agents";
import { NOT_RECORDED, NOTHING_SAVED } from "@munshi/agents/receipts";
import { describe, expect, it } from "vitest";
import { footerFor } from "./reply-footer";

// Chat messages as useChat holds them. Only the fields the footer reads matter here.
const user = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id: string, parts: unknown[]) => ({ id, role: "assistant", parts });
const chat = (...messages: unknown[]) => messages as KhataUIMessage[];

const credit = { type: "tool-recordCredit", toolCallId: "c1", state: "output-available", input: {}, output: { status: "recorded", customer: "Ramesh", amount: "₹450", nowOwes: "₹1,250" } };

describe("the web chat's reply footer", () => {
  it("shows the same receipt Telegram sends, from the tool's result", () => {
    const messages = chat(user("u1", "Ramesh ne 450 ka saaman liya"), assistant("a1", [credit, { type: "text", text: "Ramesh ka ₹450 udhaar likh diya." }]));
    expect(footerFor(messages, 1, true)).toEqual({ receipts: ["🧾 Udhaar: Ramesh ₹450 · owes ₹1,250"], notice: null });
  });

  it("warns when the reply claims an entry that no tool saved", () => {
    const messages = chat(user("u1", "Ramesh ne 450 ka saaman liya"), assistant("a1", [{ type: "text", text: "Ramesh ka 450 likh diya." }]));
    expect(footerFor(messages, 1, true).notice).toBe(NOTHING_SAVED);
  });

  it("says nothing was recorded when the owner reported money and got only an answer", () => {
    const messages = chat(user("u1", "Ramesh ne 200 diye, ab kitna baaki hai?"), assistant("a1", [{ type: "text", text: "Ramesh ka ₹250 baaki hai." }]));
    expect(footerFor(messages, 1, true).notice).toBe(NOT_RECORDED);
  });

  it("reads the owner's words for this reply, not an older message", () => {
    const messages = chat(
      user("u1", "Ramesh ne 200 diye"),
      assistant("a1", [{ type: "text", text: "Kya 200 payment likhun?" }]),
      user("u2", "Ramesh ka kitna baaki hai?"),
      assistant("a2", [{ type: "text", text: "Ramesh ka ₹450 baaki hai." }]),
    );
    expect(footerFor(messages, 3, true).notice).toBeNull();
  });

  it("waits for the end of the turn and for any approval before warning", () => {
    const reported = user("u1", "Sharma Traders ko 500 diye");
    const streaming = chat(reported, assistant("a1", [{ type: "text", text: "Dekhta hoon" }]));
    expect(footerFor(streaming, 1, false).notice).toBeNull();

    const waiting = chat(reported, assistant("a1", [{ type: "tool-paySupplier", toolCallId: "p1", state: "approval-requested", input: {}, approval: { id: "ap1" } }]));
    expect(footerFor(waiting, 1, true)).toEqual({ receipts: [], notice: null });
  });

  it("adds the receipt for what ran after the owner's OK", () => {
    const paid = {
      type: "tool-paySupplier",
      toolCallId: "p1",
      state: "output-available",
      input: {},
      approval: { id: "ap1", approved: true },
      output: { status: "payout_started", supplier: "Sharma Traders", amount: "₹500", to: "UPI su•••@upi" },
    };
    const messages = chat(user("u1", "Sharma Traders ko payment kar do"), assistant("a1", [paid, { type: "text", text: "Payment shuru ho gaya." }]));
    expect(footerFor(messages, 1, true)).toEqual({ receipts: ["💸 Paying Sharma Traders ₹500 to UPI su•••@upi from your Cashfree balance · started, Munshi will confirm"], notice: null });
  });
});
