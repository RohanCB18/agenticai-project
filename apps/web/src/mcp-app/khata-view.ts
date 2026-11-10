import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";

// The khata card: an MCP App view that Claude (or any MCP Apps host) renders in a sandboxed frame
// when the showKhata tool runs. It draws the tool's structured result, and its buttons call the
// server's own tools through the host, which asks the owner before anything is sent.
// Bundled into one HTML file by scripts/build-mcp-app.mjs. Customer names are untrusted text, so
// everything is set with textContent, never innerHTML.

export type KhataCard = {
  shop: string;
  total: string;
  customers: { name: string; owes: string; owesPaise: number; hasPhone: boolean; lastCreditDaysAgo: number | null; lastPaymentDaysAgo: number | null }[];
  lowStock: { name: string; stock: string; alertAt: string }[];
};

const app = new App({ name: "Munshi khata card", version: "1.0.0" });
const root = document.getElementById("root")!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const ago = (days: number | null, what: string) => (days === null ? null : days === 0 ? `${what} today` : `${what} ${days} day${days === 1 ? "" : "s"} ago`);

function render(card: KhataCard) {
  root.replaceChildren();
  const head = el("header");
  const titles = el("div");
  titles.append(el("p", "eyebrow", "Udhaar to collect"), el("p", "total", card.total), el("p", "muted", `${card.shop} · ${card.customers.length} customer${card.customers.length === 1 ? "" : "s"}`));
  const refresh = el("button", "ghost", "Refresh");
  refresh.onclick = () => void refreshCard(refresh);
  head.append(titles, refresh);
  root.append(head);

  if (card.customers.length === 0) root.append(el("p", "empty", "Nobody owes you anything right now."));
  const max = Math.max(1, ...card.customers.map((c) => c.owesPaise));
  const list = el("ul", "rows");
  for (const customer of card.customers) {
    const row = el("li", "row");
    const info = el("div", "info");
    const line = el("div", "line");
    line.append(el("span", "name", customer.name), el("span", "amount", customer.owes));
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = `${Math.max(4, Math.round((customer.owesPaise / max) * 100))}%`;
    bar.append(fill);
    const when = [ago(customer.lastCreditDaysAgo, "udhaar"), ago(customer.lastPaymentDaysAgo, "paid")].filter(Boolean).join(" · ");
    info.append(line, bar, el("p", "muted small", when || "no dates yet"));
    const action = el("div", "action");
    if (customer.hasPhone) {
      const send = el("button", "primary", "Send UPI link");
      send.onclick = () => void sendLink(customer.name, send, action);
      action.append(send);
    } else {
      action.append(el("span", "muted small", "No phone"));
    }
    row.append(info, action);
    list.append(row);
  }
  root.append(list);

  if (card.lowStock.length) {
    const low = el("section", "low");
    low.append(el("p", "eyebrow", "Running low"));
    const chips = el("div", "chips");
    for (const item of card.lowStock) chips.append(el("span", "chip", `${item.name}: ${item.stock} (alert at ${item.alertAt})`));
    low.append(chips);
    root.append(low);
  }
}

async function refreshCard(button: HTMLButtonElement) {
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const result = await app.callServerTool({ name: "showKhata", arguments: {} });
    if (!result.isError && result.structuredContent) render(result.structuredContent as KhataCard);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

async function sendLink(customerName: string, button: HTMLButtonElement, slot: HTMLElement) {
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const result = await app.callServerTool({ name: "sendPaymentLink", arguments: { customerName } });
    const out = (result.structuredContent ?? {}) as { status?: string; amount?: string; url?: string; hint?: string; message?: string };
    if (result.isError || out.status !== "sent" || !out.url) {
      button.disabled = false;
      button.textContent = "Try again";
      slot.append(el("p", "error small", out.hint ?? out.message ?? "Couldn't send the link."));
      return;
    }
    const url = out.url;
    const open = el("button", "link small", `${out.amount ?? ""} link sent · open`);
    open.onclick = () => void app.openLink({ url });
    slot.replaceChildren(open);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try again";
    slot.append(el("p", "error small", error instanceof Error ? error.message : "Couldn't send the link."));
  }
}

function applyContext(context: McpUiHostContext | undefined) {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

app.ontoolresult = (params) => {
  if (params.structuredContent) render(params.structuredContent as KhataCard);
};
app.onhostcontextchanged = (context) => applyContext(context);

root.replaceChildren(el("p", "muted", "Opening the khata…"));
await app.connect();
applyContext(app.getHostContext());
