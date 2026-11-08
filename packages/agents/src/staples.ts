import { type Match, normalise, rankByName } from "./match";

// Everyday names for kirana staples across Indian languages, written in English letters. Owners
// say "akki" or "chawal" for the product they saved as "Rice", and shouldn't have to add every
// word as an alias first. Other scripts need no entries: "ಅಕ್ಕಿ" and "चावल" are matched
// phonetically against "akki" and "chawal". The first word of each group is the English name.
const STAPLES: string[][] = [
  ["rice", "chawal", "chaawal", "chaval", "akki", "arisi", "biyyam", "bhaat", "tandul"],
  ["wheat flour", "atta", "aata", "godhi hittu", "godhuma pindi", "kothumai maavu", "gehun ka atta"],
  ["wheat", "gehun", "gehu", "godhi", "godhumai", "godhumalu"],
  ["sugar", "cheeni", "chini", "shakkar", "sakkare", "sakkarai", "chakkera"],
  ["salt", "namak", "uppu", "noon"],
  ["oil", "tel", "tael", "enne", "ennai", "nune"],
  ["milk", "doodh", "dudh", "haalu", "paal", "paalu"],
  ["curd", "dahi", "mosaru", "thayir", "perugu"],
  ["toor dal", "arhar dal", "togari bele", "thuvaram paruppu", "kandi pappu"],
  ["tea", "chai", "chaha", "chaya", "tea powder", "chai patti"],
  ["coffee", "kaapi", "kapi", "coffee powder"],
  ["jaggery", "gur", "gud", "bella", "vellam", "bellam"],
  ["onion", "pyaz", "pyaaz", "kanda", "eerulli", "vengayam", "ullipaya"],
  ["potato", "aloo", "alu", "aalugadde", "urulai", "urulaikizhangu", "bangaladumpa"],
  ["tomato", "tamatar", "tomoto", "thakkali"],
  ["egg", "anda", "ande", "motte", "muttai", "guddu"],
  ["semolina", "sooji", "suji", "rava", "ravai", "bombay rava"],
  ["gram flour", "besan", "kadale hittu", "kadalai maavu", "senaga pindi"],
  ["flattened rice", "poha", "avalakki", "aval", "atukulu"],
  ["turmeric", "haldi", "arishina", "manjal", "pasupu"],
  ["chilli powder", "mirchi powder", "lal mirch", "menasina pudi", "milagai thool", "karam"],
  ["soap", "sabun", "saabun", "sopu"],
];

const STAPLE_GROUPS = STAPLES.map((group) => group.map(normalise));

/** Every staple group a product belongs to, judged by its name and aliases ("Sona Masoori Rice" is rice). */
function staplesFor(product: { name: string; aliases: string[] }) {
  const names = [product.name, ...product.aliases].map(normalise);
  return STAPLE_GROUPS.filter((group) =>
    names.some((name) => group.some((word) => name === word || ` ${name} `.includes(` ${word} `))),
  );
}

// A staple name is a good guess, never a certain one: it scores below the same word saved as the
// product's own name or alias, so two products that are both "rice" stay a question, not a pick.
const STAPLE_WEIGHT = 0.9;

/**
 * rankByName for products, where a product also answers to the everyday names of the staple it
 * is: "Rice" matches "akki". The product's own name and aliases still count most.
 */
export function rankProducts<T extends { name: string; aliases: string[] }>(query: string, products: T[], threshold = 0.6): Match<T>[] {
  return products
    .map((product) => {
      const own = rankByName(query, [product], 0)[0]?.score ?? 0;
      const staples = staplesFor(product).flat();
      const staple = staples.length ? (rankByName(query, [{ name: staples[0]!, aliases: staples }], 0)[0]?.score ?? 0) * STAPLE_WEIGHT : 0;
      return { item: product, score: Math.max(own, staple) };
    })
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/** True when the top two matches are too close to choose between. */
export function tooClose<T>([best, second]: Match<T>[]): boolean {
  return Boolean(best && second && best.score < 1 && best.score - second.score < 0.1);
}
