// The shop's online store: plain code shared by the store page and the server, so what the
// customer sees in the cart is what the server checks. No server or browser APIs.

import type { TillLine } from "@/lib/counter-bill";

/** The store's address from the shop's name: "RCB General Stores" → "rcb-general-stores". */
export function shopSlug(shopName: string): string {
  const slug = shopName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "shop";
}

// ---------------------------------------------------------------- aisles

export type Aisle = { id: string; name: string; emoji: string };

export const AISLES: Aisle[] = [
  { id: "dairy", name: "Dairy, bread & eggs", emoji: "🥛" },
  { id: "veg", name: "Fruits & vegetables", emoji: "🥬" },
  { id: "staples", name: "Atta, rice & dal", emoji: "🌾" },
  { id: "oil", name: "Oil, ghee & masala", emoji: "🫗" },
  { id: "snacks", name: "Snacks & biscuits", emoji: "🍪" },
  { id: "drinks", name: "Tea, coffee & drinks", emoji: "☕" },
  { id: "home", name: "Cleaning & household", emoji: "🧽" },
  { id: "care", name: "Personal care", emoji: "🧴" },
  { id: "more", name: "More", emoji: "🛒" },
];

// Word → [aisle, the product's own emoji]. First match wins, so specific words come first.
const WORDS: [RegExp, string, string][] = [
  [/\b(ghee|tuppa)\b/, "oil", "🧈"],
  [/\bbutter\b/, "dairy", "🧈"],
  [/\b(milk|doodh|haalu|curd|dahi|mosaru|lassi)\b/, "dairy", "🥛"],
  [/\b(paneer|cheese)\b/, "dairy", "🧀"],
  [/\bbread|\bbun\b|\bpav\b/, "dairy", "🍞"],
  [/\begg/, "dairy", "🥚"],
  [/\bonion|\bpyaz/, "veg", "🧅"],
  [/\bpotato|\baloo\b/, "veg", "🥔"],
  [/\btomato/, "veg", "🍅"],
  [/\bbanana|\bkela\b/, "veg", "🍌"],
  [/\bapple/, "veg", "🍎"],
  [/\b(lemon|nimbu)/, "veg", "🍋"],
  [/\b(coriander|dhania|spinach|palak|vegetable|sabzi)/, "veg", "🥬"],
  [/\b(rice|chawal|akki|basmati|masoori)\b/, "staples", "🍚"],
  [/\b(atta|maida|besan|flour|rava|sooji|suji)\b/, "staples", "🌾"],
  [/\b(dal|daal|toor|moong|chana|rajma|bele)\b/, "staples", "🫘"],
  [/\b(sugar|cheeni|chini|jaggery|gud)\b/, "staples", "🍬"],
  [/\b(salt|namak)\b/, "staples", "🧂"],
  [/\b(poha|avalakki)\b/, "staples", "🍚"],
  [/\boil\b|\btel\b/, "oil", "🫗"],
  [/\b(masala|chilli|chili|mirchi|haldi|turmeric|jeera|spice)/, "oil", "🌶️"],
  [/\b(maggi|noodle|pasta|yippee)/, "snacks", "🍜"],
  [/\b(biscuit|parle|cookie|marie|bourbon|good ?day)/, "snacks", "🍪"],
  [/\b(chips|lays|kurkure|namkeen|bhujia|mixture)/, "snacks", "🥨"],
  [/\b(chocolate|dairy milk|kitkat|5 ?star)/, "snacks", "🍫"],
  [/\b(tea|chai)\b/, "drinks", "🍵"],
  [/\b(coffee|bru|nescafe)/, "drinks", "☕"],
  [/\b(juice|frooti|maaza)/, "drinks", "🧃"],
  [/\b(cola|pepsi|coke|sprite|thums|soda|drink)/, "drinks", "🥤"],
  [/\b(water|bisleri)\b/, "drinks", "💧"],
  [/\b(surf|detergent|ariel|rin|tide|vim|harpic|lizol|phenyl|cleaner)/, "home", "🧽"],
  [/\b(soap|sabun|lifebuoy|lux|dettol|santoor)\b/, "care", "🧼"],
  [/\b(toothpaste|colgate|pepsodent|brush)/, "care", "🪥"],
  [/\b(shampoo|clinic|cream|lotion|hair oil)/, "care", "🧴"],
];

/** Which aisle a product goes in, and its picture, from its name and the owner's other names for it. */
export function aisleOf(name: string, aliases: string[] = []): { aisle: string; emoji: string } {
  const text = [name, ...aliases].join(" ").toLowerCase();
  for (const [pattern, aisle, emoji] of WORDS) if (pattern.test(text)) return { aisle, emoji };
  return { aisle: "more", emoji: "🛒" };
}

// ---------------------------------------------------------------- ordering

/** How much one tap adds: 1 kg, 1 packet, or 100 g for goods priced by the gram. */
export const orderStep = (unit: string) => (/^(g|gm|gms|gram|grams|ml)$/.test(unit.trim().toLowerCase()) ? 100 : 1);

/**
 * The most a customer may order of a product: never more than the shelf has, in whole steps (the
 * store sells 1 kg or 2 kg of rice, not the 0.4 kg left after a counter sale).
 */
export function canOrder(stock: number, unit: string): number {
  const step = orderStep(unit);
  return stock < step ? 0 : Math.floor(stock / step) * step;
}

/** The few-left badge: "Only 3 left" when there's little on the shelf. */
export const fewLeft = (stock: number, unit: string) => canOrder(stock, unit) > 0 && canOrder(stock, unit) <= 5 * orderStep(unit);

export type CartLine = { productId: string; quantity: number };
export type ShelfProduct = { id: string; name: string; unit: string; stock: number; pricePaise: number | null };

/** Largest online order: a household's shopping, not a wholesaler's. */
export const MAX_ORDER_PAISE = 2_000_000; // ₹20,000

/**
 * The cart as till lines priced from the shop's own products (never the browser's prices), or why
 * it can't be ordered: a product the store doesn't sell, more than the shelf has.
 */
export function cartToLines(cart: CartLine[], products: ShelfProduct[]): TillLine[] | { error: string } {
  if (cart.length === 0) return { error: "Your cart is empty." };
  const byId = new Map(products.map((p) => [p.id, p]));
  const wanted = new Map<string, number>();
  for (const line of cart) wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.quantity);
  const lines: TillLine[] = [];
  for (const [productId, quantity] of wanted) {
    const product = byId.get(productId);
    if (!product || product.pricePaise === null || product.pricePaise < 1) return { error: "Something in your cart isn't sold here any more. Remove it and try again." };
    const step = orderStep(product.unit);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity / step)) return { error: `Check how much ${product.name} you want.` };
    const most = canOrder(product.stock, product.unit);
    if (most === 0) return { error: `${product.name} just sold out. Remove it to place the order.` };
    if (quantity > most) return { error: `Only ${most} ${product.unit} of ${product.name} left. Lower it to place the order.` };
    lines.push({ productId, quantity, pricePaise: product.pricePaise });
  }
  return lines;
}

export type Buyer = { name: string; phone: string; address: string | null };

/** The customer's details, cleaned up, or what to fix. A 10-digit Indian mobile number; +91 is fine. */
export function checkBuyer(input: { name?: string; phone?: string; address?: string }): Buyer | { error: string } {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 80) return { error: "Tell the shop your name." };
  const digits = (input.phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) return { error: "Enter a 10-digit mobile number." };
  const address = (input.address ?? "").replace(/\s+/g, " ").trim();
  if (address.length > 300) return { error: "Keep the address under 300 letters." };
  return { name, phone: digits, address: address || null };
}

/** "98•••••210": enough for the owner to recognise a number in a chat message. */
export const maskPhone = (phone: string) => `${phone.slice(0, 2)}${"•".repeat(Math.max(phone.length - 5, 0))}${phone.slice(-3)}`;

// ---------------------------------------------------------------- a supermarket's shelf, for a demo

export type SampleProduct = { name: string; aliases: string[]; unit: string; pricePaise: number; stock: number };

/**
 * A small supermarket's everyday range, for an owner who wants the store to look full in a demo.
 * Most of it is what the demo wholesaler (Sharma Traders) sells, so a restock ask comes with a
 * quote; dairy, bread and vegetables come from elsewhere, as they do. Stock starts a little above
 * Munshi's default alert level, so a few orders take an item low.
 */
export const SAMPLE_PRODUCTS: SampleProduct[] = [
  { name: "Sona Masoori Rice", aliases: ["rice", "chawal", "akki"], unit: "kg", pricePaise: 6200, stock: 18 },
  { name: "Aashirvaad Atta", aliases: ["atta", "wheat flour"], unit: "kg", pricePaise: 5200, stock: 16 },
  { name: "Toor Dal", aliases: ["toor dal", "arhar", "dal"], unit: "kg", pricePaise: 16000, stock: 13 },
  { name: "Moong Dal", aliases: ["moong", "hesaru bele"], unit: "kg", pricePaise: 14000, stock: 12 },
  { name: "Sugar", aliases: ["sugar", "cheeni", "sakkare"], unit: "kg", pricePaise: 4800, stock: 15 },
  { name: "Tata Salt", aliases: ["salt", "namak"], unit: "kg", pricePaise: 2800, stock: 14 },
  { name: "Besan", aliases: ["besan", "gram flour"], unit: "kg", pricePaise: 11000, stock: 12 },
  { name: "Poha", aliases: ["poha", "avalakki"], unit: "kg", pricePaise: 7000, stock: 12 },
  { name: "Rava", aliases: ["rava", "sooji", "suji"], unit: "kg", pricePaise: 5600, stock: 12 },
  { name: "Sunflower Oil", aliases: ["oil", "sunflower oil"], unit: "ltr", pricePaise: 16500, stock: 8 },
  { name: "Amul Ghee", aliases: ["ghee", "tuppa"], unit: "ltr", pricePaise: 72000, stock: 7 },
  { name: "Parle-G Biscuits", aliases: ["parle g", "biscuit"], unit: "packet", pricePaise: 1000, stock: 30 },
  { name: "Maggi Noodles", aliases: ["maggi", "noodles"], unit: "packet", pricePaise: 1500, stock: 24 },
  { name: "Red Label Tea 250g", aliases: ["tea", "chai patti"], unit: "packet", pricePaise: 15500, stock: 14 },
  { name: "Surf Excel", aliases: ["surf", "detergent"], unit: "kg", pricePaise: 14000, stock: 12 },
  { name: "Lifebuoy Soap", aliases: ["soap", "sabun"], unit: "piece", pricePaise: 3800, stock: 20 },
  { name: "Nandini Milk 500ml", aliases: ["milk", "haalu", "doodh"], unit: "packet", pricePaise: 2600, stock: 40 },
  { name: "Brown Bread", aliases: ["bread"], unit: "packet", pricePaise: 4500, stock: 12 },
  { name: "Eggs", aliases: ["egg", "anda"], unit: "dozen", pricePaise: 8400, stock: 6 },
  { name: "Amul Butter 100g", aliases: ["butter"], unit: "packet", pricePaise: 5800, stock: 14 },
  { name: "Onion", aliases: ["onion", "pyaz", "eerulli"], unit: "kg", pricePaise: 4000, stock: 20 },
  { name: "Potato", aliases: ["potato", "aloo"], unit: "kg", pricePaise: 3500, stock: 20 },
  { name: "Tomato", aliases: ["tomato", "tamatar"], unit: "kg", pricePaise: 3000, stock: 15 },
  { name: "Colgate Toothpaste", aliases: ["toothpaste", "colgate"], unit: "piece", pricePaise: 10500, stock: 12 },
];

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether the shop already sells this sample product, by any of its names. */
export function alreadySells(sample: SampleProduct, products: { name: string; aliases: string[] }[]): boolean {
  const names = new Set([sample.name, ...sample.aliases].map(key));
  return products.some((p) => [p.name, ...p.aliases].some((n) => names.has(key(n))));
}
