// Retrieval eval for the GST knowledge: shop questions, each labelled with the official entry (or
// entries) that answer it, read from the notification text, not from search results.
//
// Two splits, so a change is judged on questions it wasn't tuned on:
//   dev   for trying changes and picking weights;
//   test  held out: run it only to report a change that is already decided.
//
// Run from apps/web:  node --env-file=.env.local scripts/eval-knowledge.mjs [--split=dev|test|all] [--verbose]
//   [--weights=1,0.5,2;...] [--corpus=gst-before]  (another build, loaded by ingest-knowledge.mjs)
// (same environment as ingest-knowledge.mjs)

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const url = process.env.KNOWLEDGE_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.KNOWLEDGE_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY;
const embedKey = process.env.SUPABASE_EMBED_KEY;
const embedUrl = process.env.SUPABASE_EMBED_URL ?? `${url}/functions/v1/embed`;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? true : undefined);
const split = arg("split") ?? "dev";
const verbose = Boolean(arg("verbose"));
const corpus = arg("corpus") ?? "gst";
const unprefixed = (id) => (corpus === "gst" ? id : id.replace(`${corpus}:`, ""));

// Queries are written the way the agent searches: a generic English item name, as lookupGst asks,
// except the "owner" group, which is the owner's own word, as an MCP host or a slip might pass it.
// `expect` lists every entry that correctly answers the question: loose and packed rice are both
// right for "rice". Groups: item, hsn (codes read off a bill), owner, definition.
const I = (n) => `ctr-09-2025:I:${n}`;
const II = (n) => `ctr-09-2025:II:${n}`;
const X = (n) => `ctr-10-2025:${n}`; // exemptions
// prettier-ignore
export const CASES = [
  // ---- dev: the first 27, used to build the search
  { split: "dev", group: "item", q: "rice packed in a branded bag", expect: [I(48)] },
  { split: "dev", group: "item", q: "loose wheat flour atta sold unpacked", expect: [X(70)] },
  { split: "dev", group: "item", q: "packaged wheat flour atta", expect: [I(51)] },
  { split: "dev", group: "item", q: "sugar", expect: [I(105)] },
  { split: "dev", group: "item", q: "tea leaves", expect: [I(34)] },
  { split: "dev", group: "item", q: "instant noodles", expect: [I(119)] },
  { split: "dev", group: "item", q: "biscuits", expect: [I(123)] },
  { split: "dev", group: "item", q: "bath soap bar", expect: [I(251)] },
  { split: "dev", group: "item", q: "washing powder detergent", expect: [II(67)] },
  { split: "dev", group: "item", q: "table salt", expect: [X(109)] },
  { split: "dev", group: "item", q: "paneer", expect: [X(17)] },
  { split: "dev", group: "item", q: "fresh milk", expect: [X(15)] },
  { split: "dev", group: "item", q: "ghee", expect: [I(7)] },
  { split: "dev", group: "item", q: "namkeen bhujia snacks", expect: [I(143)] },
  { split: "dev", group: "item", q: "cold drink soft drink with sugar", expect: ["ctr-09-2025:III:1"] },
  { split: "dev", group: "item", q: "aerated drink with added sugar", expect: ["ctr-09-2025:III:1"] },
  { split: "dev", group: "item", q: "pan masala", expect: ["ctr-19-2025:III:14"] },
  { split: "dev", group: "item", q: "beedi biris", expect: ["ctr-19-2025:II:4A"] },
  { split: "dev", group: "item", q: "cigarettes", expect: ["ctr-19-2025:III:16"] },
  { split: "dev", group: "item", q: "curd lassi buttermilk not packed", expect: [X(16)] },
  { split: "dev", group: "item", q: "honey", expect: [X(19)] },
  { split: "dev", group: "item", q: "eggs", expect: [X(18)] },
  { split: "dev", group: "item", q: "vermicelli seviyan", expect: [I(119)] },
  { split: "dev", group: "definition", q: "what does pre-packaged and labelled mean", expect: ["ctr-09-2025:explanation", "ctr-10-2025:explanation"] },
  { split: "dev", group: "hsn", q: "HSN 2402", expect: ["ctr-19-2025:III:16"] },
  { split: "dev", group: "hsn", q: "HSN 1902", expect: [I(119)] },
  { split: "dev", group: "hsn", q: "HSN 2202 10", expect: ["ctr-09-2025:III:1"] },

  // ---- new questions, alternately held out (test) and dev, in the order they were written
  { split: "test", group: "item", q: "loose rice sold from a sack", expect: [X(67)] },
  { split: "dev", group: "item", q: "toor dal arhar packed pulses", expect: [I(20)] },
  { split: "test", group: "item", q: "loose dal lentils not packed", expect: [X(39)] },
  { split: "dev", group: "item", q: "besan gram flour packet", expect: [I(56)] },
  { split: "test", group: "item", q: "suji semolina rava packed", expect: [I(53)] },
  { split: "dev", group: "item", q: "poha flattened rice", expect: [I(121), X(98)] },
  { split: "test", group: "item", q: "mustard oil", expect: [I(91)] },
  { split: "dev", group: "item", q: "sunflower cooking oil", expect: [I(89)] },
  { split: "test", group: "item", q: "groundnut oil", expect: [I(85)] },
  { split: "dev", group: "item", q: "jaggery gur", expect: [I(106), X(96)] },
  { split: "test", group: "item", q: "turmeric powder", expect: [I(42)] },
  { split: "dev", group: "item", q: "red chilli powder", expect: [I(36)] },
  { split: "test", group: "item", q: "cumin seeds jeera", expect: [I(41)] },
  { split: "dev", group: "item", q: "cardamom", expect: [I(40)] },
  { split: "test", group: "item", q: "instant coffee powder", expect: [I(135)] },
  { split: "dev", group: "item", q: "butter", expect: [I(7)] },
  { split: "test", group: "item", q: "cheese", expect: [I(8)] },
  { split: "dev", group: "item", q: "ice cream", expect: [I(141)] },
  { split: "test", group: "item", q: "bread", expect: [X(100)] },
  { split: "dev", group: "item", q: "rusk", expect: [I(124)] },
  { split: "test", group: "item", q: "cake", expect: [I(123)] },
  { split: "dev", group: "item", q: "papad", expect: [X(99)] },
  { split: "test", group: "item", q: "tomato ketchup sauce", expect: [I(139)] },
  { split: "dev", group: "item", q: "fruit jam", expect: [I(131)] },
  { split: "test", group: "item", q: "corn flakes breakfast cereal", expect: [I(122)] },
  { split: "dev", group: "item", q: "almonds cashew dry fruits", expect: [I(23)] },
  { split: "test", group: "item", q: "raisins kishmish", expect: [I(28)] },
  { split: "dev", group: "item", q: "dried dates", expect: [I(26)] },
  { split: "test", group: "item", q: "fresh potatoes", expect: [X(27)] },
  { split: "dev", group: "item", q: "onions and garlic", expect: [X(29)] },
  { split: "test", group: "item", q: "bananas", expect: [X(46)] },
  { split: "dev", group: "item", q: "packaged drinking water bottle", expect: [I(146)] },
  { split: "test", group: "item", q: "packed fruit juice", expect: [I(133)] },
  { split: "dev", group: "item", q: "energy drink with caffeine", expect: ["ctr-09-2025:III:3"] },
  { split: "test", group: "item", q: "condensed milk", expect: [I(4)] },
  { split: "dev", group: "item", q: "toffee candy", expect: [I(110)] },
  { split: "test", group: "item", q: "frozen green peas", expect: [X(36)] },
  { split: "dev", group: "item", q: "agarbatti incense sticks", expect: [I(250)] },
  { split: "test", group: "item", q: "matchbox", expect: [I(256)] },
  { split: "dev", group: "item", q: "candles", expect: [I(253)] },
  { split: "test", group: "item", q: "toothpaste", expect: [I(246)] },
  { split: "dev", group: "item", q: "toothbrush", expect: [I(504)] },
  { split: "test", group: "item", q: "shampoo", expect: [I(245)] },
  { split: "dev", group: "item", q: "hair oil", expect: [I(245)] },
  { split: "test", group: "item", q: "talcum powder", expect: [I(244)] },
  { split: "dev", group: "item", q: "dishwash liquid", expect: [II(67)] },
  { split: "test", group: "item", q: "mosquito repellent coil", expect: [II(95)] },
  { split: "dev", group: "item", q: "sanitary pads", expect: [X(165)] },
  { split: "test", group: "item", q: "baby diapers", expect: [I(507)] },
  { split: "dev", group: "item", q: "tissue paper", expect: [II(184)] },
  { split: "test", group: "item", q: "school notebook", expect: [X(130)] },
  { split: "dev", group: "item", q: "AA batteries", expect: [II(479)] },
  { split: "test", group: "item", q: "plastic bucket", expect: [II(125)] },
  { split: "dev", group: "item", q: "steel utensils", expect: [I(416)] },
  { split: "test", group: "item", q: "domestic LPG gas cylinder", expect: [I(208), I(209)] },
  { split: "dev", group: "item", q: "betel leaves paan", expect: [X(93)] },
  { split: "test", group: "item", q: "supari areca nut", expect: [I(23)] },
  { split: "dev", group: "item", q: "gutkha chewing tobacco", expect: ["ctr-19-2025:III:17"] },
  { split: "test", group: "item", q: "chocolate", expect: [I(116)] },
  { split: "dev", group: "item", q: "kumkum bindi", expect: [X(117)] },
  { split: "test", group: "item", q: "broom", expect: [I(503), X(162)] },
  { split: "test", group: "hsn", q: "HSN 3305", expect: [I(245), II(62)] },
  { split: "dev", group: "hsn", q: "HSN 0402", expect: [I(4)] },
  { split: "test", group: "hsn", q: "HSN 3306 10 10", expect: [I(247)] },
  { split: "dev", group: "hsn", q: "HSN 1905 40 00", expect: [I(124)] },
  { split: "test", group: "hsn", q: "HSN 9619", expect: [I(507), X(165)] },
  { split: "test", group: "owner", q: "atta", expect: [I(51), X(70)] },
  { split: "dev", group: "owner", q: "chawal", expect: [I(48), X(67)] },
  { split: "test", group: "owner", q: "haldi", expect: [I(42), X(61)] },
  { split: "dev", group: "owner", q: "cheeni", expect: [I(105)] },
  { split: "test", group: "owner", q: "namak", expect: [X(109)] },
  { split: "dev", group: "owner", q: "doodh", expect: [X(15)] },
  { split: "test", group: "owner", q: "dahi", expect: [I(5), X(16)] },
  { split: "dev", group: "owner", q: "sabun", expect: [I(251)] },
  { split: "test", group: "definition", q: "what is a unit container", expect: ["ctr-09-2025:explanation", "ctr-10-2025:explanation"] },
];

// [semantic_weight, keyword_weight, hsn_weight]. The app uses SEARCH_WEIGHTS from src/lib/knowledge.ts.
// --weights=1,0.5,2;1,0.25,2 compares other mixes instead.
const MODES = arg("weights")
  ? Object.fromEntries(String(arg("weights")).split(";").map((w) => [`weights ${w}`, w.split(",").map(Number)]))
  : {
      keyword: [0, 1, 0],
      vector: [1, 0, 0],
      "vector + keyword": [1, 1, 0],
      "vector + keyword + HSN": [1, 1, 2],
      "vector + keyword/4 + HSN (used)": [1, 0.25, 2],
    };

async function embed(texts) {
  const vectors = [];
  // The embed function takes at most 8 texts per request.
  for (let i = 0; i < texts.length; i += 6) {
    const response = await fetch(embedUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-embed-key": embedKey },
      body: JSON.stringify({ input: texts.slice(i, i + 6) }),
    });
    if (!response.ok) throw new Error(`embed failed: ${response.status} ${await response.text()}`);
    vectors.push(...(await response.json()).embeddings);
  }
  return vectors;
}

// Every label must name a real entry, or a typo would read as a retrieval miss.
const ids = new Set(
  (await readFile(new URL("../../../knowledge/gst/chunks.jsonl", import.meta.url), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).id),
);
const unknown = CASES.flatMap((c) => c.expect).filter((id) => !ids.has(id));
if (unknown.length) throw new Error(`labels that aren't entries: ${unknown.join(", ")}`);

const cases = CASES.filter((c) => split === "all" || c.split === split);
const db = createClient(url, secret, { auth: { persistSession: false } });
const vectors = await embed(cases.map((c) => c.q));
const DEPTH = 10;

const pct = (n, d) => `${n}/${d}`;
const report = {};
for (const [mode, [sw, kw, hw]] of Object.entries(MODES)) {
  let top1 = 0;
  let top5 = 0;
  let rr = 0;
  const byGroup = {};
  const lines = [];
  for (const [i, c] of cases.entries()) {
    const { data, error } = await db.rpc("match_knowledge", {
      query_embedding: JSON.stringify(vectors[i]),
      query_text: c.q,
      match_count: DEPTH,
      corpus_name: corpus,
      semantic_weight: sw,
      keyword_weight: kw,
      hsn_weight: hw,
    });
    if (error) throw new Error(error.message);
    for (const row of data) row.id = unprefixed(row.id);
    const rank = data.findIndex((row) => c.expect.includes(row.id));
    const g = (byGroup[c.group] ??= { n: 0, top5: 0 });
    g.n++;
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 5) {
      top5++;
      g.top5++;
    }
    if (rank >= 0) rr += 1 / (rank + 1);
    if (rank !== 0) lines.push(`  ${rank < 0 ? "miss" : `#${rank + 1}  `} ${c.q} -> ${data.slice(0, 2).map((r) => r.id).join(", ")}`);
  }
  report[mode] = {
    top1: pct(top1, cases.length),
    top5: pct(top5, cases.length),
    mrr: Number((rr / cases.length).toFixed(3)),
    groups: Object.fromEntries(Object.entries(byGroup).map(([k, v]) => [k, pct(v.top5, v.n)])),
    ...(verbose ? { notFirst: lines } : {}),
  };
}

console.log(`corpus: ${corpus}, split: ${split} (${cases.length} questions); top1 and top5 count questions whose answer ranks 1st or in the first 5; MRR over the first ${DEPTH}`);
for (const [mode, r] of Object.entries(report)) {
  console.log(`${mode.padEnd(26)} top1 ${r.top1.padEnd(6)} top5 ${r.top5.padEnd(6)} MRR ${r.mrr.toFixed(3)}   ${Object.entries(r.groups).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (verbose) console.log(r.notFirst.join("\n"));
}
