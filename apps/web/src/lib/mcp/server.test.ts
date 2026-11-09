import { MemoryStore } from "@munshi/agents/testing";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createMunshiMcpServer, MCP_TOOL_NAMES } from "./server";

// A real MCP client talks to the real HTTP handler, in process, over the same transport Claude uses.

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(store: MemoryStore) {
  const handler = createMcpHandler(() => createMunshiMcpServer({ store, shopName: "Sri Ganesh Stores" }));
  const transport = new StreamableHTTPClientTransport(new URL("https://munshi.test/api/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  client = new Client({ name: "test-host", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function shop() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh", phone: "+919800000001" });
  await store.addCustomer({ name: "Lakshmi" });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id });
  store.entries[0]!.createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // not a recent twin
  return store;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const result = await c.callTool({ name, arguments: args });
  return result.structuredContent as Record<string, unknown>;
};

describe("Munshi MCP server", () => {
  it("lists the khata tools with hints for the host, and none of Munshi's internal ones", async () => {
    const c = await connect(await shop());
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools.map((t) => t.name)).not.toContain("handOff");
    expect(tools.map((t) => t.name)).not.toContain("showPaymentQr");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.getBalances?.annotations?.readOnlyHint).toBe(true);
    expect(byName.forget?.annotations?.destructiveHint).toBe(true);
    expect(byName.sendPaymentLink?.annotations?.openWorldHint).toBe(true);
    expect(byName.recordPayment?.inputSchema.properties).toHaveProperty("customerName");
    expect(c.getInstructions()).toContain("Sri Ganesh Stores");
  });

  it("answers from the ledger", async () => {
    const c = await connect(await shop());
    expect(await call(c, "getBalances", { customerName: "Ramesh" })).toMatchObject({ customers: [{ name: "Ramesh", owes: "₹450" }] });
    expect(await call(c, "recordCredit", { customerName: "Suresh", amount: 100 })).toMatchObject({ status: "customer_not_found" });
  });

  it("asks before saving the same payment twice, and saves it once the owner says it's new", async () => {
    const store = await shop();
    const c = await connect(store);
    expect(await call(c, "recordPayment", { customerName: "Ramesh", amount: 200 })).toMatchObject({ status: "recorded", nowOwes: "₹250" });
    expect(await call(c, "recordPayment", { customerName: "Ramesh", amount: 200 })).toMatchObject({ status: "possible_repeat", savedMinutesAgo: 0 });
    expect(store.entries).toHaveLength(2);
    expect(await call(c, "recordPayment", { customerName: "Ramesh", amount: 200, confirmedNew: true })).toMatchObject({ status: "recorded", nowOwes: "₹50" });
    expect(store.entries).toHaveLength(3);
  });

  it("makes a payment link only for what the customer owes", async () => {
    const store = await shop();
    const c = await connect(store);
    expect(await call(c, "sendPaymentLink", { customerName: "Ramesh", amount: 900 })).toMatchObject({ status: "exceeds_balance", owes: "₹450" });
    expect(await call(c, "sendPaymentLink", { customerName: "Ramesh" })).toMatchObject({ status: "sent", amount: "₹450" });
    expect(store.links).toHaveLength(1);
  });

  it("reports a failing tool as an error result, not a crash", async () => {
    const store = await shop();
    store.balances = async () => {
      throw new Error("database is down");
    };
    const c = await connect(store);
    const result = await c.callTool({ name: "getBalances", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("database is down");
  });
});
