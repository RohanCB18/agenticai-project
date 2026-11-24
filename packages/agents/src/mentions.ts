import { normalise, rankByName } from "./match";
import { rankProducts } from "./staples";

// Which of the shop's customers and products the owner's message names, worked out by code
// before any model reads it. Live, "Akki eshtu ide" (Kannada: how much rice is left?) came right
// after a chat about Ramesh, and every desk took "Akki" for a customer's name. Told that "akki"
// is this shop's Rice, the model doesn't have to guess.

export type Mention = { word: string; customers: string[]; products: string[]; suppliers?: string[] };

type Named = { name: string; aliases: string[] };

// High enough that a prefix ("sab" for "Sabun", 0.85) doesn't count; a staple name (0.9) does.
const SURE = 0.88;

/**
 * Words in the message that name one of this shop's customers, products or suppliers. Suppliers
 * too: live, "Sharma Traders ko 100 rupaye payment kar do" was once saved as an expense.
 */
export function findMentions(text: string, customers: Named[], products: Named[], suppliers: Named[] = []): Mention[] {
  const all = normalise(text).split(" ").filter(Boolean);
  const words = [...new Set(all)].filter((word) => word.length >= 3 && !/^\d+$/.test(word));
  const mentions: Mention[] = [];
  for (const word of words) {
    const who = rankByName(word, customers, SURE).map((m) => m.item.name);
    const what = rankProducts(word, products, SURE).map((m) => m.item.name);
    if (who.length || what.length) mentions.push({ word, customers: who.slice(0, 3), products: what.slice(0, 3) });
  }
  // Supplier names are usually two or three words ("Sharma Traders"): compare runs of words.
  const runs = new Set(all.flatMap((_, i) => [1, 2, 3].map((n) => all.slice(i, i + n).join(" ")).filter((run) => run.length >= 4)));
  const named = new Map<string, string[]>();
  for (const run of runs) {
    const paid = rankByName(run, suppliers, SURE).map((m) => m.item.name);
    if (paid.length && !named.has(paid[0]!)) named.set(paid[0]!, [run, ...paid.slice(0, 3)]);
  }
  for (const [run, ...paid] of named.values()) mentions.push({ word: run!, customers: [], products: [], suppliers: paid });
  return mentions;
}

function describe({ word, customers, products, suppliers = [] }: Mention) {
  const names = [
    ...customers.map((name) => `the customer ${name}`),
    ...products.map((name) => `the product ${name}`),
    ...suppliers.map((name) => `the supplier ${name}, paid with supplierDues then paySupplier`),
  ];
  return names.length === 1 ? `"${word}" is ${names[0]}` : `"${word}" could be ${names.join(" or ")}`;
}

/** The closing note for the desk: what the owner's words refer to in this shop. */
export function mentionsNote(mentions: Mention[]): string | null {
  if (!mentions.length) return null;
  return `In this shop's records, ${mentions.map(describe).join("; ")}. Go by this unless the owner says otherwise.`;
}

/** The same, shortly, for the router. */
export function mentionsHint(mentions: Mention[]): string | null {
  if (!mentions.length) return null;
  return mentions.map(describe).join("; ");
}
