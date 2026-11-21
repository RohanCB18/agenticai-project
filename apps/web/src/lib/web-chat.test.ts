import type { KhataUIMessage } from "@munshi/agents";
import { describe, expect, it } from "vitest";
import { closeStaleApprovals, keepRecent, replySummary } from "./web-chat";

const user = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id: string, parts: unknown[]) => ({ id, role: "assistant", parts });
const chat = (...messages: unknown[]) => messages as KhataUIMessage[];
const waiting = (id: string) => ({ type: "tool-sendPaymentLink", toolCallId: `call-${id}`, state: "approval-requested", input: { customerName: "Ramesh" }, approval: { id } });

describe("keepRecent", () => {
  it("keeps the latest messages, starting at an owner's message", () => {
    const messages = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`u${i}`, "q") : assistant(`a${i}`, [])));
    expect(keepRecent(messages, 4).map((m) => m.id)).toEqual(["u6", "a7", "u8", "a9"]);
    // Five would start on a reply, cut from its question: start at the next owner message instead.
    expect(keepRecent(messages, 5).map((m) => m.id)).toEqual(["u6", "a7", "u8", "a9"]);
    expect(keepRecent(messages, 40)).toBe(messages);
  });
});

describe("closeStaleApprovals", () => {
  it("declines an approval the owner moved past, and leaves the latest one waiting", () => {
    const messages = chat(
      user("u1", "Ramesh ko link bhejo"),
      assistant("a1", [waiting("ap1"), { type: "text", text: "Bhejun?" }]),
      user("u2", "Suresh ka balance?"),
      assistant("a2", [waiting("ap2")]),
    );
    const closed = closeStaleApprovals(messages);
    expect(closed[1]!.parts[0]).toMatchObject({ state: "output-denied", approval: { id: "ap1", approved: false, reason: "The owner moved on without answering." } });
    expect(closed[1]!.parts[1]).toEqual({ type: "text", text: "Bhejun?" });
    expect(closed[3]).toBe(messages[3]);
    expect(closed[0]).toBe(messages[0]);
  });
});

describe("replySummary", () => {
  it("says what a reply did, for the logs", () => {
    const reply = assistant("a1", [{ type: "step-start" }, { type: "tool-lookupGst" }, { type: "step-start" }, { type: "tool-setProductGst" }, { type: "text", text: "Done" }]) as KhataUIMessage;
    expect(replySummary(reply)).toBe("2 steps, tools lookupGst > setProductGst");
    expect(replySummary(undefined)).toBe("0 steps, tools none");
  });
});
