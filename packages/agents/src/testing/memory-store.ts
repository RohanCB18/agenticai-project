import type { Balance, Customer, KhataStore, LedgerEntry, PaymentLink, Product } from "../store";

/** In-memory KhataStore for tests and evals. Mirrors the Supabase semantics. */
export class MemoryStore implements KhataStore {
  customers: Customer[] = [];
  entries: LedgerEntry[] = [];
  products: Product[] = [];
  links: PaymentLink[] = [];
  auditLog: { action: string; details: Record<string, unknown> }[] = [];
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  async listCustomers() {
    return this.customers;
  }

  async addCustomer(input: Parameters<KhataStore["addCustomer"]>[0]) {
    const c: Customer = { id: this.id("cus"), name: input.name, aliases: input.aliases ?? [], phone: input.phone ?? null, language: input.language ?? null };
    this.customers.push(c);
    return c;
  }

  async addLedgerEntry(input: Parameters<KhataStore["addLedgerEntry"]>[0]) {
    const e: LedgerEntry = {
      id: this.id("led"),
      kind: input.kind,
      amountPaise: input.amountPaise,
      customerId: input.customerId ?? null,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(e);
    return e;
  }

  async balances(customerId?: string): Promise<Balance[]> {
    return this.customers
      .filter((c) => !customerId || c.id === customerId)
      .map((c) => {
        const mine = this.entries.filter((e) => e.customerId === c.id);
        const outstandingPaise = mine.reduce(
          (sum, e) => sum + (e.kind === "credit_given" ? e.amountPaise : e.kind === "payment_received" ? -e.amountPaise : 0),
          0,
        );
        return { customerId: c.id, name: c.name, outstandingPaise, lastCreditAt: null, lastPaymentAt: null };
      });
  }

  async recentEntries(limit: number, customerId?: string) {
    return this.entries.filter((e) => !customerId || e.customerId === customerId).slice(-limit).reverse();
  }

  async listProducts() {
    return this.products;
  }

  async moveStock({ productId, delta }: { productId: string; delta: number; reason: string }) {
    const p = this.products.find((x) => x.id === productId);
    if (!p) throw new Error(`No product ${productId}`);
    p.stockQty += delta;
    return p;
  }

  async createPaymentLink({ amountPaise }: Parameters<KhataStore["createPaymentLink"]>[0]) {
    const link: PaymentLink = { id: this.id("link"), url: `https://payments-test.cashfree.com/links/${this.seq}`, amountPaise, status: "ACTIVE", expiresAt: null };
    this.links.push(link);
    return link;
  }

  async audit(action: string, details: Record<string, unknown>) {
    this.auditLog.push({ action, details });
  }
}
