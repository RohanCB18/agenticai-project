import type { ModelMessage } from "ai";

// Restocking from a wholesaler's own agent, over A2A. Munshi asks for a quote, shows it to the
// owner, and orders only after the owner says yes. The wholesaler's agent prices everything and
// signs the quote; Munshi never invents a price.

export type SupplierLine = {
  item: string;
  quantity: number;
  unit: string;
  amount: string;
  /** The line's amount in paise, as the wholesaler priced it. */
  amountPaise?: number;
  /** The name Munshi asked for, which this line answers. */
  requested?: string;
  packs?: number;
  pack?: string;
  unitPrice?: string;
  note?: string;
};

export type SupplierQuote = {
  supplier: string;
  lines: SupplierLine[];
  unavailable: { requested: string; item?: string; reason: string }[];
  total: string;
  totalPaise: number;
  discount: string | null;
  minimumOrder: string;
  meetsMinimum: boolean;
  deliverySlot: string;
  payment: string;
  validUntil: string;
  /** Signed by the wholesaler. Absent when nothing could be quoted. */
  quoteId?: string;
};

export type SupplierOrder = {
  supplier: string;
  orderId: string;
  lines: SupplierLine[];
  total: string;
  totalPaise: number;
  deliverySlot: string;
  payment: string;
};

export type QuoteRequestItem = { name: string; quantity: number; unit?: string };

/** Where an order is, by the wholesaler's word: on its way, or delivered with its delivery note (the invoice, as data). */
export type SupplierDelivery =
  | { status: "on_the_way"; supplier: string; orderId: string; expectedAt: string; deliverySlot: string }
  | { status: "delivered"; supplier: string; orderId: string; invoiceNo: string; lines: SupplierLine[]; total: string; totalPaise: number; deliveredAt: string };

/** A wholesaler Munshi can reorder from. In the app, an A2A client for the wholesaler's agent. */
export interface SupplierAgent {
  readonly name: string;
  quote(items: QuoteRequestItem[], shopName: string): Promise<SupplierQuote>;
  order(quoteId: string): Promise<SupplierOrder>;
  /** Tracks an order placed from a quote: when it arrives, and the delivery note once it has. */
  delivery?(order: { orderId: string; quoteId: string; orderedAt: string }): Promise<SupplierDelivery>;
  /** Asks the wholesaler's order desk something in words; its answer, and a quote if it made one. */
  ask?(question: string, shopName: string): Promise<{ answer: string; quote?: SupplierQuote }>;
}

/** The wholesaler refused (expired quote, below its minimum) or couldn't be reached. */
export class SupplierError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupplierError";
  }
}

export type QuoteContents = { lines: SupplierLine[]; total: string; deliverySlot: string; expiresAt: Date };

/**
 * What a quote id says, for showing the owner before they approve an order. The id is a JWT the
 * wholesaler signed: anyone can read it, only the wholesaler can verify it, and the wholesaler
 * accepts exactly what it says. So the approval shows what will really be ordered, not a summary
 * the model wrote. Returns null for anything that isn't a readable quote.
 */
export function readQuote(quoteId: string): QuoteContents | null {
  const payload = quoteId.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      lines?: SupplierLine[];
      total?: string;
      deliverySlot?: string;
      exp?: number;
    };
    if (!Array.isArray(claims.lines) || typeof claims.total !== "string" || typeof claims.exp !== "number") return null;
    return { lines: claims.lines, total: claims.total, deliverySlot: claims.deliverySlot ?? "", expiresAt: new Date(claims.exp * 1000) };
  } catch {
    return null;
  }
}

/** The quote id from the latest successful askSupplierQuote in the conversation, if any. */
const QUOTING_TOOLS = new Set(["askSupplierQuote", "askWholesaler"]);

export function latestQuoteId(messages: ModelMessage[]): string | null {
  let found: string | null = null;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      // A quote from askSupplierQuote, or one the wholesaler's desk made while answering askWholesaler.
      if (part.type !== "tool-result" || !QUOTING_TOOLS.has(part.toolName) || part.output.type !== "json") continue;
      const output = part.output.value as { status?: string; quoteId?: string } | null;
      if (output?.status === "quoted" && typeof output.quoteId === "string") found = output.quoteId;
    }
  }
  return found;
}

/** One line per item, as the owner reads it: "Sona Masoori Rice: 25 kg, ₹1,300". */
export function quoteLines(lines: SupplierLine[]) {
  return lines.map((line) => `• ${line.item}: ${line.quantity} ${line.unit}, ${line.amount}`);
}
