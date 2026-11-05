import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { approvalResponse, closePendingApprovals, pendingApprovals, toolOutputs, trimThread } from "./threads";

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
