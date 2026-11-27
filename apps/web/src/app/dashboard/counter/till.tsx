"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { isWeighed, lineAmount, looksLikeBarcode, quickQuantities, rupees } from "@/lib/counter-bill";
import { cancelBill, checkout, linkBarcode, saleStatus } from "./actions";

export type TillProduct = { id: string; name: string; aliases: string[]; unit: string; stock: number; alertAt: number; pricePaise: number | null; barcode: string | null };
export type TillCustomer = { id: string; name: string };

type Line = { productId: string; quantity: number; pricePaise: number | null };
type Screen =
  | { kind: "bill" }
  | { kind: "udhaar" }
  | { kind: "upi"; saleId: string; totalPaise: number; qr: string; url: string }
  | { kind: "paid"; totalPaise: number; how: string; low: string[]; asking: boolean };

const field = "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = "rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:border-accent disabled:opacity-50";
const primary = "rounded-md bg-accent px-4 py-3 font-medium text-on-accent disabled:opacity-50";
const amount = (n: number) => Number(n.toFixed(3));

/**
 * The counter: scan or tap what the customer buys, take the payment, and the bill takes it out of
 * stock. A USB or Bluetooth barcode scanner types into the search box and presses Enter; the
 * camera button reads codes with the phone's camera.
 */
export function Till({ products, customers }: { products: TillProduct[]; customers: TillCustomer[] }) {
  const [catalog, setCatalog] = useState(products);
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState("");
  const [screen, setScreen] = useState<Screen>({ kind: "bill" });
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [pending, startTransition] = useTransition();
  const search = useRef<HTMLInputElement>(null);
  const billRef = useRef<HTMLElement>(null);

  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || looksLikeBarcode(q)) return catalog;
    return catalog.filter((p) => [p.name, ...p.aliases].some((name) => name.toLowerCase().includes(q)));
  }, [catalog, query]);

  const totalPaise = lines.reduce((sum, l) => sum + lineAmount(l.quantity, l.pricePaise ?? 0), 0);
  const ready = lines.length > 0 && lines.every((l) => l.quantity > 0 && (l.pricePaise ?? 0) > 0) && totalPaise >= 100;

  const focusSearch = () => window.setTimeout(() => search.current?.focus(), 0);

  const add = useCallback((product: TillProduct, quantity = 1) => {
    setLines((current) => {
      const at = current.findIndex((l) => l.productId === product.id);
      if (at === -1) return [...current, { productId: product.id, quantity, pricePaise: product.pricePaise }];
      return current.map((l, i) => (i === at ? { ...l, quantity: amount(l.quantity + quantity) } : l));
    });
    setQuery("");
    setNotice(null);
    focusSearch();
  }, []);

  /** A code from the scanner or camera: its product goes on the bill; a new code gets linked once. */
  const scanned = useCallback(
    (raw: string) => {
      const code = raw.trim();
      const product = catalog.find((p) => p.barcode === code);
      if (product) return add(product);
      if (looksLikeBarcode(code)) {
        setUnknownCode(code);
        setQuery("");
        return;
      }
      setNotice(`No product with the code ${code}.`);
    },
    [add, catalog],
  );

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    if (looksLikeBarcode(text) || catalog.some((p) => p.barcode === text)) return scanned(text);
    if (shown.length === 1) add(shown[0]!);
  }

  const setLine = (productId: string, change: Partial<Line>) => setLines((current) => current.map((l) => (l.productId === productId ? { ...l, ...change } : l)));
  const removeLine = (productId: string) => setLines((current) => current.filter((l) => l.productId !== productId));

  function pay(method: "upi" | "cash" | "udhaar") {
    setNotice(null);
    startTransition(async () => {
      const result = await checkout({
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, pricePaise: l.pricePaise ?? 0 })),
        method,
        customerId: method === "udhaar" ? customerId : null,
      });
      if ("error" in result) return setNotice(result.error);
      rememberPrices();
      if (result.status === "open") return setScreen({ kind: "upi", saleId: result.saleId, totalPaise: result.totalPaise, qr: result.qr, url: result.url });
      const who = customers.find((c) => c.id === customerId)?.name ?? "the customer";
      setScreen({ kind: "paid", totalPaise: result.totalPaise, how: method === "cash" ? "Cash received" : `Added to ${who}'s udhaar`, low: result.low, asking: result.asking });
      takeFromStock();
    });
  }

  /** Prices typed at the counter are saved with the product, so the next bill has them. */
  function rememberPrices() {
    setCatalog((current) => current.map((p) => ({ ...p, pricePaise: lines.find((l) => l.productId === p.id)?.pricePaise ?? p.pricePaise })));
  }
  /** The screen's stock figures follow the bill, as the database just did. */
  function takeFromStock() {
    setCatalog((current) => current.map((p) => ({ ...p, stock: amount(p.stock - (lines.find((l) => l.productId === p.id)?.quantity ?? 0)) })));
  }

  // A UPI bill on screen: ask every 3 seconds whether Cashfree has the payment.
  const upiSale = screen.kind === "upi" ? screen : null;
  useEffect(() => {
    if (!upiSale) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const result = await saleStatus(upiSale.saleId);
      if (stopped || "error" in result) return;
      if (result.status === "paid") {
        setScreen({ kind: "paid", totalPaise: upiSale.totalPaise, how: "Paid by UPI", low: result.low, asking: result.asking });
        takeFromStock();
      } else if (result.status === "cancelled") {
        setScreen({ kind: "bill" });
        setNotice("That payment page was closed. Nothing was recorded.");
      }
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // takeFromStock reads the bill that was paid; the timer is only reset for a new sale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upiSale?.saleId]);

  function newBill() {
    setLines([]);
    setScreen({ kind: "bill" });
    setCustomerId("");
    setNotice(null);
    focusSearch();
  }

  if (screen.kind === "upi") {
    return (
      <section className="mx-auto flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-sm text-muted">Customer scans to pay</p>
        <p className="font-display text-4xl font-semibold tabular-nums">{rupees(screen.totalPaise)}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made on the server */}
        <img src={screen.qr} alt={`QR code to pay ${rupees(screen.totalPaise)}`} width={256} height={256} className="rounded-md bg-white p-2" />
        <p className="text-sm text-muted" role="status">
          Waiting for the payment… The stock goes down as soon as Cashfree confirms it.
        </p>
        <a href={screen.url} target="_blank" rel="noreferrer" className="text-sm text-accent underline-offset-4 hover:underline">
          Open the payment page on this device
        </a>
        <button
          className={button}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await cancelBill(screen.saleId);
              setScreen({ kind: "bill" });
              setNotice("Bill cancelled. Nothing was recorded.");
            })
          }
        >
          Cancel this payment
        </button>
      </section>
    );
  }

  if (screen.kind === "paid") {
    return (
      <section className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-4xl" aria-hidden>
          ✅
        </p>
        <p className="font-display text-3xl font-semibold tabular-nums">{rupees(screen.totalPaise)}</p>
        <p>{screen.how}. Stock updated.</p>
        {screen.low.length > 0 && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm">
            📦 Running low: {screen.low.join(", ")}.{" "}
            {screen.asking
              ? "Munshi is asking you on your chat app whether to restock."
              : "Connect Telegram on the dashboard, and Munshi will ask you there whether to restock."}
          </p>
        )}
        <button className={primary} onClick={newBill} autoFocus>
          New bill
        </button>
      </section>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <section className="flex min-w-0 flex-col gap-3">
        <form onSubmit={submitSearch} className="flex gap-2">
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={field}
            placeholder="Scan a barcode or type a product"
            aria-label="Scan a barcode or search products"
            autoFocus
            autoComplete="off"
            enterKeyHint="go"
          />
          <button type="button" className={button} onClick={() => setScanning(true)} aria-label="Scan with the camera">
            📷 Scan
          </button>
        </form>
        {notice && (
          <p className="rounded-md bg-danger-soft px-3 py-2 text-sm" role="alert">
            {notice}
          </p>
        )}
        {unknownCode && (
          <LinkBarcode
            code={unknownCode}
            products={catalog}
            onCancel={() => {
              setUnknownCode(null);
              focusSearch();
            }}
            onLinked={(product) => {
              setCatalog((current) => current.map((p) => (p.id === product.id ? { ...p, barcode: unknownCode } : p.barcode === unknownCode ? { ...p, barcode: null } : p)));
              setUnknownCode(null);
              add({ ...product, barcode: unknownCode });
            }}
          />
        )}
        {catalog.length === 0 ? (
          <p className="text-muted">No products yet. Send Munshi a photo of a supplier bill, or say &ldquo;Maggi naya product hai, 20 packet aaye&rdquo;.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {shown.map((p) => {
              const low = p.stock <= p.alertAt;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => add(p)}
                    className="flex h-full w-full flex-col items-start gap-1 rounded-lg border border-line bg-surface p-3 text-left hover:border-accent"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-sm text-muted">{p.pricePaise ? `${rupees(p.pricePaise)} / ${p.unit}` : "No price yet"}</span>
                    <span className={`text-xs ${low ? "text-danger" : "text-muted"}`}>
                      {amount(p.stock)} {p.unit} left{low ? " · low" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section ref={billRef} className="flex scroll-mt-4 flex-col gap-3 lg:sticky lg:top-6 lg:self-start" aria-label="The bill">
        <div className="rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-3 font-display text-lg font-semibold">Bill</h2>
          {lines.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">Scan or tap what the customer is buying.</p>
          ) : (
            <ul className="divide-y divide-line">
              {lines.map((line) => {
                const p = byId.get(line.productId);
                if (!p) return null;
                const weighed = isWeighed(p.unit);
                const step = weighed ? (p.unit.toLowerCase().startsWith("g") || p.unit.toLowerCase() === "ml" ? 50 : 0.25) : 1;
                const over = line.quantity > p.stock;
                return (
                  <li key={line.productId} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{p.name}</span>
                      <span className="font-mono tabular-nums">{rupees(lineAmount(line.quantity, line.pricePaise ?? 0))}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <button className={button} onClick={() => setLine(p.id, { quantity: amount(Math.max(step, line.quantity - step)) })} aria-label={`One less ${p.name}`}>
                        −
                      </button>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={step}
                        step={step}
                        value={line.quantity}
                        onChange={(e) => setLine(p.id, { quantity: Number(e.target.value) })}
                        className="w-20 rounded-md border border-line bg-surface px-2 py-1.5 text-center tabular-nums"
                        aria-label={`Quantity of ${p.name} in ${p.unit}`}
                      />
                      <span>{p.unit}</span>
                      <button className={button} onClick={() => setLine(p.id, { quantity: amount(line.quantity + step) })} aria-label={`One more ${p.name}`}>
                        +
                      </button>
                      <span className="text-muted">at ₹</span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={0.5}
                        value={line.pricePaise === null ? "" : line.pricePaise / 100}
                        placeholder="price"
                        onChange={(e) => setLine(p.id, { pricePaise: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })}
                        className={`w-20 rounded-md border bg-surface px-2 py-1.5 text-right tabular-nums ${line.pricePaise ? "border-line" : "border-danger"}`}
                        aria-label={`Price of ${p.name} per ${p.unit}`}
                      />
                      <span className="whitespace-nowrap text-muted">/ {p.unit}</span>
                      <button className="ml-auto text-muted underline-offset-4 hover:underline" onClick={() => removeLine(p.id)}>
                        Remove
                      </button>
                    </div>
                    {weighed && (
                      <div className="flex flex-wrap gap-1.5">
                        {quickQuantities(p.unit).map((q) => (
                          <button key={q} className="rounded-full border border-line px-2.5 py-0.5 text-xs hover:border-accent" onClick={() => setLine(p.id, { quantity: q })}>
                            {q} {p.unit}
                          </button>
                        ))}
                      </div>
                    )}
                    {over && (
                      <p className="text-xs text-danger">
                        Munshi has only {amount(p.stock)} {p.unit} on record; the bill still goes through.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-baseline justify-between border-t border-line px-4 py-3">
            <span className="text-muted">Total</span>
            <span className="font-display text-2xl font-semibold tabular-nums">{rupees(totalPaise)}</span>
          </div>
        </div>

        {screen.kind === "udhaar" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
            <label className="flex flex-col gap-1.5 text-sm">
              Whose udhaar?
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={field}>
                <option value="">Choose a customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button className={`${primary} flex-1`} disabled={!ready || !customerId || pending} onClick={() => pay("udhaar")}>
                {pending ? "Saving…" : `Add ${rupees(totalPaise)} to udhaar`}
              </button>
              <button className={button} onClick={() => setScreen({ kind: "bill" })}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <button className={primary} disabled={!ready || pending} onClick={() => pay("upi")}>
              UPI QR
            </button>
            <button className={primary} disabled={!ready || pending} onClick={() => pay("cash")}>
              Cash
            </button>
            <button className={primary} disabled={!ready || pending || customers.length === 0} onClick={() => setScreen({ kind: "udhaar" })}>
              Udhaar
            </button>
          </div>
        )}
        {pending && (
          <p className="text-sm text-muted" role="status">
            Working…
          </p>
        )}
        {lines.length > 0 && !ready && <p className="text-sm text-muted">Every item needs a price.</p>}
      </section>

      {/* On a phone the bill is below the products: keep the total in reach. */}
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 lg:hidden">
          <span className="font-display text-xl font-semibold tabular-nums">{rupees(totalPaise)}</span>
          <span className="text-sm text-muted">
            {lines.length} item{lines.length === 1 ? "" : "s"}
          </span>
          <button className={primary} onClick={() => billRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Bill and pay
          </button>
        </div>
      )}
      {lines.length > 0 && <div className="h-16 lg:hidden" aria-hidden />}

      {scanning && (
        <CameraScanner
          onClose={() => {
            setScanning(false);
            focusSearch();
          }}
          onCode={(code) => {
            setScanning(false);
            scanned(code);
          }}
        />
      )}
    </div>
  );
}

/** A barcode Munshi hasn't seen: the owner says which product it is, once. */
function LinkBarcode({ code, products, onCancel, onLinked }: { code: string; products: TillProduct[]; onCancel: () => void; onLinked: (product: TillProduct) => void }) {
  const [productId, setProductId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent bg-surface p-4">
      <p className="text-sm">
        New barcode <span className="font-mono">{code}</span>. Which product is it? Munshi remembers it for next time.
      </p>
      <select value={productId} onChange={(e) => setProductId(e.target.value)} className={field} aria-label="Product for this barcode">
        <option value="">Choose a product</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.unit})
          </option>
        ))}
      </select>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          className={primary}
          disabled={!productId || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await linkBarcode(productId, code);
              if ("error" in result) return setError(result.error);
              const product = products.find((p) => p.id === productId);
              if (product) onLinked(product);
            })
          }
        >
          {pending ? "Saving…" : "Save and add to bill"}
        </button>
        <button className={button} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

/** Reads a barcode with the phone's camera: the browser's own reader where there is one (Chrome on Android), else a WebAssembly one. */
function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onCode);
  useEffect(() => {
    done.current = onCode;
  }, [onCode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: number | undefined;
    (async () => {
      try {
        const native = (window as unknown as { BarcodeDetector?: new () => Detector }).BarcodeDetector;
        let detector: Detector;
        if (native) detector = new native();
        else {
          const { BarcodeDetector } = await import("barcode-detector/ponyfill");
          detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"] });
        }
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const look = async () => {
          if (stopped || !video.current) return;
          try {
            const [found] = await detector.detect(video.current);
            if (found?.rawValue) {
              stopped = true;
              return done.current(found.rawValue);
            }
          } catch {
            // a frame that couldn't be read: try the next one
          }
          timer = window.setTimeout(look, 200);
        };
        void look();
      } catch (problem) {
        setError(problem instanceof Error && problem.name === "NotAllowedError" ? "Allow the camera to scan barcodes." : "The camera couldn't start on this device. Type the code instead.");
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-4" role="dialog" aria-label="Scan a barcode">
      <video ref={video} className="w-full max-w-md rounded-lg" muted playsInline />
      <p className="text-sm text-white">{error ?? "Point the camera at the barcode."}</p>
      <button className="rounded-md bg-white px-4 py-2 font-medium text-black" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
