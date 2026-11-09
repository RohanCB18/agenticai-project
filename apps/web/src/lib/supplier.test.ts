import { Role } from "@a2a-js/sdk";
import { readQuote } from "@munshi/agents";
import { describe, expect, it } from "vitest";
import { createA2ASupplier, replyData } from "./supplier";

const data = (value: object) => ({ content: { $case: "data" as const, value }, metadata: undefined, filename: "", mediaType: "application/json" });
const message = (role: Role, value: object) => ({ messageId: "m", contextId: "", taskId: "", role, parts: [data(value)], metadata: undefined, extensions: [], referenceTaskIds: [] });

describe("replyData", () => {
  it("reads the data part of a direct reply or of a task's last agent message", () => {
    expect(replyData(message(Role.ROLE_AGENT, { type: "quote" }))).toEqual({ type: "quote" });
    const task = { id: "t", contextId: "", status: undefined, artifacts: [], metadata: undefined, history: [message(Role.ROLE_USER, { action: "quote" }), message(Role.ROLE_AGENT, { type: "order" })] };
    expect(replyData(task as never)).toEqual({ type: "order" });
  });
});

// Munshi's TypeScript A2A client against the Python wholesaler (services/distributor). Start it
// with `uv run munshi-distributor`, then run with A2A_INTEROP_URL=http://127.0.0.1:8102.
const url = process.env.A2A_INTEROP_URL;

describe.skipIf(!url)("A2A with the Python wholesaler", () => {
  it("finds the agent from its card, gets a signed quote and places the order", async () => {
    const supplier = createA2ASupplier(url!);
    const quote = await supplier.quote(
      [
        { name: "Rice", quantity: 20, unit: "kg" },
        { name: "Maggi", quantity: 30, unit: "packet" },
        { name: "Ghee", quantity: 2, unit: "litre" },
      ],
      "Sri Ganesh Stores",
    );
    expect(supplier.name).toBe("Sharma Traders");
    expect(quote.lines.map((l) => [l.item, l.quantity])).toEqual([
      ["Sona Masoori Rice", 25],
      ["Maggi Noodles", 48],
    ]);
    expect(quote.total).toBe("₹1,876");
    expect(quote.unavailable).toEqual([{ requested: "Ghee", item: "Amul Ghee", reason: "out of stock this week" }]);
    expect(readQuote(quote.quoteId!)?.total).toBe("₹1,876"); // what the owner is shown is what gets ordered

    const order = await supplier.order(quote.quoteId!);
    expect(order).toMatchObject({ supplier: "Sharma Traders", total: "₹1,876" });
    expect(order.orderId).toMatch(/^ST-[0-9A-F]{8}$/);
    await expect(supplier.order(`${quote.quoteId!.slice(0, -6)}AAAAAA`)).rejects.toMatchObject({ code: "invalid_quote" });
  });
});
