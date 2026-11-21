import { formatINR, Language, rupeesToPaise } from "@munshi/db";
import { type ModelMessage, tool } from "ai";
import { z } from "zod";
import {
  CHART_CODE_GUIDE,
  CHART_PERIODS,
  CHART_TOPICS,
  type ChartRunner,
  chartFiles,
  chartTotals,
  chartWindow,
  NOTHING_TO_CHART,
  nothingToChart,
  salesChartSkipsUdhaar,
} from "./charts";
import { paymentHabits } from "./habits";
import { coversHsn, type GstPassage, gstCitation, type KnowledgeBase, officialHsn, officialRates, sameGoods } from "./knowledge";
import { ownerWasAskedAboutRepeat } from "./threads";
import { rankByName } from "./match";
import { rankProducts, tooClose } from "./staples";
import type { Customer, KhataStore, Product, Supplier } from "./store";
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

const Phone = z
  .string()
  .regex(/^\+?[0-9 ]{10,15}$/)
  .describe("Indian mobile number, as the owner gave it");

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
  /** Reference knowledge (official GST rates). Without it, lookupGst says so. */
  knowledge?: KnowledgeBase;
  /** Runs chart programs in a sandbox. Without it, makeChart says charts are off. */
  charts?: ChartRunner;
  /** Starts a lookup on the official GST portal in the background (a browser in a sandbox). */
  portal?: { start(question: string): Promise<void | "no_inbox"> };
};

const LEDGER_LABELS: Record<string, string> = { credit_given: "udhaar", payment_received: "payment" };

/** The entries an owner can correct, by the words the agent uses. */
const CORRECTABLE = { udhaar: "credit_given", payment: "payment_received", sale: "sale", expense: "expense" } as const;

/** "12 Oct 2026" in India time: the day the owner would say, not the UTC one. */
const indianDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });

/** One GST entry for the model: the total rate, the official text it comes from, and where to read it. */
function gstEntry(p: GstPassage) {
  return {
    item: p.description,
    hsn: p.hsn,
    ...(p.gst === null ? {} : { gst: p.gst === 0 ? "0% (exempt)" : `${p.gst}%` }),
    citation: gstCitation(p),
    officialText: p.content,
    sources: p.sources.map((s) => ({ notification: s.title, inForceFrom: s.effectiveFrom, url: s.url })),
  };
}

// Where a supplier's account comes from: only the owner, in the dashboard. Said whenever one is missing.
const ADD_ACCOUNT_HINT =
  "Munshi can't add or change where money goes. Tell the owner to add the supplier's UPI ID or bank account in Munshi's dashboard (Suppliers), confirm it with the supplier, and then ask again.";

type ResolvedSupplier = { ok: true; supplier: Supplier } | { ok: false; result: Record<string, unknown> };

async function resolveSupplier(store: KhataStore, name: string): Promise<ResolvedSupplier> {
  const matches = rankByName(name, await store.listSuppliers());
  const [best, second] = matches;
  if (!best) return { ok: false, result: { status: "no_payout_account", supplier: name, hint: ADD_ACCOUNT_HINT } };
  if (second && best.score - second.score < 0.1 && best.score < 1) {
    return { ok: false, result: { status: "ambiguous_supplier", name, candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which one they meant." } };
  }
  return { ok: true, supplier: best.item };
}

const NO_SUPPLIER = { status: "no_supplier", hint: "Tell the owner no wholesaler is connected to Munshi yet." };

const HSN_CODE = /^\d{4}(\s?\d{2}){0,2}$/;

type GstOption = { gst: string; gstRate: number; item: string | null; citation: string | null };
type BulkTagOutcome =
  | { kind: "tagged"; product: string; hsn: string; gst: string; citation: string | null }
  | { kind: "choose_rate"; product: string; hsn: string; options: GstOption[] }
  | { kind: "unconfirmed"; product: string; hsn: string; goods: string; officialFor: { hsn: string | null; item: string | null }[] }
  | { kind: "already_tagged"; product: string }
  | { kind: "not_found"; productName: string }
  | { kind: "unavailable"; product: string };

/**
 * One product of tagAllProducts. The model gives a code and what the goods are; the code counts
 * only if a top official entry for those goods carries it (live, a search for the bare name "Parle
 * G" found plastic scrap, and "Toor dal" found jaggery). The rate comes from that entry and its
 * loose or packed twin; if those differ, the owner chooses.
 */
async function tagOneProduct(store: KhataStore, knowledge: KnowledgeBase, products: Product[], item: { productName: string; hsn: string; goods: string }): Promise<BulkTagOutcome> {
  const matches = rankProducts(item.productName, products);
  const [match] = matches;
  if (!match || tooClose(matches)) return { kind: "not_found", productName: item.productName };
  const product = match.item.name;
  // A code with no rate yet (a bill gave the code, the official entries differ) still needs one.
  if (match.item.hsn && match.item.gstRate != null) return { kind: "already_tagged", product };

  const code = item.hsn.replace(/\s/g, "");
  let found: GstPassage[];
  let byName: GstPassage[];
  let forCode: GstPassage[];
  try {
    [found, byName, forCode] = await Promise.all([
      knowledge.searchGst(item.goods, 8),
      knowledge.searchGst(`${product} ${item.goods}`, 8),
      knowledge.searchGst(`${code} ${item.goods}`, 10),
    ]);
  } catch (error) {
    console.error("[munshi] GST lookup failed:", error instanceof Error ? error.message : error);
    return { kind: "unavailable", product };
  }
  // The best official entry for the goods must carry the code. Live, with any of the top five
  // allowed, "pulses split" confirmed 1106 (dal flour) for toor dal. The goods are also searched
  // with the product's own name: live, "vegetable oil" alone missed sunflower oil (1512).
  const confirmed = [found, byName]
    .map((list) => list.find((entry) => entry.gst !== null))
    .find((top) => top !== undefined && coversHsn(top, code));
  if (!confirmed) {
    return { kind: "unconfirmed", product, hsn: code, goods: item.goods, officialFor: found.slice(0, 3).map((e) => ({ hsn: e.hsn, item: e.description })) };
  }
  const seen = new Set<string>();
  const twins = [confirmed, ...found, ...byName, ...forCode].filter((e) => !seen.has(e.id) && (seen.add(e.id), coversHsn(e, code) && sameGoods(e, confirmed)));
  const rates = officialRates(twins);
  const kept = officialHsn(twins, code); // no sub-code finer than the notification lists
  if (rates.length > 1) {
    return { kind: "choose_rate", product, hsn: kept, options: rates.map((r) => ({ gst: `${r.rate}%`, gstRate: r.rate, item: r.item, citation: r.citation })) };
  }
  const [rate] = rates;
  const saved = await store.setProductGst(match.item.id, { hsn: kept, gstRate: rate!.rate, citation: rate!.citation });
  return { kind: "tagged", product: saved.name, hsn: kept, gst: `${rate!.rate}%`, citation: rate!.citation };
}

function supplierDown(name: string, error: unknown) {
  if (error instanceof SupplierError) return { status: error.code, supplier: name, message: error.message };
  console.error("[munshi] wholesaler agent call failed:", error instanceof Error ? error.message : error);
  return { status: "supplier_unavailable", supplier: name, hint: "The wholesaler's agent didn't answer. Tell the owner to try again in a few minutes." };
}

export function createKhataTools(store: KhataStore, shopName = "your shop", options: KhataToolOptions = {}) {
  const repeatConfirmed = options.repeatConfirmed ?? ownerWasAskedAboutRepeat;
  const { supplier, knowledge, charts, portal } = options;
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
        phone: Phone.optional(),
        language: Language.optional(),
      }),
      execute: async (input) => {
        const customer = await store.addCustomer(input);
        await store.audit("customer_added", { customerId: customer.id, name: customer.name });
        return { status: "added", customer: { id: customer.id, name: customer.name } };
      },
    }),

    updateCustomer: tool({
      description:
        "Change an existing customer's details: add or correct their mobile number, or fix the spelling of their name. Use when the owner gives a number for someone already in the khata, e.g. before sending a payment link.",
      inputSchema: z.object({
        customerName: z.string().describe("The customer as the khata knows them now"),
        phone: Phone.optional(),
        newName: z.string().min(1).max(120).optional().describe("Only if the owner wants the name itself changed"),
      }),
      execute: async ({ customerName, phone, newName }) => {
        if (!phone && !newName) return { status: "nothing_to_change", hint: "Ask the owner what to change: the mobile number or the name." };
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const before = { ...r.customer };
        const name = newName?.trim();
        const renamed = Boolean(name) && name !== before.name;
        // The old name stays an alias, so "Ramesh" still finds "Ramesh Kumar" after a rename.
        const aliases = renamed && !before.aliases.includes(before.name) ? [...before.aliases, before.name] : undefined;
        const customer = await store.updateCustomer(before.id, {
          ...(phone ? { phone: phone.replace(/\s+/g, "") } : {}),
          ...(renamed ? { name, aliases } : {}),
        });
        await store.audit("customer_updated", {
          customerId: customer.id,
          ...(phone ? { phoneChanged: before.phone !== customer.phone } : {}),
          ...(renamed ? { from: before.name, to: customer.name } : {}),
        });
        return {
          status: "updated",
          customer: customer.name,
          ...(renamed ? { previousName: before.name } : {}),
          phone: customer.phone,
          ...(phone && before.phone && before.phone !== customer.phone ? { previousPhone: before.phone } : {}),
        };
      },
    }),

    customerHistory: tool({
      description:
        "A customer's khata over the last few days: each udhaar with what they took (when it was noted) and each payment, with totals. Use for 'Ramesh ne pichhle mahine kya liya?', 'Fatima ne is hafte kitna diya?' or 'when did Suresh last pay?'.",
      inputSchema: z.object({
        customerName: z.string(),
        days: z.number().int().min(1).max(366).default(30).describe("How far back to look: 7 for a week, 30 for a month, 365 for a year"),
      }),
      execute: async ({ customerName, days }) => {
        const r = await resolveCustomer(store, customerName);
        if (!r.ok) return r.result;
        const LIMIT = 200;
        const SHOWN = 25;
        const recent = await store.recentEntries(LIMIT, r.customer.id);
        const since = Date.now() - days * 86_400_000;
        const entries = recent.filter((e) => Date.parse(e.createdAt) >= since);
        const total = (kind: string) => entries.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.amountPaise, 0);
        const [balance] = await store.balances(r.customer.id);
        return {
          status: "history",
          customer: r.customer.name,
          days,
          tookOnCredit: formatINR(total("credit_given")),
          paid: formatINR(total("payment_received")),
          ...dues(balance?.outstandingPaise ?? 0),
          // Newest first, as the owner would read their khata back.
          entries: entries.slice(0, SHOWN).map((e) => ({
            date: indianDate(e.createdAt),
            type: LEDGER_LABELS[e.kind] ?? e.kind,
            amount: formatINR(e.amountPaise),
            ...(e.note ? { note: e.note } : {}),
          })),
          ...(entries.length > SHOWN ? { olderEntriesNotShown: entries.length - SHOWN } : {}),
          // Every entry read was inside the window, so there may be more before them.
          ...(entries.length === LIMIT ? { mayHaveMore: true } : {}),
          ...(entries.length === 0 ? { hint: `Nothing in the khata for ${r.customer.name} in the last ${days} days.` } : {}),
        };
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

    correctEntry: tool({
      description:
        "Fix an entry the owner says was wrong: change its amount ('bijli ka bill 800 nahi 600 tha', 'Ramesh ka 450 galat likha, 400 tha') or remove it ('last wala hata do', rightAmount 0). Finds the latest matching entry of the last 7 days. Never record a new entry to fix a wrong one.",
      inputSchema: z.object({
        kind: z.enum(["udhaar", "payment", "sale", "expense"]),
        customerName: z.string().optional().describe("For udhaar and payments"),
        wrongAmount: Rupees.optional().describe("The amount as it was recorded, if the owner said it"),
        rightAmount: z.number().min(0).max(10_00_000).describe("The correct amount in rupees; 0 removes the entry"),
      }),
      execute: async ({ kind, customerName, wrongAmount, rightAmount }) => {
        const ledgerKind = CORRECTABLE[kind];
        let customer: Customer | undefined;
        if (kind === "udhaar" || kind === "payment") {
          if (!customerName) return { status: "need_customer", hint: "Ask the owner whose entry it was." };
          const r = await resolveCustomer(store, customerName);
          if (!r.ok) return r.result;
          customer = r.customer;
        }
        const since = Date.now() - 7 * 86_400_000;
        const wrongPaise = wrongAmount === undefined ? undefined : rupeesToPaise(wrongAmount);
        const entry = (await store.recentEntries(200, customer?.id)).find(
          (e) => e.kind === ledgerKind && Date.parse(e.createdAt) >= since && (wrongPaise === undefined || e.amountPaise === wrongPaise),
        );
        const what = `${kind === "udhaar" ? "Udhaar" : kind[0]!.toUpperCase() + kind.slice(1)}${customer ? ` ${customer.name}` : ""}`;
        if (!entry) {
          return {
            status: "entry_not_found",
            entry: what,
            hint: "No such entry in the last 7 days: nothing was changed. Tell the owner, and ask which entry they mean.",
          };
        }
        // Money Cashfree reported, or Munshi paid out, is what the bank says: not the owner's to rewrite.
        if (entry.source === "webhook" || entry.source === "system") {
          return { status: "not_editable", entry: what, hint: "This entry came from Cashfree (an online payment or payout) and can't be changed. Nothing was changed." };
        }
        const rightPaise = rupeesToPaise(rightAmount);
        if (rightPaise === entry.amountPaise) return { status: "unchanged", entry: what, amount: formatINR(rightPaise), hint: "It already says this amount: nothing was changed." };

        const was = formatINR(entry.amountPaise); // read before the change
        await store.correctLedgerEntry(entry.id, rightPaise > 0 ? rightPaise : null);
        const balance = customer ? (await store.balances(customer.id))[0] : undefined;
        return {
          status: rightPaise > 0 ? "corrected" : "removed",
          entry: what,
          was,
          ...(rightPaise > 0 ? { now: formatINR(rightPaise) } : {}),
          recordedOn: indianDate(entry.createdAt),
          ...(balance ? dues(balance.outstandingPaise) : {}),
        };
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
            // The product's GST tag, when it has one ("not tagged" otherwise: setProductGst sets it).
            gst: p.hsn ? { hsn: p.hsn, rate: p.gstRate == null ? "not chosen yet" : `${p.gstRate}%` } : "not tagged",
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
        if (!match) {
          // Live, a new shop's "20 packet Maggi aaye" ended at "is its name something else?": nothing could add it.
          return {
            status: "product_not_found",
            productName,
            hint: "No product by this name. If it's new to the shop, call addProduct with its unit and this quantity as its stock (that records it, don't also call updateStock). If they may mean another product, ask which.",
          };
        }
        // Two products that both fit ("Rice" and "Sona Masoori Rice" for "akki"): ask, don't pick.
        if (tooClose(matches)) return { status: "ambiguous_product", candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which product." };
        const product = await store.moveStock({ productId: match.item.id, delta: change, reason });
        return { status: "updated", product: product.name, stock: `${product.stockQty} ${product.unit}` };
      },
    }),

    addProduct: tool({
      description:
        "Add a product the shop doesn't have in Munshi yet ('Maggi naya product hai', or 20 packets of something updateStock didn't find). Give its unit and, if the owner said, how much is in stock now.",
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe("The product's name as the owner says it, e.g. Maggi or Toor dal"),
        unit: z.string().min(1).max(12).describe("kg, g, ltr, ml, pkt, pcs, box, bag, dozen..."),
        stock: z.number().min(0).max(1_000_000).optional().describe("How much is in stock now, if the owner said"),
      }),
      execute: async ({ name, unit, stock }) => {
        const [match] = rankProducts(name, await store.listProducts(), 0.85);
        if (match) {
          return {
            status: "already_exists",
            product: match.item.name,
            stock: `${match.item.stockQty} ${match.item.unit}`,
            hint: "This product is already in Munshi: nothing was added. For stock that arrived, use updateStock.",
          };
        }
        let product = await store.addProduct({ name: name.trim(), unit: unit.trim() });
        if (stock) product = await store.moveStock({ productId: product.id, delta: stock, reason: "purchase" });
        return { status: "added", product: product.name, stock: `${product.stockQty} ${product.unit}` };
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

    setProductGst: tool({
      description:
        "Tag a product with its HSN code and GST rate, the base for GST bills. Take the HSN code from lookupGst's entries or the supplier's bill. The rate always comes from the official entries for that code, never from you: if they allow more than one (often loose vs pre-packaged and labelled), the tool lists them; ask the owner which fits and call again with gstRate.",
      inputSchema: z.object({
        productName: z.string(),
        hsn: z.string().regex(HSN_CODE, "4, 6 or 8 digits").describe("HSN code, e.g. 1902 or 0713 10 00"),
        gstRate: z.number().min(0).max(40).optional().describe("Only after the owner chose between the official rates the tool listed"),
      }),
      execute: async ({ productName, hsn, gstRate }) => {
        if (!knowledge) return { status: "no_knowledge", hint: "Tell the owner GST lookups aren't set up in Munshi yet." };
        const matches = rankProducts(productName, await store.listProducts());
        const [match] = matches;
        if (!match) return { status: "product_not_found", productName };
        if (tooClose(matches)) return { status: "ambiguous_product", candidates: matches.slice(0, 3).map((m) => m.item.name), hint: "Ask the owner which product." };

        let code = hsn.replace(/\s/g, "");
        let entries: GstPassage[];
        try {
          entries = await knowledge.searchGst(`${code} ${match.item.name}`, 10);
        } catch (error) {
          console.error("[munshi] GST lookup failed:", error instanceof Error ? error.message : error);
          return { status: "knowledge_unavailable", hint: "The GST lookup didn't answer. Tell the owner to try again in a minute." };
        }
        const covering = entries.filter((entry) => coversHsn(entry, code));
        const rates = officialRates(covering);
        const options = rates.map((r) => ({ gst: `${r.rate}%`, gstRate: r.rate, item: r.item, citation: r.citation }));
        if (rates.length === 0) {
          return { status: "not_found", hsn: code, hint: "No official entry has this HSN code. Check it with lookupGst or the supplier's bill. Nothing was saved." };
        }
        code = officialHsn(covering, code); // no sub-code finer than the notification lists
        const chosen = gstRate === undefined ? (rates.length === 1 ? rates[0] : undefined) : rates.find((r) => Math.abs(r.rate - gstRate) < 0.001);
        if (gstRate !== undefined && !chosen) {
          return { status: "rate_not_official", product: match.item.name, hsn: code, options, hint: "That rate isn't an official rate for this code. Nothing was saved. Use one of these." };
        }
        if (!chosen) {
          return {
            status: "choose_rate",
            product: match.item.name,
            hsn: code,
            options,
            hint: "The official rate depends on the goods. Nothing was saved yet. Ask the owner which description fits (often loose or pre-packaged and labelled), then call again with that gstRate.",
          };
        }
        const product = await store.setProductGst(match.item.id, { hsn: code, gstRate: chosen.rate, citation: chosen.citation });
        return { status: "tagged", product: product.name, hsn: code, gst: `${chosen.rate}%`, citation: chosen.citation };
      },
    }),

    tagAllProducts: tool({
      description:
        "Tag every product that has no HSN code yet, in one go ('baaki sab ka HSN laga do', 'saare products ka GST tag karo'). Call it with no products first: it lists the untagged ones. Then call it again with each of them: its usual HSN code and a generic English description of the goods (as for lookupGst: Parle-G is 'biscuits', toor dal is 'pulses, split'). A product is tagged only when the official entries found for that description carry that code, and the rate always comes from those entries. Where loose and packed goods differ, it tags nothing and lists the options to ask the owner about.",
      inputSchema: z.object({
        products: z
          .array(
            z.object({
              productName: z.string(),
              hsn: z.string().regex(HSN_CODE, "4, 6 or 8 digits").describe("The product's usual HSN code, e.g. 1701"),
              goods: z.string().min(2).max(200).describe("Generic English description of the goods"),
            }),
          )
          .max(25)
          .default([]),
      }),
      execute: async ({ products: asked }) => {
        const all = await store.listProducts();
        // Live, a bill left Parle-G, sugar and toor dal with a code and no rate, and nothing could finish them.
        const untagged = all.filter((p) => !p.hsn || p.gstRate == null);
        if (all.length === 0) {
          // Live, a new shop with no products was told "every product is tagged".
          return { status: "no_products", hint: "Tell the owner Munshi has no products for this shop yet, so there is nothing to tag. They can add one: 'Maggi naya product hai, 20 packet'." };
        }
        if (!knowledge) return { status: "no_knowledge", hint: "Tell the owner GST lookups aren't set up in Munshi yet." };
        if (asked.length === 0) {
          if (untagged.length === 0) return { status: "all_tagged", hint: "Tell the owner every product already has its HSN code and GST rate." };
          return {
            status: "untagged_products",
            products: untagged.map((p) => p.name),
            ...(untagged.some((p) => p.hsn) ? { codeButNoRate: untagged.filter((p) => p.hsn).map((p) => ({ product: p.name, hsn: p.hsn })) } : {}),
            hint: "Nothing is tagged yet. Call tagAllProducts again with every one of these: its usual HSN code (for codeButNoRate, the code it already has) and a generic English description of the goods.",
          };
        }

        const outcomes: BulkTagOutcome[] = [];
        for (let i = 0; i < asked.length; i += 4) {
          outcomes.push(...(await Promise.all(asked.slice(i, i + 4).map((item) => tagOneProduct(store, knowledge, all, item)))));
        }
        const of = <K extends BulkTagOutcome["kind"]>(kind: K) => outcomes.filter((o): o is Extract<BulkTagOutcome, { kind: K }> => o.kind === kind);
        const tagged = of("tagged").map(({ kind: _, ...o }) => o);
        const chooseRate = of("choose_rate").map(({ kind: _, ...o }) => o);
        const unconfirmed = of("unconfirmed").map(({ kind: _, ...o }) => o);
        const handled = new Set(outcomes.flatMap((o) => ("product" in o ? [o.product] : [])));
        const left = untagged.map((p) => p.name).filter((name) => !handled.has(name));
        if (of("unavailable").length === outcomes.length) {
          return { status: "knowledge_unavailable", hint: "The GST lookup didn't answer. Tell the owner to try again in a minute. Nothing was saved." };
        }
        return {
          status: tagged.length ? "tagged" : "nothing_tagged",
          tagged,
          chooseRate,
          unconfirmed,
          alreadyTagged: of("already_tagged").map((o) => o.product),
          notFound: of("not_found").map((o) => o.productName),
          lookupFailed: of("unavailable").map((o) => o.product),
          notInYourList: left,
          hint: [
            "Tell the owner briefly what was tagged (the receipt under your reply lists each one; say only the products in tagged were tagged).",
            chooseRate.length ? "For each product in chooseRate, ask which description fits (usually loose or pre-packaged and labelled); on the answer, call setProductGst with its hsn and the chosen gstRate." : "",
            unconfirmed.length
              ? "For each product in unconfirmed, the best official entry for that description has another code: nothing was saved. officialFor lists what the entries say; if the first one is that product, call tagAllProducts again with its code, otherwise tell the owner you weren't sure of it."
              : "",
            left.length ? "notInYourList are still untagged: call tagAllProducts again for them." : "",
            of("unavailable").length ? "For lookupFailed the GST lookup didn't answer: tell the owner to ask again in a minute." : "",
          ]
            .filter(Boolean)
            .join(" "),
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
        if (!r.customer.phone) {
          return {
            status: "missing_phone",
            customer: r.customer.name,
            hint: "Ask the owner for the customer's mobile number, save it with updateCustomer, then send the link.",
          };
        }

        const due = await amountDue(store, r.customer, amount);
        if (!due.ok) return due.result;

        let link;
        try {
          link = await store.createPaymentLink({ customer: r.customer, amountPaise: due.amountPaise, purpose: `Udhaar payment to ${shopName}` });
        } catch (error) {
          // Cashfree down or slow: say so, rather than a run that errors with nothing for the owner.
          console.error("[munshi] payment link failed:", error instanceof Error ? error.message : error);
          return {
            status: "link_failed",
            customer: r.customer.name,
            hint: "The payment link was NOT created (the payment service didn't respond). Tell the owner it wasn't sent and to try again in a few minutes.",
          };
        }
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
        let order;
        try {
          order = await supplier.order(quoteId);
        } catch (error) {
          return supplierDown(supplier.name, error);
        }
        const placed = {
          status: "ordered",
          supplier: order.supplier,
          orderId: order.orderId,
          total: order.total,
          deliverySlot: order.deliverySlot,
          payment: order.payment,
        };
        // The wholesaler has the order now. A failure to keep our copy must not read as "not ordered":
        // live, a missing table made a confirmed order look like the wholesaler never answered.
        try {
          await store.saveSupplierOrder({ ...order, quoteId });
        } catch (error) {
          console.error("[munshi] supplier order placed but not saved:", error instanceof Error ? error.message : error);
          return { ...placed, notSaved: true, hint: `The order is placed with ${order.supplier}, but Munshi couldn't keep a copy. Give the owner the order id.` };
        }
        return { ...placed, hint: "When the goods arrive, the owner can send a photo of the bill to add them to stock." };
      },
    }),

    lookupGst: tool({
      description:
        "Look up the GST rate on goods in the official GST rate notifications (rates in force from 22 September 2025), with the notification and serial number to cite. Search with a generic English description, not a brand: Maggi is 'instant noodles', atta is 'wheat flour', Surf is 'washing powder detergent', Parle-G is 'biscuits', a cold drink like Coke is 'aerated drink with added sugar'. Add 'packed' or 'loose' if the owner said so.",
      inputSchema: z.object({ item: z.string().min(2).max(200).describe("Generic English description of the goods") }),
      execute: async ({ item }) => {
        if (!knowledge) return { status: "no_knowledge", hint: "Tell the owner GST lookups aren't set up in Munshi yet." };
        let passages: GstPassage[];
        try {
          passages = await knowledge.searchGst(item, 5);
        } catch (error) {
          console.error("[munshi] GST lookup failed:", error instanceof Error ? error.message : error);
          return { status: "knowledge_unavailable", hint: "The GST lookup didn't answer. Tell the owner to try again in a minute." };
        }
        if (passages.length === 0) return { status: "not_found", item, hint: "No official entry matched. Say so, and suggest the owner checks with their CA." };
        return {
          status: "found",
          item,
          entries: passages.map(gstEntry),
          hint: "Answer only from these entries: the total GST first, then the notification and S. No. it comes from. If loose and packed goods differ, give both. If no entry clearly covers the item, say you aren't sure and suggest checking with their CA. Never give a rate that isn't here.",
        };
      },
    }),

    supplierDues: tool({
      description:
        "What the shop owes a supplier or wholesaler (their orders not yet paid) and where a payment would go. Call before paySupplier and tell the owner the amount and the account.",
      inputSchema: z.object({ supplierName: z.string() }),
      execute: async ({ supplierName }) => {
        const r = await resolveSupplier(store, supplierName);
        const name = r.ok ? r.supplier.name : supplierName;
        const orders = await store.unpaidSupplierOrders(name);
        const due = orders.reduce((sum, o) => sum + o.totalPaise, 0);
        const unpaid = orders.slice(0, 5).map((o) => ({ orderId: o.orderRef, amount: formatINR(o.totalPaise), date: o.createdAt.slice(0, 10) }));
        if (!r.ok) return { ...r.result, unpaidOrders: unpaid, totalDue: formatINR(due) };
        if (!r.supplier.account || !r.supplier.verified) {
          return { status: "no_payout_account", supplier: name, unpaidOrders: unpaid, totalDue: formatINR(due), hint: ADD_ACCOUNT_HINT };
        }
        return {
          status: "dues",
          supplier: name,
          payTo: r.supplier.account,
          unpaidOrders: unpaid,
          totalDue: formatINR(due),
          hint: "Tell the owner what is due and where it would go, and ask whether to pay. Only if they say yes, call paySupplier with the amount.",
        };
      },
    }),

    paySupplier: tool({
      description:
        "Pay a supplier or wholesaler from the shop's Cashfree balance, to the UPI ID or bank account the owner added and confirmed in Munshi's dashboard. Moves real money, so call it only after supplierDues and the owner's yes; the owner then approves it with a button.",
      inputSchema: z.object({ supplierName: z.string(), amount: Rupees }),
      execute: async ({ supplierName, amount }) => {
        const r = await resolveSupplier(store, supplierName);
        if (!r.ok) return r.result;
        if (!r.supplier.account || !r.supplier.verified) return { status: "no_payout_account", supplier: r.supplier.name, hint: ADD_ACCOUNT_HINT };
        const amountPaise = rupeesToPaise(amount);
        // An order of exactly this amount is the one being paid, so it stops showing as due.
        const order = (await store.unpaidSupplierOrders(r.supplier.name)).find((o) => o.totalPaise === amountPaise);

        let payout;
        try {
          payout = await store.paySupplier({ supplier: r.supplier, amountPaise, supplierOrderId: order?.id });
        } catch (error) {
          console.error("[munshi] supplier payout failed:", error instanceof Error ? error.message : error);
          return {
            status: "payout_failed",
            supplier: r.supplier.name,
            amount: formatINR(amountPaise),
            hint: "The payment was NOT made (the payment service didn't take it). Tell the owner nothing left their account and to try again later.",
          };
        }
        await store.audit("supplier_payout", { supplierId: r.supplier.id, payoutId: payout.id, amountPaise, status: payout.status });
        const base = { supplier: r.supplier.name, amount: formatINR(amountPaise), to: r.supplier.account, ...(order ? { forOrder: order.orderRef } : {}) };
        if (payout.status === "success") return { status: "paid", ...base, utr: payout.utr };
        if (payout.status === "failed") {
          return { status: "payout_failed", ...base, reason: payout.reason, hint: "Tell the owner the payment failed and nothing left their account." };
        }
        return {
          status: "payout_started",
          ...base,
          hint: "The bank transfer has started. Tell the owner it is on its way and that Munshi will message them when it reaches the supplier. Never say it has reached them.",
        };
      },
    }),

    checkGstPortal: tool({
      description:
        "Look something up on the official GST portal with a web browser, such as an item's HSN code, only when lookupGst found no clear entry or the owner asks for the portal. Not for tagging a product: use lookupGst, then setProductGst. It runs in the background for about a minute, and Munshi messages the owner what the portal shows.",
      inputSchema: z.object({ question: z.string().min(5).max(200).describe("What to find, in English, e.g. 'What is the HSN code for makhana (fox nut)?'") }),
      execute: async ({ question }) => {
        if (!portal) return { status: "browsing_off", hint: "Tell the owner Munshi can't check the GST portal yet." };
        let started;
        try {
          started = await portal.start(question);
        } catch (error) {
          console.error("[munshi] couldn't start a GST portal lookup:", error instanceof Error ? error.message : error);
          return { status: "portal_unavailable", hint: "Tell the owner the GST portal can't be checked right now; try again later." };
        }
        // The answer arrives as a message on Telegram (or WhatsApp). Live, a web-only shop was told
        // "it will come on Telegram" with nothing linked, and the answer went nowhere.
        if (started === "no_inbox") {
          return {
            status: "no_inbox",
            hint: "Nothing was looked up: the portal's answer is sent on Telegram, and this shop hasn't connected it. Tell the owner to tap Connect Telegram on the dashboard, then ask again.",
          };
        }
        return {
          status: "checking_portal",
          question,
          hint: "Tell the owner Munshi is checking the official GST portal and will message what it finds in about a minute. Don't guess the answer.",
        };
      },
    }),

    makeChart: tool({
      description:
        "Draw a chart of the shop's own numbers (sales, udhaar, payments, expenses, stock) for 'is mahine ki sale chart mein dikhao' or 'udhaar ka graph'. You write a short Python program; it runs in an isolated sandbox over the khata's data and the picture is sent to the owner.",
      inputSchema: z.object({
        title: z.string().min(3).max(80).describe("The chart's title, in English"),
        about: z
          .enum(CHART_TOPICS)
          .describe("What it shows: sales (cash and udhaar, what 'sale' means in a kirana), cash_sales (only if the owner says cash only), udhaar, payments (money customers paid), expenses, stock, or other"),
        period: z
          .enum(CHART_PERIODS)
          .default("last_30_days")
          .describe("The days it covers: this_month for 'is mahine', last_month for 'pichhle mahine', last_7_days for 'is hafte'"),
        code: z.string().min(20).max(6000).describe(CHART_CODE_GUIDE),
      }),
      execute: async ({ title, about, period, code }) => {
        if (!charts) return { status: "charts_off", hint: "Tell the owner charts aren't set up in Munshi yet." };
        const window = chartWindow(period);
        const [entries, customers, products] = await Promise.all([store.recentEntries(2000, undefined), store.listCustomers(), store.listProducts()]);
        const { files, ledgerRows, totals } = chartFiles(entries, customers, products, window);
        const nothingHint = "No picture was drawn. Tell the owner in one sentence what summary says. Don't call makeChart again for this.";
        // Counted here, not by the program: an empty period gets a sentence, never an empty picture.
        const missing = nothingToChart(about, totals, products.length, window);
        if (missing) return { status: "nothing_to_chart", period: window.label, summary: missing, hint: nothingHint };
        if (salesChartSkipsUdhaar(about, code)) {
          return {
            status: "chart_error",
            error: "This sales chart leaves out udhaar. In a kirana udhaar is a sale: draw daily.csv's cash_sales and udhaar as stacked bars (or its sales column).",
            hint: "Fix the program and call makeChart again.",
          };
        }

        let result;
        try {
          result = await charts.run({ code, files });
        } catch (error) {
          console.error("[munshi] chart sandbox failed:", error instanceof Error ? error.message : error);
          return { status: "chart_unavailable", hint: "The chart service didn't respond. Tell the owner to try again in a minute." };
        }
        // The program found nothing to draw for the question: say so, no empty picture.
        const nothing = result.ok ? null : result.stdout?.match(new RegExp(`${NOTHING_TO_CHART}:?\\s*(.*)`));
        if (nothing) return { status: "nothing_to_chart", period: window.label, summary: nothing[1]?.trim() || "nothing to chart", hint: nothingHint };
        if (!result.ok) {
          return {
            status: "chart_error",
            error: result.error,
            hint: "The program failed. Fix it and call makeChart again; if it fails twice, tell the owner the chart couldn't be made.",
          };
        }
        const chart = await store.saveChart({ title, png: result.png });
        return {
          status: "chart_ready",
          chartId: chart.id,
          title,
          period: window.label,
          entries: ledgerRows,
          ...(about === "stock" ? {} : { totals: chartTotals(totals) }),
          summary: result.stdout,
          hint: "The chart is shown to the owner. Reply in one short sentence: amounts from totals (counted from the khata), anything else (like the highest day) from summary.",
        };
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
