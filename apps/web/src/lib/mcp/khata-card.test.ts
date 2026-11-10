import { readFile } from "node:fs/promises";
import { MemoryStore } from "@munshi/agents/testing";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { bundleKhataView, moduleSource } from "../../../scripts/build-mcp-app.mjs";
import { KHATA_CARD_URI, khataCard, khataText } from "./khata-card";
import { createMunshiMcpServer } from "./server";

const NOW = new Date("2026-11-10T06:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

async function shop() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh", phone: "+919800000001" });
  const fatima = await store.addCustomer({ name: "Fatima", phone: "+919800000002" });
  const anand = await store.addCustomer({ name: "Anand" });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 90000, customerId: fatima.id });
  await store.addLedgerEntry({ kind: "payment_received", amountPaise: 20000, customerId: fatima.id });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 30000, customerId: anand.id });
  await store.addLedgerEntry({ kind: "payment_received", amountPaise: 30000, customerId: anand.id }); // paid up
  store.entries.forEach((e, i) => (e.createdAt = daysAgo(10 - i)));
  store.products.push(
    { id: "p1", name: "Rice", aliases: [], unit: "kg", stockQty: 50, reorderLevel: 60, pricePaise: 6000 },
    { id: "p2", name: "Sugar", aliases: [], unit: "kg", stockQty: 20, reorderLevel: 5, pricePaise: 4500 },
  );
  return store;
}

describe("khataCard", () => {
  it("lists who owes, biggest first, with how long ago, and what is running low", async () => {
    const card = await khataCard(await shop(), "Sri Ganesh Stores", NOW);
    expect(card.total).toBe("₹1,150");
    expect(card.customers).toEqual([
      { name: "Fatima", owes: "₹700", owesPaise: 70000, hasPhone: true, lastCreditDaysAgo: 9, lastPaymentDaysAgo: 8 },
      { name: "Ramesh", owes: "₹450", owesPaise: 45000, hasPhone: true, lastCreditDaysAgo: 10, lastPaymentDaysAgo: null },
    ]);
    expect(card.lowStock).toEqual([{ name: "Rice", stock: "50 kg", alertAt: "60 kg" }]);
    expect(khataText(card)).toBe("Sri Ganesh Stores: ₹1,150 to collect from 2 customers.\n- Fatima: ₹700\n- Ramesh: ₹450\nRunning low: Rice 50 kg");
  });
});

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("the card over MCP", () => {
  it("links showKhata to its UI resource and serves the card as an MCP App", async () => {
    const store = await shop();
    const handler = createMcpHandler(() => createMunshiMcpServer({ store, shopName: "Sri Ganesh Stores" }));
    client = new Client({ name: "test-host", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://munshi.test/api/mcp"), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "showKhata");
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: KHATA_CARD_URI } });
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const { resources } = await client.listResources();
    expect(resources.find((r) => r.uri === KHATA_CARD_URI)).toBeTruthy();
    const { contents } = await client.readResource({ uri: KHATA_CARD_URI });
    const page = contents[0] as { mimeType?: string; text?: string };
    expect(page.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(page.text).toMatch(/^<!doctype html>/);
    expect(page.text).not.toMatch(/<script[^>]+src=/); // everything inline: hosts block outside scripts

    const result = await client.callTool({ name: "showKhata", arguments: {} });
    expect(result.structuredContent).toMatchObject({ shop: "Sri Ganesh Stores", total: "₹1,150" });
    expect(JSON.stringify(result.content)).toContain("Fatima: ₹700");
  });
});

describe("the bundled card", () => {
  it("matches its source; run `npm run build:mcp-app -w @munshi/web` after changing the view", async () => {
    const committed = await readFile(new URL("./khata-view.generated.ts", import.meta.url), "utf8");
    expect(committed).toBe(moduleSource(await bundleKhataView()));
  }, 30_000);
});
