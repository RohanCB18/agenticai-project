import { describe, expect, it } from "vitest";
import { amountInWords, lastOwnerText } from "./amounts";

describe("amountInWords", () => {
  it("reads the amount the owner named, next to a currency word", () => {
    // Live, twice: Munshi asked "poora 3,900 payment karun?" after this.
    expect(amountInWords("Sharma Traders ko 100 rupaye payment kar do")).toBe(100);
    expect(amountInWords("Sharma ko ₹1,500 bhej do")).toBe(1500);
    expect(amountInWords("pay Rs. 250.50 to Gupta")).toBe(250.5);
    expect(amountInWords("शर्मा को 500 रुपये दे दो")).toBe(500);
    expect(amountInWords("Sharma Traders ge 300 ರೂಪಾಯಿ kodu")).toBe(300);
  });

  it("takes a lone number as the amount", () => {
    expect(amountInWords("Sharma ko 500 de do")).toBe(500);
  });

  it("names no amount when there is none, or it can't tell which", () => {
    expect(amountInWords("Sharma Traders ko payment kar do")).toBeNull();
    expect(amountInWords("Sharma Traders 2 orders ka 300 aur 400 de do")).toBeNull();
    // Codes and names aren't amounts: "Traders 100" isn't "rs 100", "ST-2" isn't ₹2.
    expect(amountInWords("ST-2 wala order pay karo")).toBeNull();
    expect(amountInWords("Sharma Traders 100 de do")).toBe(100);
  });
});

describe("lastOwnerText", () => {
  it("is what the owner said last, past Munshi's replies and tool results", () => {
    expect(
      lastOwnerText([
        { role: "user", content: "Sharma Traders ko payment kar do" },
        { role: "assistant", content: "Kitna?" },
        { role: "user", content: [{ type: "text", text: "100 rupaye" }] },
        { role: "assistant", content: [{ type: "text", text: "Theek hai" }] },
      ]),
    ).toBe("100 rupaye");
    expect(lastOwnerText([])).toBe("");
  });
});
