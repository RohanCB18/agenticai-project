import { generateText, hasToolCall, isStepCount, type LanguageModel, type ModelMessage, tool } from "ai";
import { z } from "zod";

// Munshi's browser agent: Sarvam working an official website through Playwright MCP, for answers
// the knowledge base doesn't have (an item's HSN code on the GST portal). The browser runs in an
// isolated sandbox whose network only reaches the sites below; this list is checked here too.

/** The sites the browser may open. The sandbox's network policy enforces the same list. */
export const OFFICIAL_SITES = ["gst.gov.in", "cbic-gst.gov.in"];

/** Where an HSN question starts: the GST portal's public HSN search, no login needed. */
export const GST_HSN_SEARCH = "https://services.gst.gov.in/services/searchhsnsac";

export interface BrowserSession {
  /** Calls a Playwright MCP tool and returns its text output. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

export type BrowseResult = { found: boolean; answer: string; source: string | null; steps: number };

/** True for an https URL on one of the official sites (or a subdomain of one). */
export function isOfficialUrl(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && OFFICIAL_SITES.some((site) => hostname === site || hostname.endsWith(`.${site}`));
  } catch {
    return false;
  }
}

// A page outline can be long (the GST portal's is about 12,000 characters, mostly menus).
const MAX_PAGE = 14_000;
const OLD_PAGE = "(an earlier page; see the latest one)";

const SYSTEM = `You use a web browser for Munshi, a shop's bookkeeping assistant, to find facts on official Indian government websites (${OFFICIAL_SITES.join(", ")}). No other site opens.

How to work:
- Every action returns the page as an outline. Elements have refs like [ref=e231]: pass the ref to click, type or choose.
- Search boxes on these sites suggest results as you type: type the search words, then read the suggestions in the new outline. You may click a suggestion or the Search button.
- Never log in, register, file anything, fill in personal or business details, or solve a CAPTCHA. If a page needs any of these, stop.
- Use as few steps as you can. When you have the answer, call finish with it in plain English, quoting codes and descriptions exactly as the site shows them, and the page's URL. If the site doesn't have it, call finish with found false and say what you tried.`;

/**
 * Runs one browsing task. The model gets a handful of plain tools (not Playwright's own list, so it
 * can't run scripts or upload files), each returning the page afterwards; older pages are dropped
 * from the conversation so each call stays small.
 */
export async function runBrowserTask(opts: {
  model: LanguageModel;
  browser: BrowserSession;
  task: string;
  startUrl: string;
  maxSteps?: number;
  abortSignal?: AbortSignal;
}): Promise<BrowseResult> {
  const { browser } = opts;
  const page = async () => (await browser.call("browser_snapshot", {})).slice(0, MAX_PAGE);
  const act = async (name: string, args: Record<string, unknown>) => {
    const result = await browser.call(name, args);
    // Errors (a stale ref, a timeout) are worth reading; otherwise, show the page as it is now.
    return /### Error/.test(result) ? `${result.slice(0, 1500)}\n\n${await page()}` : page();
  };
  let finished: { found: boolean; answer: string; sourceUrl?: string } | null = null;

  const tools = {
    open: tool({
      description: `Open a page on an official site (${OFFICIAL_SITES.join(", ")}).`,
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => (isOfficialUrl(url) ? act("browser_navigate", { url }) : `Not allowed: only ${OFFICIAL_SITES.join(", ")} can be opened.`),
    }),
    click: tool({
      description: "Click an element by its ref.",
      inputSchema: z.object({ ref: z.string(), element: z.string().describe("What it is, e.g. 'Search button'") }),
      execute: async ({ ref, element }) => act("browser_click", { target: ref, element }),
    }),
    type: tool({
      description: "Type into a text box by its ref, one key at a time so the site's suggestions appear. submit presses Enter afterwards.",
      inputSchema: z.object({ ref: z.string(), text: z.string().max(200), submit: z.boolean().default(false) }),
      execute: async ({ ref, text, submit }) => {
        const result = await browser.call("browser_type", { target: ref, element: "text box", text, slowly: true, submit });
        if (/### Error/.test(result)) return `${result.slice(0, 1500)}\n\n${await page()}`;
        await browser.call("browser_wait_for", { time: 2 }); // suggestions load after the last key
        return page();
      },
    }),
    choose: tool({
      description: "Choose an option in a dropdown by its ref.",
      inputSchema: z.object({ ref: z.string(), value: z.string() }),
      execute: async ({ ref, value }) => act("browser_select_option", { target: ref, element: "dropdown", values: [value] }),
    }),
    pressKey: tool({
      description: "Press a key, e.g. Enter, ArrowDown or Escape.",
      inputSchema: z.object({ key: z.string().max(20) }),
      execute: async ({ key }) => act("browser_press_key", { key }),
    }),
    back: tool({ description: "Go back to the previous page.", inputSchema: z.object({}), execute: async () => act("browser_navigate_back", {}) }),
    finish: tool({
      description: "Stop and report. found false if the site doesn't have the answer.",
      inputSchema: z.object({ found: z.boolean(), answer: z.string().max(1500), sourceUrl: z.string().optional() }),
      execute: async (input) => {
        finished = input;
        return "Reported.";
      },
    }),
  };

  const result = await generateText({
    model: opts.model,
    system: SYSTEM,
    prompt: `Task: ${opts.task}\nStart at ${opts.startUrl}: call open with it first.`,
    tools,
    stopWhen: [hasToolCall("finish"), isStepCount(opts.maxSteps ?? 14)],
    abortSignal: opts.abortSignal,
    prepareStep: async ({ messages }) => ({ messages: dropOldPages(messages) }),
    telemetry: { functionId: "browser-agent" },
  });

  const done = finished as { found: boolean; answer: string; sourceUrl?: string } | null;
  if (!done) return { found: false, answer: "The browser stopped before finding the answer.", source: null, steps: result.steps.length };
  // A source must be one of the official sites the browser could reach.
  const source = done.sourceUrl && isOfficialUrl(done.sourceUrl) ? done.sourceUrl : null;
  return { found: done.found, answer: done.answer, source, steps: result.steps.length };
}

/** What the owner is told when a portal lookup ends: what the site showed, and where. */
export function portalNotice(question: string, result: BrowseResult) {
  if (!result.found) return `🔎 I checked the GST portal for "${question}" but couldn't find it. ${result.answer}`.trim();
  return [
    `🔎 From the GST portal${result.source ? ` (${new URL(result.source).hostname})` : ""}, for "${question}":`,
    result.answer,
    "These are the portal's own results. For the GST rate on one, ask me, e.g. \"HSN 0802 pe kitna GST?\"",
  ].join("\n\n");
}

/** Keeps only the latest page outline in the conversation; earlier ones become a short note. */
export function dropOldPages(messages: ModelMessage[]): ModelMessage[] {
  let lastTool = messages.length - 1;
  while (lastTool >= 0 && messages[lastTool]!.role !== "tool") lastTool--;
  return messages.map((message, index) =>
    message.role !== "tool" || index === lastTool
      ? message
      : { ...message, content: message.content.map((part) => (part.type === "tool-result" ? { ...part, output: { type: "text" as const, value: OLD_PAGE } } : part)) },
  );
}
