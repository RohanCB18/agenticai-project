import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { approvalResponse, closePendingApprovals, forgetOldToolResults, ownerWasAskedAboutRepeat, pendingApprovals, toolOutputs, trimThread } from "./threads";

const asked: ModelMessage[] = [
  { role: "user", content: "Ramesh ko link bhejo" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call_1", toolName: "sendPaymentLink", input: { customer: "Ramesh" } },
      { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "call_1" },
    ],
  },
];

describe("threads", () => {
  it("finds the unanswered approval with its tool input", () => {
    expect(pendingApprovals(asked)).toEqual([{ approvalId: "appr_1", toolCallId: "call_1", toolName: "sendPaymentLink", input: { customer: "Ramesh" } }]);
  });

  it("treats an answered approval as done", () => {
    expect(pendingApprovals([...asked, approvalResponse("appr_1", true)])).toEqual([]);
  });

  it("denies approvals the owner moved on from", () => {
    const closed = closePendingApprovals(asked);
    expect(closed.at(-1)).toMatchObject({ role: "tool", content: [{ type: "tool-approval-response", approvalId: "appr_1", approved: false }] });
    expect(pendingApprovals(closed)).toEqual([]);
    expect(closePendingApprovals(closed)).toBe(closed);
  });

  it("finds a tool's output in response messages", () => {
    const response: ModelMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: "sendPaymentLink", output: { type: "json", value: { status: "sent", url: "https://pay" } } },
          { type: "tool-result", toolCallId: "call_2", toolName: "getBalances", output: { type: "json", value: { total: "₹1" } } },
        ],
      },
      { role: "assistant", content: "Link bhej diya" },
    ];
    expect(toolOutputs(response, "sendPaymentLink")).toEqual([{ status: "sent", url: "https://pay" }]);
    expect(toolOutputs(asked, "sendPaymentLink")).toEqual([]);
  });

  it("blanks tool results from earlier turns but keeps this turn's", () => {
    const stock = (value: number): ModelMessage => ({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: `call_${value}`, toolName: "getStock", output: { type: "json", value: { rice: value } } }],
    });
    const call = (value: number): ModelMessage => ({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: `call_${value}`, toolName: "getStock", input: {} }],
    });
    const thread: ModelMessage[] = [
      { role: "user", content: "stock kitna hai?" },
      call(25),
      stock(25),
      { role: "assistant", content: "Rice 25 kg" },
      { role: "user", content: "stock kitna hai?" },
      call(50),
      stock(50),
    ];

    const seen = forgetOldToolResults(thread);
    const blanked = (seen[2] as { content: { output: unknown }[] }).content[0]!.output;
    expect(blanked).toEqual({ type: "text", value: expect.stringContaining("no longer current") });
    expect(seen[1]).toBe(thread[1]); // the call and its input stay
    expect(seen[6]).toBe(thread[6]); // this turn's result is untouched
    expect(JSON.stringify(thread[2])).toContain("25"); // the saved thread keeps the real value
  });

  it("keeps a repeat question readable, and knows when the owner answered it", () => {
    const question = { status: "possible_repeat", customer: "Fatima", amount: "₹200" };
    const thread: ModelMessage[] = [
      { role: "user", content: "Fatima ne 200 diye" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "p1", toolName: "recordPayment", output: { type: "json", value: question } }] },
      { role: "assistant", content: "Abhi 200 likha tha. Naya hai?" },
      { role: "user", content: "Haan naya hai" },
    ];
    expect((forgetOldToolResults(thread)[1] as { content: { output: unknown }[] }).content[0]!.output).toEqual({ type: "json", value: question });
    expect(ownerWasAskedAboutRepeat(thread, "Fatima", "₹200")).toBe(true);
    expect(ownerWasAskedAboutRepeat(thread, "Fatima", "₹300")).toBe(false);
    // Asked, but the owner hasn't answered yet.
    expect(ownerWasAskedAboutRepeat(thread.slice(0, 3), "Fatima", "₹200")).toBe(false);
  });

  it("trims long threads at an owner message", () => {
    const long: ModelMessage[] = Array.from({ length: 30 }, (_, i) => [
      { role: "user" as const, content: `q${i}` },
      { role: "assistant" as const, content: `a${i}` },
    ]).flat();
    const trimmed = trimThread(long, 9);
    expect(trimmed[0]).toEqual({ role: "user", content: "q26" });
    expect(trimmed).toHaveLength(8);
    expect(trimThread(asked, 40)).toBe(asked);
  });
});
