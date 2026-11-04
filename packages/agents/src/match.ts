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

// --- Cross-script matching -------------------------------------------------------------
// Speech-to-text writes names in the script it heard ("रमेश"), while the khata may store
// them in another ("Ramesh"). Brahmic scripts share one Unicode layout, so every script is
// shifted onto Devanagari, romanised, then reduced to a loose phonetic key on both sides.

// Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam: same layout as Devanagari (U+0900).
const BRAHMIC_BLOCKS = [0x0980, 0x0a00, 0x0a80, 0x0b00, 0x0b80, 0x0c00, 0x0c80, 0x0d00];
// Malayalam chillu letters are a consonant with no vowel.
const CHILLU: Record<number, string> = { 0x0d7a: "n", 0x0d7b: "n", 0x0d7c: "r", 0x0d7d: "l", 0x0d7e: "l", 0x0d7f: "k" };

const CONSONANTS: Record<number, string> = {
  0x915: "k", 0x916: "kh", 0x917: "g", 0x918: "gh", 0x919: "n",
  0x91a: "ch", 0x91b: "chh", 0x91c: "j", 0x91d: "jh", 0x91e: "n",
  0x91f: "t", 0x920: "th", 0x921: "d", 0x922: "dh", 0x923: "n",
  0x924: "t", 0x925: "th", 0x926: "d", 0x927: "dh", 0x928: "n", 0x929: "n",
  0x92a: "p", 0x92b: "ph", 0x92c: "b", 0x92d: "bh", 0x92e: "m",
  0x92f: "y", 0x930: "r", 0x931: "r", 0x932: "l", 0x933: "l", 0x934: "zh", 0x935: "v",
  0x936: "sh", 0x937: "sh", 0x938: "s", 0x939: "h",
  0x958: "q", 0x959: "kh", 0x95a: "g", 0x95b: "z", 0x95c: "r", 0x95d: "rh", 0x95e: "f", 0x95f: "y",
};
const NUKTA: Record<string, string> = { k: "q", ph: "f", j: "z", d: "r", dh: "rh" };
const VOWELS: Record<number, string> = {
  0x905: "a", 0x906: "aa", 0x907: "i", 0x908: "ii", 0x909: "u", 0x90a: "uu", 0x90b: "ri", 0x90c: "li",
  0x90d: "e", 0x90e: "e", 0x90f: "e", 0x910: "ai", 0x911: "o", 0x912: "o", 0x913: "o", 0x914: "au",
};
const VOWEL_SIGNS: Record<number, string> = {
  0x93e: "aa", 0x93f: "i", 0x940: "ii", 0x941: "u", 0x942: "uu", 0x943: "ri", 0x944: "rii",
  0x945: "e", 0x946: "e", 0x947: "e", 0x948: "ai", 0x949: "o", 0x94a: "o", 0x94b: "o", 0x94c: "au",
  0x955: "", 0x956: "ai", 0x957: "au",
};
const NASAL_OR_VISARGA: Record<number, string> = { 0x901: "n", 0x902: "n", 0x903: "h" };
const NUKTA_SIGN = 0x93c;
const VIRAMA = 0x94d;

/** Romanises any Brahmic-script text ("रमेश", "ರಮೇಶ್", "ரமேஷ்") to Latin ("ramesh"). Latin passes through. */
export function romanise(text: string): string {
  let out = "";
  let pending: string | null = null; // consonant still waiting to learn its vowel
  const flush = (inherentVowel: boolean) => {
    if (pending !== null) out += pending + (inherentVowel ? "a" : "");
    pending = null;
  };

  for (const ch of text.normalize("NFC")) {
    let cp = ch.codePointAt(0)!;
    if (CHILLU[cp]) {
      flush(true);
      out += CHILLU[cp];
      continue;
    }
    const block = BRAHMIC_BLOCKS.find((b) => cp >= b && cp < b + 0x80);
    if (block !== undefined) cp = cp - block + 0x0900;

    if (CONSONANTS[cp] !== undefined) {
      flush(true);
      pending = CONSONANTS[cp]!;
    } else if (cp === NUKTA_SIGN) {
      if (pending !== null) pending = NUKTA[pending] ?? pending;
    } else if (VOWEL_SIGNS[cp] !== undefined) {
      out += (pending ?? "") + VOWEL_SIGNS[cp];
      pending = null;
    } else if (cp === VIRAMA) {
      flush(false);
    } else if (NASAL_OR_VISARGA[cp] !== undefined) {
      flush(true);
      out += NASAL_OR_VISARGA[cp];
    } else if (VOWELS[cp] !== undefined) {
      flush(true);
      out += VOWELS[cp];
    } else if (cp >= 0x966 && cp <= 0x96f) {
      flush(false);
      out += String(cp - 0x966);
    } else if (cp >= 0x900 && cp < 0x980) {
      // other signs (avagraha, length marks): no sound of their own
    } else {
      // Word boundary or Latin text: a word-final consonant drops its inherent vowel ("रमेश" → "ramesh").
      flush(false);
      out += ch;
    }
  }
  flush(false);
  return out;
}

function soundOf(latin: string): string {
  return latin
    .replace(/ph/g, "f")
    .replace(/sh/g, "s")
    .replace(/([kgcjtdbr])h/g, "$1")
    .replace(/z/g, "j")
    .replace(/w/g, "v")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/([a-z]{2,})a\b/g, "$1"); // "Rama" and "राम" both become "ram"
}

// Honorifics as they sound, so "भैया", "ಅಣ್ಣ" and "aunty" are dropped in any script.
const HONORIFIC_SOUNDS = new Set(
  ["bhaiya", "bhai", "anna", "akka", "amma", "aunty", "aunti", "anti", "uncle", "ankal", "ji", "sir", "madam", "saab", "sahab", "garu", "avare", "didi", "bhabhi"].map(soundOf),
);

/** Loose phonetic key: forgives script, aspiration, vowel length, doubled letters and spelling variants. */
export function phoneticKey(text: string): string {
  return soundOf(romanise(normalise(text)))
    .split(" ")
    .filter((word) => word && !HONORIFIC_SOUNDS.has(word))
    .join(" ");
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
  const qKey = phoneticKey(query);
  return items
    .map((item) => ({
      item,
      // Best of a same-script comparison and a cross-script phonetic one.
      score: Math.max(...[item.name, ...item.aliases].map((n) => Math.max(similarity(q, normalise(n)), similarity(qKey, phoneticKey(n))))),
    }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}
