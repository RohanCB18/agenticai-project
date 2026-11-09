import { createKhataTools, type KhataStore } from "@munshi/agents";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

// The khata as an MCP server, so any MCP host (Claude, ChatGPT, an IDE) can read and keep a
// shop's books. These are the same tools Munshi's own agent uses, with the same checks: an
// unknown or ambiguous name, a possible repeat or an amount above the balance comes back as a
// question for the owner, never a guess.

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

/** What each exposed tool is called in a host's UI, and how hosts should treat it. */
const EXPOSED: Record<string, { title: string; annotations: Annotations }> = {
  getBalances: { title: "Who owes what", annotations: { readOnlyHint: true } },
  findCustomer: { title: "Find a customer", annotations: { readOnlyHint: true } },
  getStock: { title: "Check stock", annotations: { readOnlyHint: true } },
  paymentHabits: { title: "When a customer usually pays", annotations: { readOnlyHint: true } },
  recall: { title: "What Munshi remembers", annotations: { readOnlyHint: true } },
  // Asks Cashfree, and records a payment that arrived: safe to repeat, but it can write.
  checkPayment: { title: "Check online payments", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  addCustomer: { title: "Add a customer", annotations: { readOnlyHint: false, destructiveHint: false } },
  recordCredit: { title: "Record udhaar", annotations: { readOnlyHint: false, destructiveHint: false } },
  recordPayment: { title: "Record a payment", annotations: { readOnlyHint: false, destructiveHint: false } },
  recordSale: { title: "Record a sale or expense", annotations: { readOnlyHint: false, destructiveHint: false } },
  updateStock: { title: "Change stock", annotations: { readOnlyHint: false, destructiveHint: false } },
  remember: { title: "Remember a fact", annotations: { readOnlyHint: false, destructiveHint: false } },
  forget: { title: "Forget a fact", annotations: { readOnlyHint: false, destructiveHint: true } },
  // Sends the customer a real UPI link (and an SMS, in production).
  sendPaymentLink: { title: "Send a UPI payment link", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
};
// Not exposed: showPaymentQr is an image for the shop counter, and handOff is internal to Munshi's desks.

export const MCP_TOOL_NAMES = Object.keys(EXPOSED);

function instructions(shopName: string) {
  return [
    `Munshi keeps the khata (credit ledger), sales and stock of ${shopName}, a small shop in India. Amounts are in rupees.`,
    "Use getBalances, getStock and findCustomer for facts; never guess what someone owes.",
    "If a tool returns customer_not_found, ambiguous_customer, product_not_found, ambiguous_product, exceeds_balance or possible_repeat, ask the owner instead of retrying with a guess.",
    "possible_repeat means the same entry was saved minutes ago: call again with confirmedNew: true only after the owner says it is a new one.",
    "sendPaymentLink sends the customer a real UPI payment link. Confirm the customer and amount with the owner first.",
    "Customer names may be in any Indian language or script; pass them as the owner said them.",
  ].join("\n");
}

/** One MCP server for one shop, built per request from that shop's store. */
export function createMunshiMcpServer({ store, shopName }: { store: KhataStore; shopName: string }) {
  // The host shows every write call to the owner before it runs, so confirmedNew is the owner's answer.
  const tools = createKhataTools(store, shopName, { repeatConfirmed: () => true });
  const server = new McpServer({ name: "munshi", title: `Munshi: ${shopName}`, version: "1.0.0" }, { instructions: instructions(shopName) });

  for (const [name, { title, annotations }] of Object.entries(EXPOSED)) {
    const tool = tools[name as keyof typeof tools];
    if (!tool?.execute) continue;
    // Every khata tool takes a zod object and returns plain JSON; the generic types don't line up.
    const execute = tool.execute as unknown as (input: unknown, options: { toolCallId: string; messages: []; context: object }) => Promise<unknown>;
    server.registerTool(
      name,
      {
        title,
        description: typeof tool.description === "string" ? tool.description : title,
        inputSchema: tool.inputSchema as unknown as StandardSchemaWithJSON,
        annotations,
      },
      async (input) => {
        try {
          const result = (await execute(input, { toolCallId: `mcp_${crypto.randomUUID()}`, messages: [], context: {} })) as Record<string, unknown>;
          console.info(`[munshi] mcp ${name} -> ${typeof result?.status === "string" ? result.status : "ok"}`);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          console.error(`[munshi] mcp ${name} failed:`, error);
          return { isError: true, content: [{ type: "text" as const, text: `${title} failed: ${error instanceof Error ? error.message : "unknown error"}` }] };
        }
      },
    );
  }
  return server;
}
