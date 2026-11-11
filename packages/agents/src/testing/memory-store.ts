import type { Balance, Customer, KhataStore, LedgerEntry, Memory, PaymentCheck, PaymentLink, PaymentQr, Product } from "../store";
import type { SupplierOrder } from "../supplier";

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

  async updateCustomer(customerId: string, changes: Parameters<KhataStore["updateCustomer"]>[1]) {
    const customer = this.customers.find((c) => c.id === customerId);
    if (!customer) throw new Error(`No customer ${customerId}`);
    Object.assign(customer, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
    return customer;
  }

  /** Back-dates an entry, for tests about history over time. */
  async addPastEntry(input: Parameters<KhataStore["addLedgerEntry"]>[0], daysAgo: number) {
    const entry = await this.addLedgerEntry(input);
    entry.createdAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    // Keep the ledger in time order, as the database returns it.
    this.entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return entry;
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
        // Like the customer_balances view: the latest credit and payment, or null.
        const latest = (kind: string) => mine.filter((e) => e.kind === kind).map((e) => e.createdAt).sort().at(-1) ?? null;
        return { customerId: c.id, name: c.name, outstandingPaise, lastCreditAt: latest("credit_given"), lastPaymentAt: latest("payment_received") };
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
    const link: PaymentLink = { id: this.id("link"), url: `https://payments-test.cashfree.com/links/${this.seq}`, amountPaise, status: "ACTIVE", expiresAt: null, customerNotified: false };
    this.links.push(link);
    return link;
  }

  qrFails = false;
  qrs: PaymentQr[] = [];
  nextCheck: PaymentCheck = { paidPaise: 0, stillOpen: 0 };

  async createPaymentQr({ amountPaise }: Parameters<KhataStore["createPaymentQr"]>[0]) {
    if (this.qrFails) throw new Error("Cashfree can't issue QRs on this account");
    const qr: PaymentQr = { id: this.id("qr"), amountPaise, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() };
    this.qrs.push(qr);
    return qr;
  }

  async checkPayments() {
    return this.nextCheck;
  }

  facts: Memory[] = [];

  async remember({ fact, customerId }: { fact: string; customerId?: string }) {
    const memory: Memory = { id: this.id("mem"), fact, customerId: customerId ?? null, createdAt: new Date().toISOString() };
    this.facts.push(memory);
    return memory;
  }

  async memories(customerId: string | null) {
    return this.facts.filter((m) => m.customerId === customerId);
  }

  async forget(memoryId: string) {
    const before = this.facts.length;
    this.facts = this.facts.filter((m) => m.id !== memoryId);
    return this.facts.length < before;
  }

  async audit(action: string, details: Record<string, unknown>) {
    this.auditLog.push({ action, details });
  }

  async setReorderLevel(productId: string, level: number | null) {
    const product = this.products.find((p) => p.id === productId);
    if (!product) throw new Error(`No product ${productId}`);
    product.reorderLevel = level;
    return product;
  }

  supplierOrders: (SupplierOrder & { quoteId: string })[] = [];

  async saveSupplierOrder(order: SupplierOrder & { quoteId: string }) {
    if (!this.supplierOrders.some((o) => o.supplier === order.supplier && o.orderId === order.orderId)) this.supplierOrders.push(order);
  }
}
