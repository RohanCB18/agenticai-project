import type { Product } from "./store";
import { type QuoteRequestItem, quoteLines, type SupplierOrder, type SupplierQuote } from "./supplier";

// Restocking on Munshi's own initiative. When something falls to the alert level the owner set
// ("Rice 10 kg pe alert karna"), Munshi asks once, with the wholesaler's signed quote, and one
// "haan" orders exactly that quote and sends the page to pay the supplier. Plain code decides what
// is low and how much to order; the wholesaler decides the price.

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

/**
 * The message that asks the owner. `canOrder` says whether there is a quote one "haan" can order:
 * there isn't when no wholesaler is connected, it can't supply anything, or the total is under its
 * minimum. `payTo` is the supplier's masked account, when the owner added one.
 */
export function restockAlert(low: Product[], quote: SupplierQuote | null, payTo: string | null, problem?: string): { text: string; canOrder: boolean } {
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
  const ask = payTo
    ? `Haan: Munshi places this order and sends you a Cashfree page to pay ${quote.supplier} ${quote.total} (it goes to ${payTo}).`
    : `Haan: Munshi places this order, to pay on delivery. To pay through Munshi, add ${possessive(quote.supplier)} account on the Suppliers page.`;
  return { text: [head, "", ...offer, cant, "", ask].filter((line) => line !== null).join("\n"), canOrder: true };
}

/** After "haan": the order, and the page to pay for it (or why there isn't one). */
export function restockOrdered(order: SupplierOrder, pay: { url: string; to: string } | { error: string } | null): string {
  const head = `✅ Order ${order.orderId} placed with ${order.supplier}: ${order.total}, delivery ${order.deliverySlot}.`;
  if (pay === null) return `${head}\n\nPay on delivery. To pay through Munshi next time, add ${possessive(order.supplier)} account on the Suppliers page.`;
  if ("error" in pay) {
    return `${head}\n\nI couldn't make the payment page (${pay.error}). Nothing was paid: say "${order.supplier} ko payment kar do" to try again.`;
  }
  return `${head}\n\n💸 Pay ${order.total} to ${order.supplier} here: ${pay.url}\nCashfree sends it to ${pay.to}, and Munshi tells you when it's paid.`;
}
