import type { Product } from "./store";
import { type QuoteRequestItem, quoteLines, type SupplierOrder, type SupplierQuote } from "./supplier";

// Restocking on Munshi's own initiative. When a sale takes something to its alert level, Munshi
// asks once, with the wholesaler's signed quote, and one "haan" (tapped, typed or said) orders
// exactly that quote and pays the supplier from the shop's Cashfree balance (or, when the balance
// can't, sends a page to pay). Plain code decides what is low and how much to order; the
// wholesaler decides the price.

// Every product has an alert level from the start, so the owner never has to ask for one: by its
// unit, roughly what a kirana sells in a few days, so there is time for the wholesaler's next
// delivery. The owner changes any of them in chat ("Rice 20 kg pe alert karna").
const DEFAULT_ALERT: [RegExp, number][] = [
  [/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/, 10],
  [/^(g|gm|gms|gram|grams)$/, 1000],
  [/^(l|lt|ltr|ltrs|litre|litres|liter|liters)$/, 5],
  [/^ml$/, 1000],
  [/^(box|boxes|carton|cartons|case|cases|bag|bags|sack|sacks|dozen|dozens|dz)$/, 2],
  [/^(bottle|bottles|can|cans|tin|tins|jar|jars)$/, 6],
  [/^(pkt|pkts|packet|packets|pack|packs|pcs|pc|piece|pieces|nos|unit|units)$/, 10],
];

/** The alert level of a product the owner hasn't set one for: 10 kg, 5 ltr, 10 packets, 2 boxes... */
export function defaultAlertLevel(unit: string) {
  const u = unit.trim().toLowerCase().replace(/\.$/, "");
  return DEFAULT_ALERT.find(([pattern]) => pattern.test(u))?.[1] ?? 5;
}

// A plain yes or no to a restock ask, typed or said ("haan", "ಹೌದು", "नहीं"). Anything longer
// ("haan, 2 bag aur") goes to the agent like any message.
const YES = new Set([
  "haan", "haa", "ha", "han", "haan ji", "haanji", "hanji", "ji haan", "haan haan", "yes", "yeah", "yep", "ok", "okay", "ok ji",
  "theek hai", "thik hai", "kar do", "order karo", "order kar do", "haan karo", "haan kar do", "haan order karo", "haan order kar do",
  "bilkul", "sure", "houdu", "haudu", "sari", "aytu", "ಹೌದು", "ಸರಿ", "ಆಯ್ತು", "हाँ", "हां", "हा", "जी हाँ", "जी हां", "हाँ जी", "हां जी",
  "ठीक है", "कर दो", "ऑर्डर करो", "ऑर्डर कर दो",
]);
const NO = new Set(["nahi", "nahin", "na", "no", "nope", "mat karo", "rehne do", "nahi chahiye", "abhi nahi", "beda", "illa", "ಬೇಡ", "ಇಲ್ಲ", "नहीं", "ना", "मत करो", "रहने दो", "अभी नहीं"]);

/** True for a plain "haan", false for a plain "nahi", null for anything else. */
export function plainYesNo(text: string): boolean | null {
  const said = text.normalize("NFC").toLowerCase().replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
  if (YES.has(said)) return true;
  if (NO.has(said)) return false;
  return null;
}

/** Products at or below their alert level (the owner's, or Munshi's default). A product with no level at all is never low. */
export function lowProducts(products: Product[]) {
  return products.filter((p) => p.reorderLevel !== null && p.stockQty <= p.reorderLevel);
}

/** What to ask the wholesaler for one product: topped up to twice its alert level, so it isn't low again next week. */
export const topUpItem = (p: Product): QuoteRequestItem => ({ name: p.name, quantity: Math.max((p.reorderLevel ?? 0) * 2 - p.stockQty, 1), unit: p.unit });

/** What to ask the wholesaler for: each low product topped up to twice its alert level. */
export function restockItems(products: Product[]): QuoteRequestItem[] {
  return lowProducts(products).map(topUpItem);
}

/**
 * What runs low next, closest to its alert level first: products above their level but under
 * twice it. When the low items alone come to less than the wholesaler's minimum order, these fill
 * it, as an owner would add the dal that's nearly due rather than skip the order.
 */
export function nextToRunLow(products: Product[], exclude: Set<string> = new Set()): Product[] {
  const ratio = (p: Product) => p.stockQty / p.reorderLevel!;
  return products
    .filter((p) => p.reorderLevel !== null && p.reorderLevel > 0 && !exclude.has(p.id) && p.stockQty > p.reorderLevel && p.stockQty < p.reorderLevel * 2)
    .sort((a, b) => ratio(a) - ratio(b));
}

/** "₹1,160.50" → 116050. Null for anything without a number. */
export function paiseOf(rupees: string): number | null {
  const value = Number.parseFloat(rupees.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

const amountOf = (quantity: number, unit: string) => `${Number(quantity.toFixed(3))} ${unit}`;
/** "Sharma Traders' account", "Gupta's account". */
const possessive = (name: string) => (/s$/i.test(name.trim()) ? `${name}'` : `${name}'s`);

/** Where the supplier is paid (their masked account) and whether it comes from the Cashfree balance or a page the owner pays. */
export type RestockPayee = { to: string; fromBalance: boolean };

/**
 * The message that asks the owner. `canOrder` says whether there is a quote one "haan" can order:
 * there isn't when no wholesaler is connected, it can't supply anything, or the total is under its
 * minimum. `pay` is set when the owner added the supplier's account.
 */
export function restockAlert(
  low: Product[],
  quote: SupplierQuote | null,
  pay: RestockPayee | null,
  problem?: string,
  /** Added to reach the wholesaler's minimum order: what runs low next. */
  added: Product[] = [],
): { text: string; canOrder: boolean } {
  const alertAt = (p: Product) => (p.reorderLevel === null ? "" : ` (alert at ${amountOf(p.reorderLevel, p.unit)}${p.alertIsDefault ? ", Munshi's default" : ""})`);
  const stock = (p: Product) => `${p.name} ${amountOf(p.stockQty, p.unit)} left${alertAt(p)}`;
  const running = `📦 Running low: ${low.map(stock).join(", ")}.`;
  const filled =
    quote && added.length
      ? `${possessive(quote.supplier)} minimum order is ${quote.minimumOrder}, so I added what runs low next: ${added.map(stock).join(", ")}.`
      : null;
  const head = filled ? `${running}\n${filled}` : running;
  if (!quote) return { text: `${head}\n\n${problem ?? "No wholesaler is connected to Munshi to order from."}`, canOrder: false };

  const cant = quote.unavailable.length ? `Can't supply: ${quote.unavailable.map((u) => `${u.requested} (${u.reason})`).join(", ")}.` : null;
  if (!quote.quoteId || quote.lines.length === 0) {
    return { text: [head, "", `${quote.supplier} can't send any of these right now.`, cant].filter((line) => line !== null).join("\n"), canOrder: false };
  }
  const offer = [`${quote.supplier} can send:`, ...quoteLines(quote.lines), `Total ${quote.total}${quote.discount ? `, with ${quote.discount} discount` : ""} · delivery ${quote.deliverySlot}`];
  if (!quote.meetsMinimum) {
    const short = `Orders start at ${quote.minimumOrder}, so this can't be ordered alone. Add more, like "Sharma Traders se 25 kg chawal bhi mangwao".`;
    return { text: [head, "", ...offer, cant, "", short].filter((line) => line !== null).join("\n"), canOrder: false };
  }
  const ask = !pay
    ? `Haan: Munshi places this order, to pay on delivery. To pay through Munshi, add ${possessive(quote.supplier)} account on the Suppliers page.`
    : pay.fromBalance
      ? `Haan: Munshi places this order and pays ${quote.supplier} ${quote.total} from your Cashfree balance (to ${pay.to}). If the balance can't, you get a Cashfree page to pay instead.`
      : `Haan: Munshi places this order and sends you a Cashfree page to pay ${quote.supplier} ${quote.total} (it goes to ${pay.to}).`;
  return { text: [head, "", ...offer, cant, "", ask].filter((line) => line !== null).join("\n"), canOrder: true };
}

/** How paying for a restock order went. */
export type RestockPayment =
  | { status: "paid"; to: string; utr: string | null }
  | { status: "started"; to: string }
  | { status: "page"; url: string; to: string; because?: string | null }
  | { status: "failed"; error: string };

/** After "haan": the order, and how it was paid (or why it wasn't). */
export function restockOrdered(order: SupplierOrder, pay: RestockPayment | null): string {
  const head = `✅ Order ${order.orderId} placed with ${order.supplier}: ${order.total}, delivery ${order.deliverySlot}.`;
  if (pay === null) return `${head}\n\nPay on delivery. To pay through Munshi next time, add ${possessive(order.supplier)} account on the Suppliers page.`;
  switch (pay.status) {
    case "paid":
      return `${head}\n\n💸 Paid ${order.total} to ${order.supplier} from your Cashfree balance (to ${pay.to}).${pay.utr ? ` UTR ${pay.utr}.` : ""}`;
    case "started":
      return `${head}\n\n💸 Paying ${order.total} to ${order.supplier} from your Cashfree balance (to ${pay.to}). Munshi tells you as soon as it reaches them.`;
    case "page": {
      const why = pay.because ? `Your Cashfree balance couldn't pay it (${pay.because}), so pay` : "Pay";
      return `${head}\n\n💸 ${why} ${order.total} to ${order.supplier} here: ${pay.url}\nCashfree sends it to ${pay.to}, and Munshi tells you when it's paid.`;
    }
    case "failed":
      return `${head}\n\nI couldn't pay ${order.supplier} (${pay.error}). Nothing was paid: say "${order.supplier} ko payment kar do" to try again.`;
  }
}
