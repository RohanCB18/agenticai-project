// A bill at the counter: the same sums on the till screen and on the server, so the total the
// customer is asked for is the total recorded. Plain code, no server or browser APIs.

/** Goods sold by weight or volume, in any amount (1.5 kg); everything else in whole units. */
const WEIGHED = /^(kg|kgs|kilo|kilos|g|gm|gms|gram|grams|l|lt|ltr|ltrs|litre|litres|liter|liters|ml)$/;

export const isWeighed = (unit: string) => WEIGHED.test(unit.trim().toLowerCase().replace(/\.$/, ""));

/** Quick amounts on the till for a product: half a kilo, a kilo... or 1, 2, 5 packets. */
export function quickQuantities(unit: string): number[] {
  const u = unit.trim().toLowerCase();
  if (/^(g|gm|gms|gram|grams|ml)$/.test(u)) return [100, 250, 500, 1000];
  return isWeighed(unit) ? [0.25, 0.5, 1, 2, 5] : [1, 2, 5, 10];
}

/** The price of one line, in paise: 1.5 kg at ₹60 is ₹90. */
export const lineAmount = (quantity: number, pricePaise: number) => Math.round(quantity * pricePaise);

export type TillLine = { productId: string; quantity: number; pricePaise: number };
export type BillItem = { productId: string; name: string; unit: string; quantity: number; pricePaise: number; amountPaise: number };
export type BillProduct = { id: string; name: string; unit: string };

const MAX_LINES = 100;
const MAX_QUANTITY = 100_000;
const MAX_PRICE_PAISE = 10_000_000; // ₹1 lakh for one unit

/**
 * The bill from the till's lines and the shop's own products. Names and units come from the
 * products, never the browser; a product twice is one line. A quantity must suit its unit (whole
 * packets), and every line needs a price.
 */
export function buildBill(lines: TillLine[], products: BillProduct[]): { items: BillItem[]; totalPaise: number } | { error: string } {
  if (lines.length === 0) return { error: "The bill is empty." };
  if (lines.length > MAX_LINES) return { error: `A bill can have at most ${MAX_LINES} items.` };
  const byId = new Map(products.map((p) => [p.id, p]));
  const merged = new Map<string, TillLine>();
  for (const line of lines) {
    const seen = merged.get(line.productId);
    merged.set(line.productId, seen ? { ...line, quantity: seen.quantity + line.quantity } : line);
  }

  const items: BillItem[] = [];
  for (const line of merged.values()) {
    const product = byId.get(line.productId);
    if (!product) return { error: "An item on the bill isn't one of this shop's products." };
    const { quantity, pricePaise } = line;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) return { error: `Check the quantity of ${product.name}.` };
    if (!isWeighed(product.unit) && !Number.isInteger(quantity)) return { error: `${product.name} is sold in whole ${product.unit}.` };
    if (!Number.isInteger(pricePaise) || pricePaise < 1 || pricePaise > MAX_PRICE_PAISE) return { error: `Add a price for ${product.name}.` };
    items.push({ productId: product.id, name: product.name, unit: product.unit, quantity: Number(quantity.toFixed(3)), pricePaise, amountPaise: lineAmount(quantity, pricePaise) });
  }
  const totalPaise = items.reduce((sum, item) => sum + item.amountPaise, 0);
  if (totalPaise < 100) return { error: "The bill must come to at least ₹1." };
  return { items, totalPaise };
}

/** A scanned or typed code, cleaned up, or null if it can't be a product's barcode. */
export function cleanBarcode(raw: string): string | null {
  const code = raw.trim().replace(/\s+/g, "");
  return /^[0-9A-Za-z-]{4,32}$/.test(code) ? code : null;
}

/** What a USB scanner or the camera types: digits only, 8 to 14 of them (EAN-8, UPC, EAN-13...). */
export const looksLikeBarcode = (text: string) => /^\d{8,14}$/.test(text.trim());

/** "₹1,234.50" from paise, without the paise when there are none. */
export function rupees(paise: number) {
  const value = paise / 100;
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
}
