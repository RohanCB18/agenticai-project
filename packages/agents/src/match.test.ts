import { describe, expect, it } from "vitest";
import { normalise, rankByName } from "./match";

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
  });
});
