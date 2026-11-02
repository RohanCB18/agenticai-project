// Resolves spoken names ("ramesh bhaiya", "ರಮೇಶ್", "doodh") to records.

const HONORIFICS = /\b(bhaiya|bhai|anna|akka|amma|aunty|uncle|ji|sir|madam|saab|sahab|garu|avare)\b/giu;

export function normalise(text: string): string {
  return text
    .toLocaleLowerCase("en-IN")
    .normalize("NFC")
    .replace(HONORIFICS, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length]!;
}

/** 1 = exact, 0 = unrelated. Handles prefixes ("ram" vs "ramesh") and small typos from speech-to-text. */
function similarity(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (candidate.startsWith(query) || query.startsWith(candidate)) return 0.85;
  if (candidate.split(" ").includes(query)) return 0.8;
  const distance = levenshtein(query, candidate);
  return Math.max(0, 1 - distance / Math.max(query.length, candidate.length));
}

export type Match<T> = { item: T; score: number };

export function rankByName<T extends { name: string; aliases: string[] }>(query: string, items: T[], threshold = 0.6): Match<T>[] {
  const q = normalise(query);
  return items
    .map((item) => ({
      item,
      score: Math.max(...[item.name, ...item.aliases].map((n) => similarity(q, normalise(n)))),
    }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
