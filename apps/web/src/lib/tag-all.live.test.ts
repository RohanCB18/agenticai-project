import { createKhataAgent, receiptLines, sarvamModel } from "@munshi/agents";
import { completedActions } from "@munshi/agents/receipts";
import { MemoryStore } from "@munshi/agents/testing";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { configuredKnowledge } from "./knowledge";

// "Baaki sab products ka HSN laga do" with real Sarvam and the real GST knowledge base, over the
// products of the shop it was asked in. Off by default: set GST_LIVE=1 with SARVAM_API_KEY and the
// knowledge base's keys (see bill-gst.live.test.ts; point SUPABASE_EMBED_URL at the hosted embed).
const knowledge = process.env.GST_LIVE === "1" ? configuredKnowledge() : undefined;
const key = process.env.SARVAM_API_KEY;

describe.skipIf(!knowledge || !key)("tagging every product at once", () => {
  it("tags the single-rate products, asks about the dal, then tags it", { timeout: 240_000 }, async () => {
    const store = new MemoryStore();
    const product = (name: string, unit: string, extra = {}) => store.products.push({ id: name, name, aliases: [], unit, stockQty: 10, reorderLevel: null, pricePaise: null, ...extra });
    product("Parle G", "box");
    product("Rice", "kg", { hsn: "1006", gstRate: 5, gstCitation: "Schedule I, S. No. 48 of Notification No. 9/2025-Central Tax (Rate)" });
    product("Sugar", "kg");
    product("Sunflower oil", "ltr");
    product("Toor dal", "kg");

    let messages: ModelMessage[] = [];
    const say = async (text: string) => {
      const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "RCB general stores", language: "hi", channel: "app", knowledge });
      messages = [...messages, { role: "user", content: text }];
      const result = await agent.generate({ messages });
      messages = [...messages, ...result.responseMessages];
      const calls = result.steps.flatMap((s) => s.toolCalls.map((c) => `${c.toolName}(${JSON.stringify(c.input)})`));
      console.log(`> ${text}\n  tools: ${calls.join("\n         ") || "-"}\n  receipts: ${receiptLines(completedActions(result.responseMessages)).join(" | ") || "-"}\n  reply: ${result.text.trim()}`);
    };

    await say("Baaki sab products ka HSN laga do");
    const tags = () => Object.fromEntries(store.products.map((p) => [p.name, p.hsn ? `${p.hsn} ${p.gstRate}%` : null]));
    console.log(tags());
    expect(tags()).toMatchObject({ "Parle G": "1905 5%", Rice: "1006 5%", Sugar: "1701 5%", "Sunflower oil": "1512 5%", "Toor dal": null });

    await say("Dal packed hai");
    console.log(tags());
    expect(tags()["Toor dal"]).toBe("0713 5%");
  });

  it("finishes products a bill left with a code and no rate", { timeout: 240_000 }, async () => {
    // The live shop after a supplier bill: codes on everything, rates only where the bill could tell.
    const store = new MemoryStore();
    const product = (name: string, unit: string, hsn: string, gstRate: number | null) =>
      store.products.push({ id: name, name, aliases: [], unit, stockQty: 10, reorderLevel: null, pricePaise: null, hsn, gstRate, gstCitation: null });
    product("Parle G", "box", "1905", null);
    product("Rice", "kg", "1006", 5);
    product("Sugar", "kg", "1701", null);
    product("Sunflower oil", "ltr", "1512", 5);
    product("Toor dal", "kg", "0713", null);

    const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "RCB general stores", language: "hi", channel: "app", knowledge });
    const result = await agent.generate({ messages: [{ role: "user", content: "Baaki sab products ka HSN laga do" }] });
    console.log(`  receipts: ${receiptLines(completedActions(result.responseMessages)).join(" | ")}\n  reply: ${result.text.trim()}`);
    const tags = Object.fromEntries(store.products.map((p) => [p.name, p.gstRate == null ? `${p.hsn} ?` : `${p.hsn} ${p.gstRate}%`]));
    expect(tags).toMatchObject({ "Parle G": "1905 5%", Sugar: "1701 5%", "Toor dal": "0713 ?" });
  });
});
