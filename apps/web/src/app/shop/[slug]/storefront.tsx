"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { rupees } from "@/lib/counter-bill";
import type { StoreProduct } from "@/lib/online-shop";
import { AISLES, MAX_ORDER_PAISE, orderStep } from "@/lib/shop";
import { placeOrder } from "./actions";

type Cart = Record<string, number>;
type Method = "upi" | "cod";
type LastOrder = { id: string; at: number };
type Buyer = { name: string; phone: string; address: string };

// Each aisle's tint behind its products: translucent, so it reads on light and dark paper.
const HUE: Record<string, number> = { dairy: 205, veg: 125, staples: 38, oil: 18, snacks: 330, drinks: 265, home: 185, care: 295, more: 230 };
const tint = (aisle: string) => ({ background: `hsl(${HUE[aisle] ?? 230} 75% 55% / 0.14)` });

const field = "w-full rounded-xl border border-line bg-surface px-3.5 py-3 text-ink outline-none placeholder:text-muted/70 focus-visible:ring-2 focus-visible:ring-accent";

// Local conveniences: the cart survives a refresh, and a returning customer's details are filled
// in. Kept in memory too, so the store works where the browser blocks storage (private windows).
const memory = new Map<string, string>();
const STORED = "munshi-stored";

function readRaw(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // Blocked storage: memory has it.
  }
  return memory.get(key) ?? null;
}
function load<T>(key: string): T | null {
  try {
    const raw = readRaw(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  const raw = value === null ? null : JSON.stringify(value);
  if (raw === null) memory.delete(key);
  else memory.set(key, raw);
  try {
    if (raw === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, raw);
  } catch {
    // Private windows and blocked storage: memory keeps it for this visit.
  }
  window.dispatchEvent(new Event(STORED));
}
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(STORED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(STORED, onChange);
  };
}
/** A stored value as text; nothing on the server, so its page and the browser's first render agree. */
const useStoredRaw = (key: string) =>
  useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
function parse<T>(raw: string | null): T | null {
  try {
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const stepLabel = (unit: string) => `${orderStep(unit)} ${unit}`;

/**
 * The shop's online store. Every product shows what's on the shelf right now; an order takes its
 * goods out of stock the same way a bill at the counter does, so the owner's stock, and Munshi's
 * restock asks, follow online orders by themselves.
 */
export function Storefront({ slug, shopName, products }: { slug: string; shopName: string; products: StoreProduct[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [aisle, setAisle] = useState("all");
  const [open, setOpen] = useState(false);
  const cartKey = `munshi-cart-${slug}`;
  const lastKey = `munshi-last-order-${slug}`;
  const savedCart = useStoredRaw(cartKey);
  const lastOrder = parse<LastOrder>(useStoredRaw(lastKey));

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const closeCart = useCallback(() => setOpen(false), []);

  // The saved cart, fitted to the shelf as it is now: sold-out goods drop out, and nothing is more than is left.
  const cart = useMemo(() => {
    const fitted: Cart = {};
    for (const [id, quantity] of Object.entries(parse<Cart>(savedCart) ?? {})) {
      const product = byId.get(id);
      if (product && product.most > 0 && quantity > 0) fitted[id] = Math.min(quantity, product.most);
    }
    return fitted;
  }, [savedCart, byId]);

  const change = (product: StoreProduct, by: number) => {
    const step = orderStep(product.unit);
    const next = Math.max(0, Math.min((cart[product.id] ?? 0) + by * step, product.most));
    const updated = { ...cart };
    if (next === 0) delete updated[product.id];
    else updated[product.id] = next;
    save(cartKey, updated);
  };

  const lines = Object.entries(cart).flatMap(([id, quantity]) => {
    const product = byId.get(id);
    return product ? [{ product, quantity }] : [];
  });
  const itemCount = lines.length;
  const totalPaise = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.product.pricePaise), 0);

  const q = query.trim().toLowerCase();
  const shown = products.filter((p) => (aisle === "all" || p.aisle === aisle) && (!q || p.name.toLowerCase().includes(q)));
  const aisles = AISLES.filter((a) => products.some((p) => p.aisle === a.id));
  const sections = q || aisle !== "all" ? null : aisles.map((a) => ({ aisle: a, products: shown.filter((p) => p.aisle === a.id) }));

  return (
    <div className="flex flex-1 flex-col bg-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 pb-2 pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wider text-accent">⚡ Delivery in about 30 minutes</p>
              <h1 className="truncate font-display text-xl font-bold sm:text-2xl">{shopName}</h1>
            </div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={itemCount === 0}
              className="hidden shrink-0 items-center gap-2 rounded-xl bg-accent px-4 py-2.5 font-semibold text-on-accent disabled:opacity-40 sm:flex"
            >
              <span aria-hidden>🛒</span>
              {itemCount === 0 ? "My cart" : `${itemCount} item${itemCount === 1 ? "" : "s"} · ${rupees(totalPaise)}`}
            </button>
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-line bg-paper px-3.5 focus-within:ring-2 focus-within:ring-accent">
            <span aria-hidden className="text-muted">
              🔍
            </span>
            <span className="sr-only">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search for "rice", "maggi", "milk"…'
              className="w-full bg-transparent py-3 text-ink outline-none placeholder:text-muted/70"
              type="search"
            />
          </label>
          <nav className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" aria-label="Aisles">
            {[{ id: "all", name: "All", emoji: "✨" }, ...aisles].map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAisle(a.id)}
                aria-pressed={aisle === a.id}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                  aisle === a.id ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-ink hover:border-accent"
                }`}
              >
                <span aria-hidden>{a.emoji}</span>
                {a.name}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-32 pt-4">
        {lastOrder && (
          <Link
            href={`/shop/${slug}/order/${lastOrder.id}`}
            className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm hover:border-accent"
          >
            <span>
              <span aria-hidden>📦</span> Your last order
            </span>
            <span className="font-semibold text-accent">Track it ›</span>
          </Link>
        )}

        {!q && aisle === "all" && (
          <section className="mb-6 overflow-hidden rounded-3xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-4 p-5 sm:p-6" style={{ background: "linear-gradient(120deg, hsl(230 75% 55% / 0.14), hsl(38 95% 55% / 0.16))" }}>
              <div>
                <p className="font-display text-2xl font-bold leading-tight sm:text-3xl">Your store, at your door</p>
                <p className="mt-1 text-sm text-muted">Straight from the shelves of {shopName} · Free delivery · Pay by UPI or cash</p>
              </div>
              <p className="hidden text-6xl sm:block" aria-hidden>
                🛵
              </p>
            </div>
          </section>
        )}

        {products.length === 0 ? (
          <Empty title="The shelves are empty for now" note="The shop hasn't put anything up yet. Check back soon." />
        ) : shown.length === 0 ? (
          <Empty title={`Nothing called “${query.trim()}” here`} note="Try another word, or look through the aisles." />
        ) : sections ? (
          sections
            .filter((s) => s.products.length > 0)
            .map((s) => (
              <section key={s.aisle.id} className="mb-8">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="font-display text-lg font-semibold">
                    <span aria-hidden>{s.aisle.emoji}</span> {s.aisle.name}
                  </h2>
                  <button type="button" onClick={() => setAisle(s.aisle.id)} className="text-sm font-semibold text-accent">
                    See all
                  </button>
                </div>
                <Grid products={s.products} cart={cart} change={change} />
              </section>
            ))
        ) : (
          <Grid products={shown} cart={cart} change={change} />
        )}
      </main>

      {itemCount > 0 && !open && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 sm:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mx-auto flex w-full max-w-md items-center justify-between rounded-2xl bg-accent px-4 py-3.5 text-on-accent shadow-xl"
          >
            <span className="flex flex-col items-start leading-tight">
              <span className="text-xs opacity-90">
                {itemCount} item{itemCount === 1 ? "" : "s"}
              </span>
              <span className="text-lg font-bold tabular-nums">{rupees(totalPaise)}</span>
            </span>
            <span className="font-semibold">View cart ›</span>
          </button>
        </div>
      )}

      {open && (
        <CartSheet
          slug={slug}
          shopName={shopName}
          lines={lines}
          totalPaise={totalPaise}
          change={change}
          close={closeCart}
          placed={(orderId, payUrl) => {
            save(lastKey, { id: orderId, at: Date.now() });
            save(cartKey, null);
            if (payUrl) window.location.assign(payUrl);
            else router.push(`/shop/${slug}/order/${orderId}`);
          }}
        />
      )}
    </div>
  );
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-20 text-center">
      <p className="text-5xl" aria-hidden>
        🧺
      </p>
      <p className="font-display text-xl font-semibold">{title}</p>
      <p className="text-muted">{note}</p>
    </div>
  );
}

function Grid({ products, cart, change }: { products: StoreProduct[]; cart: Cart; change: (p: StoreProduct, by: number) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} quantity={cart[p.id] ?? 0} change={change} />
      ))}
    </div>
  );
}

function ProductCard({ product, quantity, change }: { product: StoreProduct; quantity: number; change: (p: StoreProduct, by: number) => void }) {
  const soldOut = product.most === 0;
  const few = !soldOut && product.most <= 5 * orderStep(product.unit);
  return (
    <article className="flex flex-col rounded-2xl border border-line bg-surface p-2.5 transition-shadow hover:shadow-md">
      <div className="relative grid aspect-square place-items-center rounded-xl" style={tint(product.aisle)}>
        <span className={`text-5xl sm:text-6xl ${soldOut ? "opacity-40 grayscale" : ""}`} aria-hidden>
          {product.emoji}
        </span>
        {few && <span className="absolute left-1.5 top-1.5 rounded-md bg-amber-500 px-1.5 py-0.5 text-[11px] font-bold text-white">Only {product.most} {product.unit} left</span>}
        {soldOut && <span className="absolute bottom-2 rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-paper">Sold out</span>}
      </div>
      <p className="mt-2 text-xs text-muted">{stepLabel(product.unit)}</p>
      <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-tight">{product.name}</h3>
      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <span className="font-semibold tabular-nums">{rupees(product.pricePaise * orderStep(product.unit))}</span>
        <Stepper product={product} quantity={quantity} change={change} disabled={soldOut} />
      </div>
    </article>
  );
}

function Stepper({ product, quantity, change, disabled }: { product: StoreProduct; quantity: number; change: (p: StoreProduct, by: number) => void; disabled?: boolean }) {
  if (quantity === 0) {
    return (
      <button
        type="button"
        onClick={() => change(product, 1)}
        disabled={disabled}
        aria-label={`Add ${product.name}`}
        className="rounded-lg border-2 border-accent bg-surface px-4 py-1 text-sm font-extrabold text-accent hover:bg-accent hover:text-on-accent disabled:border-line disabled:text-muted disabled:hover:bg-surface"
      >
        ADD
      </button>
    );
  }
  return (
    <div className="flex items-center rounded-lg bg-accent text-on-accent">
      <button type="button" onClick={() => change(product, -1)} aria-label={`One less ${product.name}`} className="px-2.5 py-1 text-lg font-bold leading-none">
        −
      </button>
      <span className="min-w-6 text-center text-sm font-bold tabular-nums" aria-live="polite">
        {quantity}
      </span>
      <button
        type="button"
        onClick={() => change(product, 1)}
        disabled={quantity >= product.most}
        aria-label={`One more ${product.name}`}
        className="px-2.5 py-1 text-lg font-bold leading-none disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

function CartSheet({
  slug,
  shopName,
  lines,
  totalPaise,
  change,
  close,
  placed,
}: {
  slug: string;
  shopName: string;
  lines: { product: StoreProduct; quantity: number }[];
  totalPaise: number;
  change: (p: StoreProduct, by: number) => void;
  close: () => void;
  placed: (orderId: string, payUrl?: string) => void;
}) {
  // The sheet only ever renders in the browser (after a tap), so it can read storage up front.
  const [buyer, setBuyer] = useState<Buyer>(() => ({ name: "", phone: "", address: "", ...load<Buyer>("munshi-buyer") }));
  const [method, setMethod] = useState<Method>("upi");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [close]);

  useEffect(() => {
    if (lines.length === 0) close();
  }, [lines.length, close]);

  const tooBig = totalPaise > MAX_ORDER_PAISE;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await placeOrder({ slug, cart: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })), buyer, method });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      save("munshi-buyer", buyer);
      placed(result.orderId, result.status === "open" ? result.payUrl : undefined);
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-stretch sm:justify-end" role="dialog" aria-modal aria-label="Your cart">
      <button type="button" aria-label="Close the cart" className="absolute inset-0 bg-black/45" onClick={close} tabIndex={-1} />
      <form
        onSubmit={submit}
        className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-paper shadow-2xl sm:max-h-none sm:w-[440px] sm:rounded-none"
      >
        <div className="flex items-center justify-between border-b border-line bg-surface px-5 py-4">
          <h2 className="font-display text-xl font-bold">Your cart</h2>
          <button ref={closeRef} type="button" onClick={close} className="rounded-full px-2 py-1 text-xl text-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className="font-semibold">⚡ Delivery in about 30 minutes</p>
            <p className="text-sm text-muted">Packed and delivered by {shopName}</p>
            <ul className="mt-3 divide-y divide-line">
              {lines.map(({ product, quantity }) => (
                <li key={product.id} className="flex items-center gap-3 py-3">
                  <span className="grid size-12 shrink-0 place-items-center rounded-xl text-2xl" style={tint(product.aisle)} aria-hidden>
                    {product.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-medium leading-tight">{product.name}</span>
                    <span className="text-xs text-muted">
                      {rupees(product.pricePaise * orderStep(product.unit))} / {stepLabel(product.unit)}
                    </span>
                  </span>
                  <Stepper product={product} quantity={quantity} change={change} />
                  <span className="w-16 text-right text-sm font-semibold tabular-nums">{rupees(Math.round(quantity * product.pricePaise))}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-line bg-surface p-4">
            <h3 className="mb-2 font-semibold">Bill details</h3>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Items total</dt>
                <dd className="tabular-nums">{rupees(totalPaise)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Delivery</dt>
                <dd className="font-medium text-accent">Free</dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 text-base font-bold">
                <dt>To pay</dt>
                <dd className="tabular-nums">{rupees(totalPaise)}</dd>
              </div>
            </dl>
            {tooBig && <p className="mt-2 text-sm text-danger">An online order can be up to {rupees(MAX_ORDER_PAISE)}.</p>}
          </div>

          <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4">
            <legend className="sr-only">Delivery details</legend>
            <h3 className="font-semibold">Deliver to</h3>
            <input className={field} placeholder="Your name" autoComplete="name" required value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} />
            <div className="flex items-center gap-2">
              <span className="rounded-xl border border-line bg-paper px-3 py-3 text-muted">+91</span>
              <input
                className={field}
                placeholder="Mobile number"
                inputMode="numeric"
                autoComplete="tel-national"
                required
                maxLength={14}
                value={buyer.phone}
                onChange={(e) => setBuyer({ ...buyer, phone: e.target.value })}
              />
            </div>
            <textarea
              className={`${field} min-h-20 resize-none`}
              placeholder="Flat / house, street, landmark"
              autoComplete="street-address"
              maxLength={300}
              value={buyer.address}
              onChange={(e) => setBuyer({ ...buyer, address: e.target.value })}
            />
          </fieldset>

          <fieldset className="space-y-2 rounded-2xl border border-line bg-surface p-4">
            <legend className="sr-only">How to pay</legend>
            <h3 className="font-semibold">Pay with</h3>
            {(
              [
                { id: "upi", title: "UPI", note: "Pay now on Cashfree's secure page", icon: "📲" },
                { id: "cod", title: "Cash on delivery", note: "Pay when your order arrives", icon: "💵" },
              ] as const
            ).map((option) => (
              <label
                key={option.id}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 ${method === option.id ? "border-accent ring-1 ring-accent" : "border-line"}`}
              >
                <input type="radio" name="method" value={option.id} checked={method === option.id} onChange={() => setMethod(option.id)} className="accent-[var(--accent)]" />
                <span className="text-xl" aria-hidden>
                  {option.icon}
                </span>
                <span className="flex flex-col">
                  <span className="font-medium">{option.title}</span>
                  <span className="text-xs text-muted">{option.note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {error && (
            <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="border-t border-line bg-surface px-4 py-3">
          <button type="submit" disabled={pending || tooBig || lines.length === 0} className="flex w-full items-center justify-between rounded-2xl bg-accent px-5 py-4 font-bold text-on-accent disabled:opacity-50">
            <span className="tabular-nums">{rupees(totalPaise)}</span>
            <span>{pending ? "Placing your order…" : method === "upi" ? "Pay & place order ›" : "Place order ›"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
