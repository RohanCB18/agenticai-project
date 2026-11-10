import { formatINR, Language, rupeesToPaise } from "@munshi/db";
import { type ModelMessage, tool } from "ai";
import { z } from "zod";
import { paymentHabits } from "./habits";
import { ownerWasAskedAboutRepeat } from "./threads";
import { rankByName } from "./match";
import { rankProducts, tooClose } from "./staples";
import type { Customer, KhataStore } from "./store";
import { latestQuoteId, type QuoteRequestItem, readQuote, SupplierError, type SupplierAgent } from "./supplier";

const Rupees = z
  .number()
  .positive()
  .max(10_00_000)
  .describe("Amount in rupees, e.g. 450 or 129.50. Convert spoken numbers like 'saade chaar sau' to 450.");

type Resolved = { ok: true; customer: Customer } | { ok: false; result: Record<string, unknown> };
type Due = { ok: true; amountPaise: number } | { ok: false; result: Record<string, unknown> };

/**
 * What a customer owes, never below zero: money paid beyond the udhaar is an advance. Live, a
 * ₹200 payment on a ₹0 balance came back as "owes -₹200", and Munshi told the owner "baaki 0".
 */
function dues(outstandingPaise: number) {
  return outstandingPaise < 0 ? { nowOwes: formatINR(0), advance: formatINR(-outstandingPaise) } : { nowOwes: formatINR(outstandingPaise) };
}

const ConfirmedNew = z
  .boolean()
  .optional()
  .describe("Only after this tool returned possible_repeat and the owner then said it is a new entry. Ignored otherwise.");

// Repeats are checked against the ledger, not the chat. Live, the owner sent "Ramesh ne 200 diye"
// again after the first one was never saved; told to "never record the same entry twice", the
// model saw the earlier message and skipped it. Only the ledger knows what was really saved.
const REPEAT_WINDOW_MS = 15 * 60 * 1000;

/** The same entry for the same customer, saved in the last few minutes, if there is one. */
async function recentTwin(store: KhataStore, customer: Customer, kind: "credit_given" | "payment_received", amountPaise: number) {
  const now = Date.now();
  const twin = (await store.recentEntries(20, customer.id)).find(
    (entry) => entry.kind === kind && entry.amountPaise === amountPaise && now - Date.parse(entry.createdAt) < REPEAT_WINDOW_MS,
  );
  if (!twin) return null;
  const minutesAgo = Math.max(0, Math.round((now - Date.parse(twin.createdAt)) / 60_000));
  return {
    status: "possible_repeat",
    customer: customer.name,
    amount: formatINR(amountPaise),
    savedMinutesAgo: minutesAgo,
    hint: "The same entry was saved a few minutes ago. Ask the owner whether this is a new one. If they say yes, call again with confirmedNew: true.",
  };
}

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

export type KhataToolOptions = {
  /**
   * Whether `confirmedNew` on a possible repeat really comes from the owner. Munshi's own model once
   * set it unasked, so by default it only counts when the chat shows the question was asked and
   * answered. MCP hosts don't send the chat; they show each write call to the owner instead.
   */
  repeatConfirmed?: (messages: ModelMessage[], customer: string, amount: string) => boolean;
  /** The wholesaler to restock from (an A2A agent). Without one, the supplier tools say so. */
  supplier?: SupplierAgent;
};

const NO_SUPPLIER = { status: "no_supplier", hint: "Tell the owner no wholesaler is connected to Munshi yet." };

function supplierDown(name: string, error: unknown) {
  if (error instanceof SupplierError) return { status: error.code, supplier: name, message: error.message };
  return { status: "supplier_unavailable", supplier: name, hint: "The wholesaler's agent didn't answer. Tell the owner to try again in a few minutes." };
}

export function createKhataTools(store: KhataStore, shopName = "your shop", options: KhataToolOptions = {}) {
  const repeatConfirmed = options.repeatConfirmed ?? ownerWasAskedAboutRepeat;
  const { supplier } = options;
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
      inputSchema: z.object({
        customerName: z.string(),
        amount: Rupees,
        note: z.string().max(200).optional().describe("What they took, e.g. 'rice and dal'"),
        confirmedNew: ConfirmedNew,
      }),
      execute: async ({ customerName, amount, note, confirmedNew }, { messages }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        if (!(confirmedNew && repeatConfirmed(messages, r.customer.name, formatINR(rupeesToPaise(amount))))) {
          const twin = await recentTwin(store, r.customer, "credit_given", rupeesToPaise(amount));
          if (twin) return twin;
        }
        const entry = await store.addLedgerEntry({ kind: "credit_given", amountPaise: rupeesToPaise(amount), customerId: r.customer.id, note });
        const [balance] = await store.balances(r.customer.id);
        return {
          status: "recorded",
          entryId: entry.id,
          customer: r.customer.name,
          amount: formatINR(entry.amountPaise),
          ...dues(balance?.outstandingPaise ?? entry.amountPaise),
        };
      },
    }),

    recordPayment: tool({
      description: "Record that a customer paid back some or all of their udhaar (cash or UPI received in person).",
      inputSchema: z.object({ customerName: z.string(), amount: Rupees, method: z.enum(["cash", "upi", "other"]).default("cash"), confirmedNew: ConfirmedNew }),
      execute: async ({ customerName, amount, method, confirmedNew }, { messages }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        if (!(confirmedNew && repeatConfirmed(messages, r.customer.name, formatINR(rupeesToPaise(amount))))) {
          const twin = await recentTwin(store, r.customer, "payment_received", rupeesToPaise(amount));
          if (twin) return twin;
        }
        const entry = await store.addLedgerEntry({ kind: "payment_received", amountPaise: rupeesToPaise(amount), customerId: r.customer.id, note: method });
        const [balance] = await store.balances(r.customer.id);
        return { status: "recorded", entryId: entry.id, customer: r.customer.name, amount: formatINR(entry.amountPaise), ...dues(balance?.outstandingPaise ?? 0) };
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
        const total = rows.reduce((sum, b) => sum + Math.max(0, b.outstandingPaise), 0);
        return {
          total: formatINR(total),
          customers: rows
            .sort((a, b) => b.outstandingPaise - a.outstandingPaise)
            .map((b) => {
              const { nowOwes, ...advance } = dues(b.outstandingPaise);
              return { name: b.name, owes: nowOwes, ...advance, lastCreditAt: b.lastCreditAt, lastPaymentAt: b.lastPaymentAt };
            }),
        };
      },
    }),

    getStock: tool({
      description: "Check stock levels. Pass a product name, or set lowOnly to list items at or below their reorder level.",
      inputSchema: z.object({ productName: z.string().optional(), lowOnly: z.boolean().default(false) }),
      execute: async ({ productName, lowOnly }) => {
        let products = await store.listProducts();
        if (productName) products = rankProducts(productName, products).map((m) => m.item).slice(0, 3);
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
        const matches = rankProducts(productName, await store.listProducts());
        const [match] = matches;
        if (!match) return { status: "product_not_found", productName };
        // Two products that both fit ("Rice" and "Sona Masoori Rice" for "akki"): ask, don't pick.
        if (tooClose(matches)) return { status: "ambiguous_product", candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which product." };
        const product = await store.moveStock({ productId: match.item.id, delta: change, reason });
        return { status: "updated", product: product.name, stock: `${product.stockQty} ${product.unit}` };
      },
    }),

    setReorderLevel: tool({
      description:
        "Set the stock level at which a product counts as running low, e.g. 'Rice 10 kg pe alert karna' is 10. Use 0 to remove the alert. Low products show in getStock and are what askSupplierQuote restocks.",
      inputSchema: z.object({ productName: z.string(), level: z.number().min(0).describe("In the product's own unit; 0 removes the alert") }),
      execute: async ({ productName, level }) => {
        const matches = rankProducts(productName, await store.listProducts());
        const [match] = matches;
        if (!match) return { status: "product_not_found", productName };
        if (tooClose(matches)) return { status: "ambiguous_product", candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which product." };
        const product = await store.setReorderLevel(match.item.id, level > 0 ? level : null);
        return {
          status: "alert_set",
          product: product.name,
          alertAt: product.reorderLevel === null ? null : `${product.reorderLevel} ${product.unit}`,
          stock: `${product.stockQty} ${product.unit}`,
          low: product.reorderLevel !== null && product.stockQty <= product.reorderLevel,
        };
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

    askSupplierQuote: tool({
      description:
        "Ask the wholesaler's agent for a price quote to restock. Omit items to quote everything below its reorder level. The wholesaler prices it; never state a price it didn't give.",
      inputSchema: z.object({
        items: z
          .array(z.object({ productName: z.string().min(1), quantity: z.number().positive().describe("In the product's own unit, e.g. kg or packets") }))
          .optional()
          .describe("What the owner wants to order. Omit to restock everything that is running low."),
      }),
      execute: async ({ items }) => {
        if (!supplier) return NO_SUPPLIER;
        const products = await store.listProducts();
        let wanted: QuoteRequestItem[];
        if (items?.length) {
          wanted = items.map(({ productName, quantity }) => {
            const [match] = rankProducts(productName, products);
            return match ? { name: match.item.name, quantity, unit: match.item.unit } : { name: productName, quantity };
          });
        } else {
          // Top up what's low to twice its reorder level, so it isn't low again next week.
          wanted = products
            .filter((p) => p.reorderLevel !== null && p.stockQty <= p.reorderLevel)
            .map((p) => ({ name: p.name, quantity: Math.max(p.reorderLevel! * 2 - p.stockQty, 1), unit: p.unit }));
          if (wanted.length === 0) return { status: "nothing_low", hint: "Nothing is below its reorder level. Ask the owner what to order." };
        }
        try {
          const quote = await supplier.quote(wanted, shopName);
          return {
            status: quote.quoteId ? "quoted" : "nothing_quoted",
            supplier: quote.supplier,
            lines: quote.lines.map((l) => ({ item: l.item, quantity: `${l.quantity} ${l.unit}`, amount: l.amount, ...(l.note ? { note: l.note } : {}) })),
            unavailable: quote.unavailable,
            total: quote.total,
            discount: quote.discount,
            deliverySlot: quote.deliverySlot,
            payment: quote.payment,
            ...(quote.meetsMinimum ? {} : { belowMinimum: `${quote.supplier} takes orders from ${quote.minimumOrder}` }),
            quoteId: quote.quoteId,
            hint: "Tell the owner the items, total and delivery, and ask whether to order. Only if they say yes, call placeSupplierOrder.",
          };
        } catch (error) {
          return supplierDown(supplier.name, error);
        }
      },
    }),

    placeSupplierOrder: tool({
      description:
        "Order the latest quote from the wholesaler, after the owner said yes to it. The owner also approves it with a button before it is sent.",
      inputSchema: z.object({}),
      execute: async (_input, { messages }) => {
        if (!supplier) return NO_SUPPLIER;
        // The quote id is a long signed token: taken from the conversation, never retyped by the model.
        const quoteId = latestQuoteId(messages);
        if (!quoteId) return { status: "no_quote", hint: "Get a quote with askSupplierQuote first." };
        if ((readQuote(quoteId)?.expiresAt ?? new Date(0)) < new Date()) return { status: "quote_expired", hint: "The quote has expired. Get a fresh one." };
        try {
          const order = await supplier.order(quoteId);
          await store.saveSupplierOrder({ ...order, quoteId });
          return {
            status: "ordered",
            supplier: order.supplier,
            orderId: order.orderId,
            total: order.total,
            deliverySlot: order.deliverySlot,
            payment: order.payment,
            hint: "When the goods arrive, the owner can send a photo of the bill to add them to stock.",
          };
        } catch (error) {
          return supplierDown(supplier.name, error);
        }
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
          ...(balance ? dues(balance.outstandingPaise) : {}),
        };
      },
    }),
  };
}

export type KhataTools = ReturnType<typeof createKhataTools>;
