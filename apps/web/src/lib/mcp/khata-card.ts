import type { KhataStore } from "@munshi/agents";
import { formatINR } from "@munshi/db";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { KhataCard } from "@/mcp-app/khata-view";
import { KHATA_VIEW_HTML } from "./khata-view.generated";

// MCP Apps: the showKhata tool comes with an interactive card (src/mcp-app/khata-view.ts) that
// hosts like Claude render inline. Hosts without MCP Apps get the same data as text.

export const KHATA_CARD_URI = "ui://munshi/khata.html";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (iso: string | null, now: Date) => (iso ? Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS)) : null);

/** Who owes what (biggest first) and what is running low, for the card. */
export async function khataCard(store: KhataStore, shopName: string, now = new Date()): Promise<KhataCard> {
  const [balances, customers, products] = await Promise.all([store.balances(), store.listCustomers(), store.listProducts()]);
  const phone = new Map(customers.map((c) => [c.id, Boolean(c.phone)]));
  const owing = balances.filter((b) => b.outstandingPaise > 0).sort((a, b) => b.outstandingPaise - a.outstandingPaise);
  return {
    shop: shopName,
    total: formatINR(owing.reduce((sum, b) => sum + b.outstandingPaise, 0)),
    customers: owing.map((b) => ({
      name: b.name,
      owes: formatINR(b.outstandingPaise),
      owesPaise: b.outstandingPaise,
      hasPhone: phone.get(b.customerId) ?? false,
      lastCreditDaysAgo: daysAgo(b.lastCreditAt, now),
      lastPaymentDaysAgo: daysAgo(b.lastPaymentAt, now),
    })),
    lowStock: products
      .filter((p) => p.reorderLevel !== null && p.stockQty <= p.reorderLevel)
      .map((p) => ({ name: p.name, stock: `${p.stockQty} ${p.unit}`, alertAt: `${p.reorderLevel} ${p.unit}` })),
  };
}

/** The same card as plain text, for hosts that don't render MCP Apps and for the model itself. */
export function khataText(card: KhataCard) {
  const lines = card.customers.map((c) => `- ${c.name}: ${c.owes}${c.hasPhone ? "" : " (no phone)"}`);
  const low = card.lowStock.length ? `\nRunning low: ${card.lowStock.map((p) => `${p.name} ${p.stock}`).join(", ")}` : "";
  return `${card.shop}: ${card.total} to collect from ${card.customers.length} customers.\n${lines.join("\n")}${low}`;
}

export function registerKhataCard(server: McpServer, store: KhataStore, shopName: string) {
  registerAppResource(server, "Khata card", KHATA_CARD_URI, { description: "Who owes the shop money, with a button to send each one a UPI payment link." }, async () => ({
    contents: [{ uri: KHATA_CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: KHATA_VIEW_HTML, _meta: { ui: { prefersBorder: true } } }],
  }));

  registerAppTool(
    server,
    "showKhata",
    {
      title: "Khata card",
      description:
        "Show the shop's khata as an interactive card: everyone who owes money, biggest first, with a button to send each a UPI payment link, and what is running low. Use when the owner asks who owes money or wants an overview.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: KHATA_CARD_URI } },
    },
    async () => {
      const card = await khataCard(store, shopName);
      return { content: [{ type: "text" as const, text: khataText(card) }], structuredContent: card };
    },
  );
}
