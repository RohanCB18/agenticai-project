import { describe, expect, it } from "vitest";
import { billDateIso, billGstSummary, billLineGstTag, checkBillGst, officialRatesByHsn } from "./bill-gst";
import type { Bill } from "./bills";
import { entryHsnCodes, type GstPassage, type KnowledgeBase } from "./knowledge";

const source = { id: "ctr-09-2025", title: "Notification No. 9/2025-Central Tax (Rate)", gsr: "G.S.R. 641(E)", dated: "2025-09-17", effectiveFrom: "2025-09-22", url: "https://example.test/09_2025-CTR.pdf" };

function entry(id: string, hsn: string, gst: number, sno: string, description = "goods"): GstPassage {
  const where = gst === 0 ? `S. No. ${sno} of Notification No. 2/2017-Central Tax (Rate)` : `Schedule I, S. No. ${sno} of Notification No. 9/2025-Central Tax (Rate)`;
  return { id, kind: gst === 0 ? "exempt" : "rate", hsn, description, gst, content: `${description}. HSN ${hsn}. GST ${gst}%. ${where}, in force from 22 September 2025.`, sources: [source] };
}

// Pulses: exempt loose, 5% pre-packaged. Soap: a broad heading at 18%. Searches return entries by
// code, plus an unrelated one, as a real hybrid search can.
const PULSES_LOOSE = entry("e:pulses", "0713", 0, "45", "Dried leguminous vegetables, other than pre-packaged and labelled");
const PULSES_PACKED = entry("r:pulses", "0713 10, 0713 20", 5, "46", "Dried leguminous vegetables, pre-packaged and labelled");
const RICE_PACKED = entry("r:rice", "1006", 5, "60", "Rice, pre-packaged and labelled");
const SOAP = entry("r:soap", "3401", 18, "300", "Soap; organic surface-active products");
const UNRELATED = entry("r:horses", "0101 21 00", 5, "1", "Live horses");

function fakeKnowledge(byCode: Record<string, GstPassage[]>): KnowledgeBase & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async searchGst(query) {
      queries.push(query);
      const code = query.split(" ")[0]!;
      return [...(byCode[code] ?? []), UNRELATED];
    },
  };
}

const bill = (items: Bill["items"], billDate: string | null = "14/11/2026"): Bill => ({ supplierName: "Sharma Traders", billNumber: "A-17", billDate, items, total: null });
const line = (name: string, hsn: string | null, gstRate: number | null, amount = 1000) => ({ name, quantity: 10, unit: "kg", rate: amount / 10, amount, hsn, gstRate });

describe("entryHsnCodes", () => {
  it("reads the codes an entry lists, without chapter-wide ones", () => {
    expect(entryHsnCodes("0101 21 00, 0101 29")).toEqual(["01012100", "010129"]);
    expect(entryHsnCodes("8413 (a) Concrete pumps [8413 40 00]")).toEqual(["8413", "84134000"]);
    expect(entryHsnCodes("28")).toEqual([]);
    expect(entryHsnCodes(null)).toEqual([]);
  });
});

describe("billDateIso", () => {
  it("reads Indian bill dates, day first", () => {
    expect(billDateIso("14/11/2026")).toBe("2026-11-14");
    expect(billDateIso("05-09-25")).toBe("2025-09-05");
    expect(billDateIso("12 Oct 2025")).toBe("2025-10-12");
    expect(billDateIso("1st Sept, 2025")).toBe("2025-09-01");
    expect(billDateIso("2025-10-12")).toBe("2025-10-12");
    expect(billDateIso("Nov")).toBeNull();
    expect(billDateIso(null)).toBeNull();
  });
});

describe("checkBillGst", () => {
  const knowledge = fakeKnowledge({ "0713": [PULSES_LOOSE, PULSES_PACKED], "07131000": [PULSES_LOOSE, PULSES_PACKED], "1006": [RICE_PACKED], "3401": [SOAP] });

  it("flags GST above every official rate for the code, citing the entry", async () => {
    const check = await checkBillGst(bill([line("Toor Dal", "0713", 18, 1400)]), knowledge);
    expect(check).toEqual({
      status: "checked",
      checked: 1,
      withoutHsn: 0,
      noEntry: [],
      overcharged: [
        {
          item: "Toor Dal",
          hsn: "0713",
          charged: 18,
          official: 5,
          citation: "Schedule I, S. No. 46 of Notification No. 9/2025-Central Tax (Rate)",
          url: source.url,
          extraRupees: 182,
        },
      ],
    });
  });

  it("accepts the packed rate when loose and packed goods differ, and codes under a heading", async () => {
    const check = await checkBillGst(bill([line("Toor Dal 1kg pouch", "07131000", 5), line("Sona Masoori 25kg", "1006", 5), line("Lux soap", "3401", 18)]), knowledge);
    expect(check).toMatchObject({ status: "checked", checked: 3, overcharged: [] });
  });

  it("ignores search results for other codes, and doesn't guess without an HSN code", async () => {
    const check = await checkBillGst(bill([line("Rajma", null, 18), line("Mystery item", "9999", 18)]), knowledge);
    expect(check).toEqual({ status: "checked", checked: 0, overcharged: [], withoutHsn: 1, noEntry: ["Mystery item"] });
  });

  it("searches once per code, with the item name", async () => {
    const counted = fakeKnowledge({ "0713": [PULSES_PACKED] });
    await checkBillGst(bill([line("Toor Dal", "0713", 5), line("Moong Dal", "0713", 5)]), counted);
    expect(counted.queries).toEqual(["0713 Toor Dal"]);
  });

  it("skips bills without GST, and bills from before the 22 Sep 2025 rates", async () => {
    expect(await checkBillGst(bill([line("Toor Dal", "0713", null)]), knowledge)).toBeNull();
    expect(await checkBillGst(bill([line("Toor Dal", "0713", 18)], "15/08/2025"), knowledge)).toEqual({ status: "before_rate_change", billDate: "15/08/2025" });
  });
});

describe("tagging products from a bill", () => {
  const knowledge = fakeKnowledge({ "0713": [PULSES_LOOSE, PULSES_PACKED], "1006": [RICE_PACKED] });

  it("looks up every printed code, taxed or not, for tagging, even on an old bill", async () => {
    const official = await officialRatesByHsn(bill([line("Toor Dal", "0713", null), line("Rice", "1006", 0), line("Gadget", "9999", 18), line("Jaggery", null, 5)], "15/08/2025"), knowledge);
    expect(Object.keys(official).sort()).toEqual(["0713", "1006", "9999"]);
    expect(official["0713"]!.map((r) => r.rate)).toEqual([5, 0]);
    expect(official["9999"]).toEqual([]);
  });

  it("gives a product the rate only when the official entries agree on one", async () => {
    const official = await officialRatesByHsn(bill([line("Toor Dal", "0713", 5), line("Rice", "1006", 5)]), knowledge);
    expect(billLineGstTag("1006", official)).toEqual({ hsn: "1006", gstRate: 5, citation: "Schedule I, S. No. 60 of Notification No. 9/2025-Central Tax (Rate)" });
    expect(billLineGstTag("0713", official)).toEqual({ hsn: "0713", gstRate: null, citation: null });
    expect(billLineGstTag(null, official)).toEqual({ hsn: null, gstRate: null, citation: null });
    expect(billLineGstTag("1006", null)).toEqual({ hsn: "1006", gstRate: null, citation: null });
  });
});

describe("billGstSummary", () => {
  it("tells the owner what was overcharged and what to do", () => {
    const text = billGstSummary(
      {
        status: "checked",
        checked: 2,
        withoutHsn: 1,
        noEntry: [],
        overcharged: [{ item: "Toor Dal", hsn: "0713", charged: 18, official: 5, citation: "Schedule I, S. No. 46 of Notification No. 9/2025-Central Tax (Rate)", url: null, extraRupees: 182 }],
      },
      "Sharma Traders",
    );
    expect(text).toBe(
      "🔎 GST higher than the official rate on 1 item:\n" +
        "• Toor Dal (HSN 0713): 18% GST charged, official 5%, about ₹182 extra. Schedule I, S. No. 46 of Notification No. 9/2025-Central Tax (Rate)\n" +
        "Ask Sharma Traders for a corrected bill or a credit note, or check with your CA.\n" +
        "Not checked: 1 item without an HSN code.",
    );
  });

  it("confirms a clean bill and says when nothing could be checked", () => {
    expect(billGstSummary({ status: "checked", checked: 3, withoutHsn: 0, noEntry: [], overcharged: [] }, null)).toBe("🔎 GST: all 3 items with an HSN code match the official rates.");
    expect(billGstSummary({ status: "checked", checked: 0, withoutHsn: 2, noEntry: [], overcharged: [] }, null)).toBe("🔎 GST not checked: 2 items without an HSN code.");
    expect(billGstSummary(null, null)).toBe("");
  });
});
