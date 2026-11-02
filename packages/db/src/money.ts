// All money is stored as integer paise (1 rupee = 100 paise) so sums never drift.

export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new Error(`Invalid amount: ${rupees}`);
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: Paise): number {
  return paise / 100;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** Formats paise in Indian grouping, e.g. 12345600 -> "₹1,23,456". */
export function formatINR(paise: Paise): string {
  return inr.format(paiseToRupees(paise));
}
