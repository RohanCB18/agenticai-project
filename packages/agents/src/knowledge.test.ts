import { describe, expect, it } from "vitest";
import { type GstPassage, officialHsn, sameGoods, withOfficialWording } from "./knowledge";

const entry = (description: string): GstPassage => ({ id: description, kind: "rate", hsn: "0713", description, gst: 5, content: description, sources: [] });

describe("withOfficialWording", () => {
  it("adds the official words for dal and pulses, so they don't find jaggery or dal flour", () => {
    for (const query of ["Toor dal", "arhar daal", "pulses, split", "moong", "masoor dal 1kg packet"]) {
      expect(withOfficialWording(query)).toBe(`${query} (dried leguminous vegetables, shelled, split)`);
    }
  });

  it("leaves dal flour, other goods and lookalike words alone", () => {
    for (const query of ["besan", "chana dal flour", "moong dal atta", "sugar", "dalchini cinnamon", "biscuits"]) expect(withOfficialWording(query)).toBe(query);
  });
});

describe("officialHsn", () => {
  const dal = { ...entry("Dried leguminous vegetables, shelled, split"), hsn: "0713" };
  const horses = { ...entry("Live horses"), hsn: "0101 21 00, 0101 29" };

  it("keeps no sub-code finer than the notification lists", () => {
    // Live: "07131000" (the sub-code for peas) for toor dal, where the notification lists 0713.
    expect(officialHsn([dal], "07131000")).toBe("0713");
    expect(officialHsn([dal], "0713")).toBe("0713");
  });

  it("keeps a code the notification lists, or a heading above one", () => {
    expect(officialHsn([horses], "01012100")).toBe("01012100");
    expect(officialHsn([horses], "0101")).toBe("0101");
  });
});

describe("sameGoods", () => {
  it("pairs entries that differ only by packing", () => {
    expect(sameGoods(entry("Rice, pre-packaged and labelled"), entry("Rice, other than pre-packaged and labelled"))).toBe(true);
    expect(
      sameGoods(
        entry("Dried leguminous vegetables, shelled, whether or not skinned or split pre-packaged and labelled; Guar gum refined split"),
        entry("Dried leguminous vegetables, shelled, whether or not skinned or split other than pre-packaged and labelled"),
      ),
    ).toBe(true);
  });

  it("keeps different goods under one code apart", () => {
    expect(sameGoods(entry("Pastry, cakes, biscuits and other bakers' wares"), entry("Khakhra, plain chapatti or roti"))).toBe(false);
    expect(sameGoods(entry("Cane or beet sugar and chemically pure sucrose, in solid form"), entry("Jaggery of all types including Cane Jaggery (gur)"))).toBe(false);
  });
});
