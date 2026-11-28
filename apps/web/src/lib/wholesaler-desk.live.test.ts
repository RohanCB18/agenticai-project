import { describe, expect, it } from "vitest";
import { createA2ASupplier } from "./supplier";

// Munshi asking the wholesaler's order desk a question over A2A, answered by Sarvam on the
// wholesaler's side. DESK_LIVE=1 with WHOLESALER_URL pointing at a wholesaler that has
// SARVAM_API_KEY (e.g. services/distributor under uvicorn on 127.0.0.1:8102). No order is placed.

const url = process.env.WHOLESALER_URL ?? "http://127.0.0.1:8102";

describe.skipIf(process.env.DESK_LIVE !== "1")("the wholesaler's order desk, over A2A", () => {
  it("answers a question in words, with a signed quote when it priced something", { timeout: 60_000 }, async () => {
    const supplier = createA2ASupplier(url);
    const started = Date.now();
    const { answer, quote } = await supplier.ask!("11 Maggi chahiye. Minimum se kam hai to kya add karun? Ghee bhi hai kya?", "Live test shop");
    console.info(`${((Date.now() - started) / 1000).toFixed(1)} s\n${answer}\nquote: ${quote?.total ?? "none"}`);
    expect(answer.length).toBeGreaterThan(20);
    expect(answer).not.toMatch(/eyJ[\w.-]{8,}/); // quote ids travel as data, not in the words
    if (quote) expect(quote.quoteId).toBeTruthy();
  });
});
