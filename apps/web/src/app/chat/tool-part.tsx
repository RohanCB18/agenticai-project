"use client";

import type { KhataUIMessage } from "@munshi/agents";

type Part = Extract<KhataUIMessage["parts"][number], { type: `tool-${string}` }>;
type Decide = (response: { id: string; approved: boolean; reason?: string }) => void;

const LABELS: Record<string, string> = {
  findCustomer: "Looking up customer",
  showPaymentQr: "UPI QR",
  remember: "Remembered",
  recall: "Memory",
  forget: "Forgotten",
  paymentHabits: "Payment habits",
  checkPayment: "Payment check",
  addCustomer: "Adding customer",
  recordCredit: "Udhaar recorded",
  recordPayment: "Payment recorded",
  recordSale: "Entry recorded",
  getBalances: "Dues",
  getStock: "Stock",
  updateStock: "Stock updated",
  sendPaymentLink: "UPI payment link",
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
  if (part.state === "output-denied") return <p className="text-sm text-muted">Payment link not sent.</p>;
  if (part.state === "output-error") {
    return <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{label} failed: {part.errorText}</p>;
  }
  if (part.state !== "output-available") return null;

  const out = part.output as Record<string, unknown>;
  return (
    <div className="max-w-sm rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <p className="mb-1 text-xs uppercase tracking-wider text-muted">{label}</p>
      <Output name={name} out={out} />
    </div>
  );
}

function Output({ name, out }: { name: string; out: Record<string, unknown> }) {
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

  if (name === "forget") return <p>{out.status === "forgotten" ? "Done." : "That fact wasn't found."}</p>;

  if (name === "paymentHabits" && out.status === "habits") {
    return (
      <p>
        {String(out.customer)}: {String(out.payments)} payments, about every {String(out.averageGapDays)} days, usually {String(out.averagePayment)}
        {out.usualDay ? `, mostly on ${String(out.usualDay)}` : ""}. Last paid {String(out.lastPaidDaysAgo)} days ago.
      </p>
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

  if (out.status === "recorded" && out.customer) {
    return (
      <p>
        {String(out.customer)}: {String(out.amount)}
        {out.nowOwes ? ` · now owes ${String(out.nowOwes)}` : ""}
      </p>
    );
  }

  if (typeof out.status === "string" && out.hint) return <p>{String(out.hint)}</p>;
  return <p className="font-mono text-xs">{JSON.stringify(out)}</p>;
}
