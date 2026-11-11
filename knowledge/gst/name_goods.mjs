// Document expansion for GST search: asks sarvam-105b for the everyday names shopkeepers use for
// the goods in each entry ("red chilli powder", "mirchi" for "fruits of the genus Capsicum"), and
// saves them to common_names.json. build_chunks.py adds them to each entry's search text only; the
// agent still quotes the official text. Every entry is named the same way, by the model, so the
// names can't be tuned to the eval's questions.
//
// Run from the repo root:  node --env-file=apps/web/.env.local knowledge/gst/name_goods.mjs
// then the same with --hindi: asked for English and Hindi together, the model mostly gave English
// ("rice", never "chawal"), so a second pass asks only for the Hindi names of entries it named.
// Resumable: entries already named are skipped. Delete common_names.json to start over.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url);
const OUT = new URL("common_names.json", HERE);
const MODEL = "sarvam-105b";
const BATCH = 10; // with 25 an entry, the model skimmed: pulses and matches came back with no names
const PARALLEL = 2;
const MAX_NAMES = 8;
const PROMPT_VERSION = 2;
const HINDI_PROMPT_VERSION = 1;
const HINDI = process.argv.includes("--hindi");

const key = process.env.SARVAM_API_KEY;
if (!key) {
  console.error("Set SARVAM_API_KEY (run with --env-file=apps/web/.env.local).");
  process.exit(1);
}

const chunks = readFileSync(new URL("chunks.jsonl", HERE), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((c) => c.kind === "rate" || c.kind === "exempt");

const saved = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const names = saved?.promptVersion === PROMPT_VERSION ? saved.names : {};
const hindi = saved?.hindiPromptVersion === HINDI_PROMPT_VERSION ? (saved.hindi ?? {}) : {};
if (HINDI && Object.keys(names).length === 0) {
  console.error("Run the English pass first (without --hindi).");
  process.exit(1);
}
// The Hindi pass covers the entries that got English names: the rest are industrial goods.
const target = HINDI ? hindi : names;
const todo = chunks.filter((c) => !(c.id in target) && (!HINDI || names[c.id]?.length));
console.log(`${HINDI ? "Hindi pass" : "English pass"}: ${todo.length} entries to name`);

const SYSTEM = "You help a search engine for India's GST rate notifications match the words shopkeepers and customers use.";

function hindiPrompt(batch) {
  const lines = batch.map((c) => `${c.id} | ${c.description.slice(0, 300)} | ${names[c.id].join(", ")}`);
  return `Below are entries from India's GST rate notifications, one per line as "id | goods description | English names".

For each entry, give the names Indian shopkeepers and customers use for these goods in Hindi, written in English letters, most common first, including common Hinglish forms. The kind of answer wanted: chickpeas gives chana, spinach gives palak, cloves gives laung, mustard seeds gives rai.

Rules:
- Only goods the entry really covers.
- At most 6 short names per entry, lowercase, no English words.
- If Hindi speakers just use the English word, or there is no Hindi name, give [].

Reply with JSON only, an object from each id to its list of names, covering every id below.

${lines.join("\n")}`;
}

function prompt(batch) {
  const lines = batch.map((c) => `${c.id} | ${(c.heading ? `${c.description}. ${c.heading}` : c.description).slice(0, 400)}`);
  return `Below are entries from India's GST rate notifications, one per line as "id | goods description".

For each entry, list the names a kirana shopkeeper or customer in India would use for the goods it covers, most common first:
- the plain everyday English name of each item (chickpeas, spinach, cloves, mustard seeds);
- the Hindi name written in English letters wherever shopkeepers use one (chana, palak, laung, rai).

Rules:
- Only goods the entry really covers. If it says "other than X", do not list X.
- Packed and loose goods have the same names: don't add "packed" or "loose".
- A brand name only if Indians use it as the everyday word for the item (like Maggi for instant noodles).
- At most ${MAX_NAMES} short names per entry, lowercase.
- Never leave an entry empty if a shop or household buys those goods. Only industrial or technical goods with no everyday name get [].

Reply with JSON only, an object from each id to its list of names, covering every id below.

${lines.join("\n")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(batch, attempt = 1) {
  const response = await fetch("https://api.sarvam.ai/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "api-subscription-key": key },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: HINDI ? hindiPrompt(batch) : prompt(batch) },
      ],
      // With reasoning on, sarvam-105b spent the whole token budget thinking and returned nothing.
      reasoning_effort: "none",
      temperature: 0.2,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
  if (!response.ok) {
    // Sarvam rate-limits bursts: back off and retry.
    if (attempt < 6 && (response.status === 0 || response.status === 429 || response.status >= 500)) {
      await sleep(5000 * attempt);
      return ask(batch, attempt + 1);
    }
    throw new Error(`sarvam ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const content = (await response.json()).choices?.[0]?.message?.content ?? "";
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  try {
    return JSON.parse(json);
  } catch {
    if (attempt < 3) return ask(batch, attempt + 1);
    throw new Error(`not JSON: ${content.slice(0, 200)}`);
  }
}

const sorted = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })));

function save() {
  const out = { model: MODEL, promptVersion: PROMPT_VERSION, names: sorted(names), hindiPromptVersion: HINDI_PROMPT_VERSION, hindi: sorted(hindi) };
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
}

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
let done = 0;
// Two requests at a time; Sarvam rate-limits bigger bursts.
async function worker() {
  for (let batch = batches.shift(); batch; batch = batches.shift()) {
    const reply = await ask(batch);
    for (const c of batch) {
      const list = Array.isArray(reply[c.id]) ? reply[c.id] : [];
      target[c.id] = [...new Set(list.filter((n) => typeof n === "string").map((n) => n.trim().toLowerCase()).filter((n) => n && n.length <= 40))].slice(0, MAX_NAMES);
    }
    save();
    done += batch.length;
    if (done % 100 < BATCH) console.log(`${done}/${todo.length} named`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
save();
console.log("done");
