import { expect, it } from "vitest";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { completedActions, receiptLines } from "../src/receipts";
import { MemoryStore } from "../src/testing/memory-store";
import { detectLanguage, synthesize, transcribe } from "../src/voice";

// A Kannada voice note, end to end, with nobody speaking: Bulbul says the owner's words, Saaras
// hears them as a Telegram voice note would be heard (biased to the shop's names), Munshi acts,
// and Bulbul speaks the reply. Checks what was heard, what was saved and that the reply has audio.
//   npm run eval -w @munshi/agents -- voice-kannada     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;

async function shop() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh", phone: "9999999999" });
  const fatima = await store.addCustomer({ name: "Fatima", phone: "9999999998" });
  await store.addPastEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id }, 3);
  await store.addPastEntry({ kind: "credit_given", amountPaise: 50000, customerId: fatima.id }, 3);
  store.products.push({ id: "rice", name: "Rice", aliases: [], unit: "kg", stockQty: 50, reorderLevel: 10, pricePaise: null });
  return store;
}

const owes = (store: MemoryStore, i: number) =>
  store.entries.filter((e) => e.customerId === store.customers[i]!.id).reduce((sum, e) => sum + (e.kind === "credit_given" ? e.amountPaise : -e.amountPaise), 0);

const CASES = [
  { said: "ರಮೇಶ್ ನಾನೂರ ಐವತ್ತು ರೂಪಾಯಿ ಸಾಮಾನು ತಗೊಂಡ", tool: "recordCredit", check: (s: MemoryStore) => expect(owes(s, 0)).toBe(90000) },
  { said: "ಫಾತಿಮಾ ಇನ್ನೂರು ರೂಪಾಯಿ ಕೊಟ್ರು", tool: "recordPayment", check: (s: MemoryStore) => expect(owes(s, 1)).toBe(30000) },
  { said: "ಅಕ್ಕಿ ಎಷ್ಟು ಕೆಜಿ ಇದೆ?", tool: "getStock", check: () => {} },
];

for (const c of CASES) {
  it.skipIf(!key)(c.said, { timeout: 180_000 }, async () => {
    const store = await shop();
    const voiceNote = await synthesize({ apiKey: key!, text: c.said, languageCode: "kn-IN", codec: "wav" });
    const heard = await transcribe({
      apiKey: key!,
      audio: new Blob([new Uint8Array(voiceNote)], { type: "audio/wav" }),
      filename: "note.wav",
      keyterms: [...store.customers.map((x) => x.name), ...store.products.map((p) => p.name)],
    });
    const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "Ganesh Stores", language: "kn", channel: "telegram", detectLanguage: (text) => detectLanguage({ apiKey: key!, text }) });
    const result = await agent.generate({ messages: [{ role: "user", content: heard.transcript }] });
    const called = result.steps.flatMap((s) => s.toolCalls.map((call) => call.toolName));
    const reply = result.text.trim();
    const spoken = await synthesize({ apiKey: key!, text: reply, languageCode: heard.languageCode ?? "kn-IN", codec: "mp3" });
    console.log(
      `said:   ${c.said}\nheard:  ${heard.transcript} (${heard.languageCode})\ntools:  ${called.join(", ")}\nsaved:  ${receiptLines(completedActions(result.responseMessages)).join(" | ") || "-"}\nreply:  ${reply}\nspoken: ${spoken.length} bytes of mp3`,
    );
    expect(heard.languageCode).toBe("kn-IN");
    expect(called).toContain(c.tool);
    c.check(store);
    expect(reply).toMatch(/[ಀ-೿]/);
    expect(spoken.length).toBeGreaterThan(1000);
  });
}
