import { formatINR, Language, rupeesToPaise } from "@munshi/db";
import { tool } from "ai";
import { z } from "zod";
import { paymentHabits } from "./habits";
import { rankByName } from "./match";
import type { Customer, KhataStore } from "./store";

const Rupees = z
  .number()
  .positive()
  .max(10_00_000)
  .describe("Amount in rupees, e.g. 450 or 129.50. Convert spoken numbers like 'saade chaar sau' to 450.");

type Resolved = { ok: true; customer: Customer } | { ok: false; result: Record<string, unknown> };
type Due = { ok: true; amountPaise: number } | { ok: false; result: Record<string, unknown> };

/** What to collect: the requested amount, or the full balance. Never more than the customer owes. */
async function amountDue(store: KhataStore, customer: Customer, amount?: number): Promise<Due> {
  const [balance] = await store.balances(customer.id);
  const outstanding = balance?.outstandingPaise ?? 0;
  const amountPaise = amount ? rupeesToPaise(amount) : outstanding;
  if (amountPaise <= 0) return { ok: false, result: { status: "nothing_due", customer: customer.name } };
  if (amountPaise > outstanding) {
    return { ok: false, result: { status: "exceeds_balance", customer: customer.name, owes: formatINR(outstanding), requested: formatINR(amountPaise) } };
  }
  return { ok: true, amountPaise };
}

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

export function createKhataTools(store: KhataStore, shopName = "your shop") {
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

        const due = await amountDue(store, r.customer, amount);
        if (!due.ok) return due.result;

        const link = await store.createPaymentLink({ customer: r.customer, amountPaise: due.amountPaise, purpose: `Udhaar payment to ${shopName}` });
        await store.audit("payment_link_sent", { customerId: r.customer.id, linkId: link.id, amountPaise: due.amountPaise });
        return {
          status: "sent",
          customer: r.customer.name,
          amount: formatINR(due.amountPaise),
          url: link.url,
          expiresAt: link.expiresAt,
          customerNotified: link.customerNotified,
        };
      },
    }),

    showPaymentQr: tool({
      description:
        "Show a UPI QR for a customer who is in the shop right now, for their udhaar. The owner shows it on their phone and the customer scans it; the payment is matched to this customer's khata. Omit amount for the full outstanding balance. For a customer who isn't in the shop, use sendPaymentLink.",
      inputSchema: z.object({ customerName: z.string(), amount: Rupees.optional() }),
      execute: async ({ customerName, amount }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const due = await amountDue(store, r.customer, amount);
        if (!due.ok) return due.result;

        try {
          const qr = await store.createPaymentQr({ customer: r.customer, amountPaise: due.amountPaise, purpose: `Udhaar payment to ${shopName}` });
          await store.audit("payment_qr_shown", { customerId: r.customer.id, qrId: qr.id, amountPaise: due.amountPaise });
          // Minutes, not a timestamp: the model read the UTC time out loud as if it were IST.
          const validForMinutes = Math.max(0, Math.round((Date.parse(qr.expiresAt) - Date.now()) / 60_000));
          return { status: "qr_ready", qrId: qr.id, customer: r.customer.name, amount: formatINR(due.amountPaise), validForMinutes };
        } catch {
          return { status: "qr_unavailable", customer: r.customer.name, hint: "The QR couldn't be created. Offer a payment link instead." };
        }
      },
    }),

    remember: tool({
      description:
        "Save a lasting fact the owner tells you: about a customer (pass customerName), like who they are or how they pay, or about the shop and how the owner likes things (omit customerName). Not for udhaar, payments or stock: those have their own tools.",
      inputSchema: z.object({
        fact: z
          .string()
          .min(3)
          .max(300)
          .describe(
            "The fact as one full English sentence about the owner in the third person, keeping every name and relation they said: 'Ramesh mere padosi Lakshmi ke pati hain' becomes \"Ramesh is the husband of Lakshmi, the owner's neighbour\". Never drop a word like neighbour: it changes who someone is.",
          ),
        customerName: z.string().optional(),
      }),
      execute: async ({ fact, customerName }) => {
        let customer: Customer | undefined;
        if (customerName) {
          const r = await resolveCustomer(store, customerName);
          if (!r.ok) return r.result;
          customer = r.customer;
        }
        // Saying the same thing twice shouldn't store it twice.
        const known = await store.memories(customer?.id ?? null);
        if (known.some((m) => m.fact.trim().toLowerCase() === fact.trim().toLowerCase())) return { status: "already_known", about: customer?.name ?? "the shop", fact };
        await store.remember({ fact: fact.trim(), customerId: customer?.id });
        return { status: "remembered", about: customer?.name ?? "the shop", fact: fact.trim() };
      },
    }),

    recall: tool({
      description:
        "What the owner asked you to remember about a customer (pass customerName) or about the shop (omit it). Each fact has an id, used only to forget it.",
      inputSchema: z.object({ customerName: z.string().optional() }),
      execute: async ({ customerName }) => {
        let customer: Customer | undefined;
        if (customerName) {
          const r = await resolveCustomer(store, customerName);
          if (!r.ok) return r.result;
          customer = r.customer;
        }
        const facts = await store.memories(customer?.id ?? null);
        return { status: "facts", about: customer?.name ?? "the shop", facts: facts.map((m) => ({ id: m.id, fact: m.fact })) };
      },
    }),

    forget: tool({
      description: "Forget one remembered fact, by the id that recall returned. Use when the owner says something is no longer true.",
      inputSchema: z.object({ memoryId: z.string() }),
      execute: async ({ memoryId }) => ((await store.forget(memoryId)) ? { status: "forgotten" } : { status: "not_found" }),
    }),

    paymentHabits: tool({
      description:
        "How a customer usually pays, worked out from their real payments: usual weekday, days between payments, average amount. Use for questions like 'Fatima kab deti hai?'. Never guess habits without it.",
      inputSchema: z.object({ customerName: z.string() }),
      execute: async ({ customerName }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const habits = paymentHabits(await store.recentEntries(200, r.customer.id));
        return habits.enough
          ? { status: "habits", customer: r.customer.name, ...habits }
          : { status: "not_enough_history", customer: r.customer.name, payments: habits.payments, hint: "Say there aren't enough payments yet to see a pattern." };
      },
    }),

    checkPayment: tool({
      description:
        "Check whether a customer's UPI link or QR has been paid, and update the khata if so. Use for 'X ka payment aaya?' or 'did X pay?'. Omit customerName to check everyone.",
      inputSchema: z.object({ customerName: z.string().optional() }),
      execute: async ({ customerName }) => {
        let customer: Customer | undefined;
        if (customerName) {
          const r = await resolveCustomer(store, customerName);
          if (!r.ok) return r.result;
          customer = r.customer;
        }
        const { paidPaise, stillOpen } = await store.checkPayments(customer?.id);
        const [balance] = customer ? await store.balances(customer.id) : [];
        return {
          status: paidPaise > 0 ? "payment_received" : "no_new_payment",
          customer: customer?.name,
          received: formatINR(paidPaise),
          stillWaitingOn: stillOpen,
          ...(balance ? { nowOwes: formatINR(balance.outstandingPaise) } : {}),
        };
      },
    }),
  };
}

export type KhataTools = ReturnType<typeof createKhataTools>;
