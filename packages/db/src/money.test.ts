import { describe, expect, it } from "vitest";
import { formatINR, paiseToRupees, rupeesToPaise } from "./money";

describe("money", () => {
  it("converts rupees to paise without float drift", () => {
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise(450)).toBe(45000);
  });

  it("round-trips", () => {
    expect(paiseToRupees(rupeesToPaise(1234.56))).toBe(1234.56);
  });

  it("formats with Indian digit grouping", () => {
    expect(formatINR(12345600)).toBe("₹1,23,456");
  });

  it("rejects non-finite input", () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
  });
});
