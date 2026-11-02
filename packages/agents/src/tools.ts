import { formatINR, Language, rupeesToPaise } from "@munshi/db";
import { tool } from "ai";
import { z } from "zod";
import { rankByName } from "./match";
import type { Customer, KhataStore } from "./store";

const Rupees = z
  .number()
  .positive()
  .max(10_00_000)
  .describe("Amount in rupees, e.g. 450 or 129.50. Convert spoken numbers like 'saade chaar sau' to 450.");

type Resolved = { ok: true; customer: Customer } | { ok: false; result: Record<string, unknown> };

async function resolveCustomer(store: KhataStore, name: string): Promise<Resolved> {
  const matches = rankByName(name, await store.listCustomers());
  const [best, second] = matches;
  if (!best) {
    return { ok: false, result: { status: "customer_not_found", name, hint: "Ask the owner whether to add them as a new customer." } };
  }
  // Two close candidates (e.g. "Ramesh" and "Ramesh K"): never guess with someone's money.
  if (second && best.score - second.score < 0.1 && best.score < 1) {
    return {
      ok: false,
      result: { status: "ambiguous_customer", name, candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which one they meant." },
    };
  }
  return { ok: true, customer: best.item };
}

export function createKhataTools(store: KhataStore) {
  return {
    findCustomer: tool({
      description: "Look up customers by a spoken or typed name, including nicknames and names in Indian scripts.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => {
        const matches = rankByName(name, await store.listCustomers()).slice(0, 5);
        return { matches: matches.map((m) => ({ id: m.item.id, name: m.item.name, phone: m.item.phone, score: Number(m.score.toFixed(2)) })) };
      },
    }),

    addCustomer: tool({
      description: "Add a new customer to the khata. Only call this after the owner confirms the person is new.",
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        phone: z.string().regex(/^\+?[0-9 ]{10,15}$/).optional().describe("Indian mobile number, if the owner gave one"),
        language: Language.optional(),
      }),
      execute: async (input) => {
        const customer = await store.addCustomer(input);
        await store.audit("customer_added", { customerId: customer.id, name: customer.name });
        return { status: "added", customer: { id: customer.id, name: customer.name } };
      },
    }),

    recordCredit: tool({
      description: "Record udhaar: the customer took goods now and will pay later. Increases what they owe.",
      inputSchema: z.object({ customerName: z.string(), amount: Rupees, note: z.string().max(200).optional().describe("What they took, e.g. 'rice and dal'") }),
      execute: async ({ customerName, amount, note }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const entry = await store.addLedgerEntry({ kind: "credit_given", amountPaise: rupeesToPaise(amount), customerId: r.customer.id, note });
        const [balance] = await store.balances(r.customer.id);
        return {
          status: "recorded",
          entryId: entry.id,
          customer: r.customer.name,
          amount: formatINR(entry.amountPaise),
          nowOwes: formatINR(balance?.outstandingPaise ?? entry.amountPaise),
        };
      },
    }),

    recordPayment: tool({
      description: "Record that a customer paid back some or all of their udhaar (cash or UPI received in person).",
      inputSchema: z.object({ customerName: z.string(), amount: Rupees, method: z.enum(["cash", "upi", "other"]).default("cash") }),
      execute: async ({ customerName, amount, method }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const entry = await store.addLedgerEntry({ kind: "payment_received", amountPaise: rupeesToPaise(amount), customerId: r.customer.id, note: method });
        const [balance] = await store.balances(r.customer.id);
        return { status: "recorded", entryId: entry.id, customer: r.customer.name, amount: formatINR(entry.amountPaise), nowOwes: formatINR(balance?.outstandingPaise ?? 0) };
      },
    }),

    recordSale: tool({
      description: "Record a cash or UPI sale that was paid in full (no credit), or a shop expense.",
      inputSchema: z.object({ kind: z.enum(["sale", "expense"]), amount: Rupees, note: z.string().max(200).optional() }),
      execute: async ({ kind, amount, note }) => {
        const entry = await store.addLedgerEntry({ kind, amountPaise: rupeesToPaise(amount), note });
        return { status: "recorded", entryId: entry.id, kind, amount: formatINR(entry.amountPaise) };
      },
    }),

    getBalances: tool({
      description: "Show who owes the shop money. Pass a name for one customer, or omit it for everyone with dues.",
      inputSchema: z.object({ customerName: z.string().optional() }),
      execute: async ({ customerName }) => {
        let customerId: string | undefined;
        if (customerName) {
          const r = await resolveCustomer(store, customerName);
          if (!r.ok) return r.result;
          customerId = r.customer.id;
        }
        const rows = (await store.balances(customerId)).filter((b) => customerId || b.outstandingPaise > 0);
        const total = rows.reduce((sum, b) => sum + b.outstandingPaise, 0);
        return {
          total: formatINR(total),
          customers: rows
            .sort((a, b) => b.outstandingPaise - a.outstandingPaise)
            .map((b) => ({ name: b.name, owes: formatINR(b.outstandingPaise), lastCreditAt: b.lastCreditAt, lastPaymentAt: b.lastPaymentAt })),
        };
      },
    }),

    getStock: tool({
      description: "Check stock levels. Pass a product name, or set lowOnly to list items at or below their reorder level.",
      inputSchema: z.object({ productName: z.string().optional(), lowOnly: z.boolean().default(false) }),
      execute: async ({ productName, lowOnly }) => {
        let products = await store.listProducts();
        if (productName) products = rankByName(productName, products).map((m) => m.item).slice(0, 3);
        if (lowOnly) products = products.filter((p) => p.reorderLevel !== null && p.stockQty <= p.reorderLevel);
        return {
          products: products.map((p) => ({
            name: p.name,
            stock: `${p.stockQty} ${p.unit}`,
            reorderAt: p.reorderLevel === null ? null : `${p.reorderLevel} ${p.unit}`,
            low: p.reorderLevel !== null && p.stockQty <= p.reorderLevel,
          })),
        };
      },
    }),

    updateStock: tool({
      description: "Add or remove stock: positive when goods arrive, negative when sold, spoiled or corrected.",
      inputSchema: z.object({
        productName: z.string(),
        change: z.number().refine((n) => n !== 0, "Change cannot be zero").describe("e.g. 20 for 20 packets received, -2 for 2 sold"),
        reason: z.enum(["purchase", "sale", "wastage", "correction"]),
      }),
      execute: async ({ productName, change, reason }) => {
        const [match] = rankByName(productName, await store.listProducts());
        if (!match) return { status: "product_not_found", productName };
        const product = await store.moveStock({ productId: match.item.id, delta: change, reason });
        return { status: "updated", product: product.name, stock: `${product.stockQty} ${product.unit}` };
      },
    }),

    sendPaymentLink: tool({
      description:
        "Send a customer a UPI payment link (via Cashfree) to collect their udhaar. Moves real money, so the owner must approve it first. Omit amount to request the full outstanding balance.",
      inputSchema: z.object({ customerName: z.string(), amount: Rupees.optional() }),
      execute: async ({ customerName, amount }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        if (!r.customer.phone) return { status: "missing_phone", customer: r.customer.name, hint: "Ask the owner for the customer's mobile number." };

        const [balance] = await store.balances(r.customer.id);
        const outstanding = balance?.outstandingPaise ?? 0;
        const amountPaise = amount ? rupeesToPaise(amount) : outstanding;
        if (amountPaise <= 0) return { status: "nothing_due", customer: r.customer.name };
        if (amountPaise > outstanding) {
          return { status: "exceeds_balance", customer: r.customer.name, owes: formatINR(outstanding), requested: formatINR(amountPaise) };
        }

        const link = await store.createPaymentLink({ customer: r.customer, amountPaise, purpose: `Udhaar payment to your shop` });
        await store.audit("payment_link_sent", { customerId: r.customer.id, linkId: link.id, amountPaise });
        return { status: "sent", customer: r.customer.name, amount: formatINR(amountPaise), url: link.url, expiresAt: link.expiresAt };
      },
    }),
  };
}

export type KhataTools = ReturnType<typeof createKhataTools>;
