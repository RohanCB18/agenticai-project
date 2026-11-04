import { describe, expect, it } from "vitest";
import { normalise, phoneticKey, rankByName, romanise } from "./match";

const people = [
  { name: "Ramesh", aliases: ["ರಮೇಶ್"] },
  { name: "Ramesh Kumar", aliases: [] },
  { name: "Fatima", aliases: ["Fatima aunty"] },
];

describe("name matching", () => {
  it("strips honorifics", () => {
    expect(normalise("Ramesh Bhaiya!")).toBe("ramesh");
  });

  it("matches Kannada script aliases", () => {
    expect(rankByName("ರಮೇಶ್", people)[0]?.item.name).toBe("Ramesh");
  });

  it("tolerates speech-to-text typos", () => {
    expect(rankByName("fathima", people)[0]?.item.name).toBe("Fatima");
  });

  it("returns nothing for unknown names", () => {
    expect(rankByName("Suresh", people)).toHaveLength(0);
    expect(rankByName("सुरेश", people)).toHaveLength(0);
  });
});

describe("cross-script matching", () => {
  // Stored in Latin only, with no hand-typed aliases.
  const khata = [
    { name: "Ramesh", aliases: [] },
    { name: "Ramesh Kumar", aliases: [] },
    { name: "Fatima", aliases: [] },
    { name: "Anand", aliases: [] },
    { name: "Lakshmi", aliases: [] },
  ];

  it.each([
    ["रमेश", "ramesh"],
    ["ರಮೇಶ್", "ramesh"],
    ["ரமேஷ்", "ramesh"],
    ["রমেশ", "ramesh"],
    ["రమేష్", "ramesh"],
    ["आनंद", "aanand"],
    ["फ़ातिमा", "faatimaa"],
    ["ಲಕ್ಷ್ಮಿ", "lakshmi"],
    ["Ramesh 450", "Ramesh 450"],
  ])("romanises %s", (input, expected) => {
    expect(romanise(input)).toBe(expected);
  });

  it.each([
    ["रमेश", "Ramesh"],
    ["ರಮೇಶ್ ಅಣ್ಣ", "Ramesh"],
    ["रमेश भैया", "Ramesh"],
    ["ரமேஷ்", "Ramesh"],
    ["রমেশ", "Ramesh"],
    ["फातिमा आंटी", "Fatima"],
    ["ಫಾತಿಮಾ", "Fatima"],
    ["आनंद", "Anand"],
    ["ಆನಂದ್", "Anand"],
    ["लक्ष्मी", "Lakshmi"],
    ["রমেশ কুমার", "Ramesh Kumar"],
  ])("finds %s as %s", (spoken, stored) => {
    expect(rankByName(spoken, khata)[0]?.item.name).toBe(stored);
  });

  it("gives an exact cross-script match full confidence, so it isn't flagged ambiguous", () => {
    const [best, second] = rankByName("रमेश", khata);
    expect(best).toMatchObject({ item: { name: "Ramesh" }, score: 1 });
    expect(second?.item.name).toBe("Ramesh Kumar");
  });

  it("treats spelling variants as the same sound", () => {
    expect(phoneticKey("Lakshmi")).toBe(phoneticKey("Laxmi"));
    expect(phoneticKey("Fathima")).toBe(phoneticKey("Fatima"));
    expect(phoneticKey("doodh")).toBe(phoneticKey("दूध"));
  });
});
