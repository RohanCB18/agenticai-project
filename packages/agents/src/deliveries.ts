import { rankByName } from "./match";
import type { Product } from "./store";
import type { SupplierLine } from "./supplier";

// A wholesaler's delivery, received without the owner lifting a finger. When the van reaches the
// shop, the wholesaler's agent sends the delivery note (its invoice, as data, the way a
// distributor's billing system sends an e-invoice), and Munshi adds each line to the matching
// product's stock. Plain code decides the matching; a line it can't place safely (a product it
// can't find, or counted in another unit: Parle-G by the box, delivered by the packet) is left out
// and the owner is told, rather than guessed at.

/** Units that mean the same thing, so "litre" on the invoice is the shop's "ltr". */
const UNIT_GROUPS: string[][] = [
  ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"],
  ["g", "gm", "gms", "gram", "grams"],
  ["l", "lt", "ltr", "ltrs", "litre", "litres", "liter", "liters"],
  ["ml"],
  ["pkt", "pkts", "packet", "packets", "pack", "packs"],
  ["pc", "pcs", "piece", "pieces", "nos", "unit", "units"],
  ["box", "boxes"],
  ["bag", "bags", "sack", "sacks"],
  ["dozen", "dozens", "dz"],
  ["bottle", "bottles"],
  ["tin", "tins", "can", "cans"],
  ["jar", "jars"],
  ["case", "cases", "carton", "cartons"],
];

const unitKey = (unit: string) => {
  const u = unit.trim().toLowerCase().replace(/\.$/, "");
  const group = UNIT_GROUPS.findIndex((g) => g.includes(u));
  return group === -1 ? u : `#${group}`;
};

/** Whether two units are the same measure ("litre" and "ltr" are; "packet" and "box" aren't). */
export const sameUnit = (a: string, b: string) => unitKey(a) === unitKey(b);

export type ReceivedLine = { product: Product; quantity: number; line: SupplierLine };
export type UnplacedLine = { line: SupplierLine; why: string };

/**
 * Which of the shop's products each delivered line goes to. The line's own "requested" name (the
 * shop's name for it, sent when it was ordered) first, then the closest name, and only in the same
 * unit. The same product twice is added up.
 */
export function placeDelivery(lines: SupplierLine[], products: Product[]): { received: ReceivedLine[]; unplaced: UnplacedLine[] } {
  const received: ReceivedLine[] = [];
  const unplaced: UnplacedLine[] = [];
  for (const line of lines) {
    if (!(line.quantity > 0)) continue;
    const asked = (line.requested ?? "").trim().toLowerCase();
    const product = (asked && products.find((p) => p.name.trim().toLowerCase() === asked)) || rankByName(line.requested || line.item, products, 0.85)[0]?.item;
    if (!product) {
      unplaced.push({ line, why: "isn't one of your products" });
      continue;
    }
    if (!sameUnit(line.unit, product.unit)) {
      unplaced.push({ line, why: `your ${product.name} is counted in ${product.unit}` });
      continue;
    }
    const seen = received.find((r) => r.product.id === product.id);
    if (seen) seen.quantity += line.quantity;
    else received.push({ product, quantity: line.quantity, line });
  }
  return { received, unplaced };
}

const amount = (n: number) => Number(n.toFixed(3));

/** The owner's message once a delivery is in stock: what came, what the shelf has now, and how to say if something was short. */
export function deliveryMessage(note: { supplier: string; orderId: string; invoiceNo: string; total: string }, received: ReceivedLine[], unplaced: UnplacedLine[]): string {
  const lines = [`🚚 ${note.supplier} delivered order ${note.orderId} (invoice ${note.invoiceNo}, ${note.total}).`];
  if (received.length) {
    lines.push("Added to stock:");
    for (const r of received) {
      lines.push(`• ${r.product.name} +${amount(r.quantity)} ${r.product.unit}: ${amount(r.product.stockQty)} → ${amount(r.product.stockQty + r.quantity)}`);
    }
  }
  if (unplaced.length) {
    lines.push("Not added, tell me how much to add:");
    for (const u of unplaced) lines.push(`• ${u.line.item} ${amount(u.line.quantity)} ${u.line.unit} (${u.why})`);
  }
  if (received.length) lines.push(`If anything came short or damaged, tell me, like "${received[0]!.product.name} ${amount(Math.max(1, Math.floor(received[0]!.quantity / 2)))} ${received[0]!.product.unit} hi aaya".`);
  return lines.join("\n");
}
