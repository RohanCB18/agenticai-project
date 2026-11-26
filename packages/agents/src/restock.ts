import type { Product } from "./store";
import { type QuoteRequestItem, quoteLines, type SupplierOrder, type SupplierQuote } from "./supplier";

// Restocking on Munshi's own initiative. When something falls to the alert level the owner set
// ("Rice 10 kg pe alert karna"), Munshi asks once, with the wholesaler's signed quote, and one
// "haan" orders exactly that quote and pays the supplier from the shop's Cashfree balance (or, when
// the balance can't, sends a page to pay). Plain code decides what is low and how much to order;
// the wholesaler decides the price.

/** Products at or below the alert level the owner set. A product with no alert is never low. */
export function lowProducts(products: Product[]) {
  return products.filter((p) => p.reorderLevel !== null && p.stockQty <= p.reorderLevel);
}

/** What to ask the wholesaler for: each low product topped up to twice its alert level, so it isn't low again next week. */
export function restockItems(products: Product[]): QuoteRequestItem[] {
  return lowProducts(products).map((p) => ({ name: p.name, quantity: Math.max(p.reorderLevel! * 2 - p.stockQty, 1), unit: p.unit }));
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
export function restockAlert(low: Product[], quote: SupplierQuote | null, pay: RestockPayee | null, problem?: string): { text: string; canOrder: boolean } {
  const head = `📦 Running low: ${low.map((p) => `${p.name} ${amountOf(p.stockQty, p.unit)} left${p.reorderLevel === null ? "" : ` (alert at ${amountOf(p.reorderLevel, p.unit)})`}`).join(", ")}.`;
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
