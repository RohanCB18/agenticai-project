import { describe, expect, it } from "vitest";
import { findMentions, mentionsHint, mentionsNote } from "./mentions";

const customers = [
  { name: "Ramesh", aliases: ["ರಮೇಶ್"] },
  { name: "Fatima", aliases: [] },
  { name: "Lakshmi", aliases: [] },
];
const products = [
  { name: "Rice", aliases: [] },
  { name: "Sugar", aliases: [] },
  { name: "Sabun", aliases: [] },
];

describe("findMentions", () => {
  it("knows akki is this shop's rice, not a customer", () => {
    expect(findMentions("Akki eshtu ide", customers, products)).toEqual([{ word: "akki", customers: [], products: ["Rice"] }]);
  });

  it("finds customers and products together, in any script", () => {
    const found = findMentions("ರಮೇಶ್ 2 kg sakkare togondru", customers, products);
    expect(found.map((m) => [m.customers, m.products])).toEqual([
      [["Ramesh"], []],
      [[], ["Sugar"]],
    ]);
  });

  it("ignores everyday words, numbers and loose prefixes", () => {
    expect(findMentions("Kitna udhaar baaki hai sab ka? 450", customers, products)).toEqual([]);
  });
});

describe("notes from mentions", () => {
  it("say what each word is, and admit doubt", () => {
    const found = [
      { word: "akki", customers: [], products: ["Rice"] },
      { word: "lakshmi", customers: ["Lakshmi"], products: ["Lakshmi Rice"] },
    ];
    expect(mentionsNote(found)).toBe(
      'In this shop\'s records, "akki" is the product Rice; "lakshmi" could be the customer Lakshmi or the product Lakshmi Rice. Go by this unless the owner says otherwise.',
    );
    expect(mentionsHint(found)).toContain('"akki" is the product Rice');
    expect(mentionsNote([])).toBeNull();
  });
});
