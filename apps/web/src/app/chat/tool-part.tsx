"use client";

import type { ReactNode } from "react";
import type { KhataUIMessage } from "@munshi/agents";
import { completedActionsInParts, receiptLines } from "@munshi/agents/receipts";

type Part = Extract<KhataUIMessage["parts"][number], { type: `tool-${string}` }>;
type Decide = (response: { id: string; approved: boolean; reason?: string }) => void;

// Labels name the tool, not an outcome: a card is shown while it runs, or when it didn't save
// (a possible repeat, an unknown customer). What was saved shows once, as a receipt under the reply.
const LABELS: Record<string, string> = {
  findCustomer: "Looking up customer",
  showPaymentQr: "UPI QR",
  remember: "Remembering",
  recall: "Memory",
  forget: "Forgetting",
  paymentHabits: "Payment habits",
  checkPayment: "Payment check",
  addCustomer: "Adding customer",
  recordCredit: "Udhaar",
  recordPayment: "Payment",
  recordSale: "Sale or expense",
  getBalances: "Dues",
  getStock: "Stock",
  updateStock: "Stock change",
  addProduct: "New product",
  correctEntry: "Fixing an entry",
  setReorderLevel: "Low-stock alert",
  setProductGst: "GST tag",
  tagAllProducts: "GST tags",
  sendPaymentLink: "UPI payment link",
  askSupplierQuote: "Wholesaler quote",
  placeSupplierOrder: "Wholesaler order",
  supplierDues: "What you owe the supplier",
  makeChart: "Chart",
  checkGstPortal: "GST portal",
  paySupplier: "Supplier payment",
  updateCustomer: "Customer details",
  customerHistory: "Khata history",
  lookupGst: "GST (official rates)",
};

export function ToolPart({ part, onDecision }: { part: Part; onDecision: Decide }) {
  const name = part.type.slice("tool-".length);
  const label = LABELS[name] ?? name;

  // A desk passing the message on is housekeeping, not a result: one quiet line at most.
  if (name === "handOff") {
    const desk = (part.input as { desk?: string } | undefined)?.desk;
    return part.state === "output-available" && desk ? <p className="text-xs text-muted">Passed to the {desk} desk</p> : null;
  }

  if (part.state === "input-streaming" || part.state === "input-available") {
    return <p className="text-sm text-muted">{label}…</p>;
  }

  if (part.state === "approval-requested" && !part.approval.isAutomatic && name === "placeSupplierOrder") {
    return (
      <div className="flex max-w-sm flex-col gap-3 rounded-lg border-2 border-accent bg-surface p-4">
        <p className="text-sm uppercase tracking-wider text-accent">Needs your OK</p>
        <p>Order the quote above from the wholesaler? You pay on delivery.</p>
        <div className="flex gap-2">
          <button onClick={() => onDecision({ id: part.approval.id, approved: true })} className="rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
            Haan, order karo
          </button>
          <button
            onClick={() => onDecision({ id: part.approval.id, approved: false, reason: "Owner declined" })}
            className="rounded-md border border-line px-4 py-2"
          >
            Nahi
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "approval-requested" && !part.approval.isAutomatic && name === "paySupplier") {
    const input = part.input as { supplierName?: string; amount?: number };
    return (
      <div className="flex max-w-sm flex-col gap-3 rounded-lg border-2 border-accent bg-surface p-4">
        <p className="text-sm uppercase tracking-wider text-accent">Needs your OK</p>
        <p>
          Pay <strong>{input.supplierName}</strong> <strong>₹{input.amount?.toLocaleString("en-IN")}</strong> from your Cashfree balance?
        </p>
        <div className="flex gap-2">
          <button onClick={() => onDecision({ id: part.approval.id, approved: true })} className="rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
            Haan, pay karo
          </button>
          <button
            onClick={() => onDecision({ id: part.approval.id, approved: false, reason: "Owner declined" })}
            className="rounded-md border border-line px-4 py-2"
          >
            Nahi
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "approval-requested" && !part.approval.isAutomatic) {
    const input = part.input as { customerName?: string; amount?: number };
    return (
      <div className="flex max-w-sm flex-col gap-3 rounded-lg border-2 border-accent bg-surface p-4">
        <p className="text-sm uppercase tracking-wider text-accent">Needs your OK</p>
        <p>
          Send <strong>{input.customerName}</strong> a UPI link for{" "}
          <strong>{input.amount ? `₹${input.amount.toLocaleString("en-IN")}` : "their full balance"}</strong>?
        </p>
        <div className="flex gap-2">
          <button onClick={() => onDecision({ id: part.approval.id, approved: true })} className="rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
            Haan, bhejo
          </button>
          <button
            onClick={() => onDecision({ id: part.approval.id, approved: false, reason: "Owner declined" })}
            className="rounded-md border border-line px-4 py-2"
          >
            Nahi
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "approval-responded") return <p className="text-sm text-muted">{part.approval.approved ? "Approved. Sending…" : "Not sent."}</p>;
  if (part.state === "output-denied") {
    const denied: Record<string, string> = { placeSupplierOrder: "Order not placed.", paySupplier: "Supplier not paid." };
    return <p className="text-sm text-muted">{denied[name] ?? "Payment link not sent."}</p>;
  }
  if (part.state === "output-error") {
    return <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{label} failed: {part.errorText}</p>;
  }
  if (part.state !== "output-available") return null;
  // A saved change appears as its receipt under the reply, worded as on Telegram.
  // Except tagging in bulk that left choices for the owner: those still need showing.
  const choices = name === "tagAllProducts" && Array.isArray((part.output as { chooseRate?: unknown[] }).chooseRate) && (part.output as { chooseRate: unknown[] }).chooseRate.length > 0;
  if (receiptLines(completedActionsInParts([part])).length > 0 && !choices) return null;

  const body = output(name, part.output as Record<string, unknown>);
  if (body == null) return null;
  return (
    <div className="max-w-sm rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <p className="mb-1 text-xs uppercase tracking-wider text-muted">{label}</p>
      {body}
    </div>
  );
}

/** What a card shows for a tool's result, or null for no card: the reply already says it. */
function output(name: string, out: Record<string, unknown>): ReactNode {
  if (out.status === "customer_not_found") return <p>No customer called “{String(out.name)}” yet.</p>;
  if (out.status === "ambiguous_customer") return <p>Which one: {(out.candidates as string[]).join(", ")}?</p>;

  if (name === "getBalances") {
    const rows = out.customers as { name: string; owes: string }[];
    return (
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.name} className="flex justify-between gap-6">
            <span>{r.name}</span>
            <span className="font-mono tabular-nums">{r.owes}</span>
          </div>
        ))}
        <div className="mt-1 flex justify-between gap-6 border-t border-line pt-1 font-medium">
          <span>Total</span>
          <span className="font-mono tabular-nums">{String(out.total)}</span>
        </div>
      </div>
    );
  }

  if (name === "getStock") {
    const rows = out.products as { name: string; stock: string; low: boolean }[];
    if (!rows?.length) return null;
    return (
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.name} className="flex justify-between gap-6">
            <span>{r.name}</span>
            <span className={`font-mono tabular-nums ${r.low ? "text-danger" : ""}`}>{r.stock}</span>
          </div>
        ))}
      </div>
    );
  }

  if (name === "showPaymentQr" && out.status === "qr_ready") {
    return (
      <div className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a small private QR, not a page image */}
        <img src={`/api/payments/qr/${String(out.qrId)}`} alt={`UPI QR for ${String(out.amount)}`} width={220} height={220} className="rounded-md bg-white p-2" />
        <p>
          {String(out.customer)}: {String(out.amount)}
        </p>
      </div>
    );
  }

  if (name === "checkPayment" && typeof out.received === "string") {
    return <p>{out.status === "payment_received" ? `${out.received} received` : "No new payment yet"}</p>;
  }

  if (name === "findCustomer" && Array.isArray(out.matches)) {
    const matches = out.matches as { name: string; phone: string | null }[];
    if (matches.length === 0) return <p>No match.</p>;
    return <p>{matches.map((m) => m.name).join(", ")}</p>;
  }

  if (name === "remember" && typeof out.fact === "string") {
    return (
      <p>
        {String(out.about)}: {out.fact}
        {out.status === "already_known" ? " (already known)" : ""}
      </p>
    );
  }

  if (name === "recall" && Array.isArray(out.facts)) {
    const facts = out.facts as { id: string; fact: string }[];
    if (facts.length === 0) return <p>Nothing remembered about {String(out.about)} yet.</p>;
    return (
      <ul className="flex list-disc flex-col gap-1 pl-4">
        {facts.map((f) => (
          <li key={f.id}>{f.fact}</li>
        ))}
      </ul>
    );
  }

  if (name === "forget") return <p>That fact wasn&apos;t found.</p>;

  if (name === "paymentHabits" && out.status === "habits") {
    return (
      <p>
        {String(out.customer)}: {String(out.payments)} payments, about every {String(out.averageGapDays)} days, usually {String(out.averagePayment)}
        {out.usualDay ? `, mostly on ${String(out.usualDay)}` : ""}. Last paid {String(out.lastPaidDaysAgo)} days ago.
      </p>
    );
  }

  if (name === "askSupplierQuote" && out.status === "quoted") {
    const lines = (out.lines ?? []) as { item: string; quantity: string; amount: string; note?: string }[];
    const unavailable = (out.unavailable ?? []) as { requested: string; reason: string }[];
    return (
      <div className="flex flex-col gap-1">
        <p className="font-medium">{String(out.supplier)}</p>
        <ul className="flex flex-col gap-0.5">
          {lines.map((line) => (
            <li key={line.item}>
              {line.item}: {line.quantity}, {line.amount}
              {line.note ? <span className="text-muted"> ({line.note})</span> : null}
            </li>
          ))}
        </ul>
        {unavailable.length ? <p className="text-muted">Can&apos;t supply: {unavailable.map((u) => `${u.requested} (${u.reason})`).join(", ")}</p> : null}
        <p className="font-medium">
          Total {String(out.total)}
          {out.discount ? ` after ${String(out.discount)} off` : ""}
        </p>
        <p className="text-muted">Delivery {String(out.deliverySlot)}, pay on delivery</p>
        {out.belowMinimum ? <p className="text-danger">{String(out.belowMinimum)}</p> : null}
      </div>
    );
  }

  if (name === "lookupGst" && out.status === "found") {
    const entries = (out.entries ?? []) as { item: string | null; gst?: string; citation: string | null; sources: { url: string }[] }[];
    return (
      <ul className="flex flex-col gap-2">
        {entries.slice(0, 3).map((entry, i) => (
          <li key={`${entry.citation}-${i}`} className="flex flex-col gap-0.5">
            <div className="flex justify-between gap-4">
              <span className="line-clamp-2">{entry.item}</span>
              {entry.gst ? <span className="shrink-0 font-mono font-medium tabular-nums">{entry.gst}</span> : null}
            </div>
            {entry.sources[0] ? (
              <a href={entry.sources[0].url} target="_blank" rel="noreferrer" className="text-xs text-accent underline">
                {entry.citation}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }

  if (name === "customerHistory" && out.status === "history") {
    const entries = (out.entries ?? []) as { date: string; type: string; amount: string; note?: string }[];
    return (
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {String(out.customer)}, last {String(out.days)} days: took {String(out.tookOnCredit)}, paid {String(out.paid)}
        </p>
        {entries.map((entry, i) => (
          <div key={`${entry.date}-${i}`} className="flex justify-between gap-4">
            <span>
              {entry.date} · {entry.type}
              {entry.note ? <span className="text-muted"> ({entry.note})</span> : null}
            </span>
            <span className="font-mono tabular-nums">{entry.amount}</span>
          </div>
        ))}
        <p className="mt-1 border-t border-line pt-1">Now owes {String(out.nowOwes)}</p>
      </div>
    );
  }

  if (name === "checkGstPortal" && out.status === "checking_portal") {
    return <p>Checking the official GST portal. The answer comes on Telegram in about a minute.</p>;
  }

  if (name === "makeChart" && out.status === "chart_ready") {
    return (
      <figure className="flex flex-col gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private chart image, not a page asset */}
        <img src={`/api/charts/${String(out.chartId)}`} alt={String(out.title)} width={480} height={270} className="w-full rounded-md bg-white" />
        <figcaption className="text-muted">{String(out.title)}</figcaption>
      </figure>
    );
  }
  if (name === "makeChart" && out.status === "chart_error") return <p className="text-muted">Redrawing the chart…</p>;
  if (name === "makeChart" && out.status === "nothing_to_chart") return <p className="text-muted">Nothing to draw: {String(out.summary)}</p>;

  if (name === "supplierDues" && out.status === "dues") {
    const orders = (out.unpaidOrders ?? []) as { orderId: string; amount: string; date: string }[];
    return (
      <div className="flex flex-col gap-1">
        {orders.map((o) => (
          <div key={o.orderId} className="flex justify-between gap-6">
            <span>
              {o.orderId} <span className="text-muted">· {o.date}</span>
            </span>
            <span className="font-mono tabular-nums">{o.amount}</span>
          </div>
        ))}
        <p className="mt-1 border-t border-line pt-1 font-medium">Due {String(out.totalDue)}</p>
        <p className="text-muted">Pays to {String(out.payTo)}</p>
      </div>
    );
  }

  if (name === "sendPaymentLink" && out.status === "sent") {
    return (
      <div className="flex flex-col gap-1">
        <p>
          {String(out.amount)} requested from {String(out.customer)}
        </p>
        <a href={String(out.url)} target="_blank" rel="noreferrer" className="break-all text-accent underline">
          {String(out.url)}
        </a>
      </div>
    );
  }

  if (name === "setProductGst" && Array.isArray(out.options)) {
    const options = out.options as { gst: string; item: string | null; citation: string | null }[];
    return (
      <div className="flex flex-col gap-1">
        <p>
          Official rates for HSN {String(out.hsn)}
          {out.product ? ` (${String(out.product)})` : ""}:
        </p>
        <ul className="flex flex-col gap-1">
          {options.map((o) => (
            <li key={o.gst} className="flex justify-between gap-4">
              <span className="line-clamp-2">{o.item}</span>
              <span className="shrink-0 font-mono font-medium tabular-nums">{o.gst}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (name === "tagAllProducts") {
    if (out.status === "untagged_products") return <p>To tag: {(out.products as string[]).join(", ")}</p>;
    if (out.status === "all_tagged") return <p>Every product is tagged.</p>;
    const choose = (out.chooseRate ?? []) as { product: string; hsn: string; options: { gst: string; item: string | null }[] }[];
    const unsure = (out.unconfirmed ?? []) as { product: string }[];
    return (
      <div className="flex flex-col gap-3">
        {choose.map((c) => (
          <div key={c.product} className="flex flex-col gap-1">
            <p>
              {c.product}, HSN {c.hsn}: which fits?
            </p>
            <ul className="flex flex-col gap-1">
              {c.options.map((o) => (
                <li key={o.gst} className="flex justify-between gap-4">
                  <span className="line-clamp-2">{o.item}</span>
                  <span className="shrink-0 font-mono font-medium tabular-nums">{o.gst}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {unsure.length > 0 && <p className="text-muted">Not sure of the HSN code: {unsure.map((u) => u.product).join(", ")}</p>}
      </div>
    );
  }

  // Anything else: no card. A tool's hint is written for the agent ("call again with
  // confirmedNew: true"), and live it showed up in front of the owner.
  return null;
}
