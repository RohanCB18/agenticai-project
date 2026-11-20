import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { type BrowserSession, dropOldPages, GST_HSN_SEARCH, isOfficialUrl, portalNotice, runBrowserTask } from "./browser";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const call = (toolName: string, input: object, id = toolName): LanguageModelV4GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: `call_${id}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
function scripted(...steps: LanguageModelV4GenerateResult[]) {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)]! });
}

/** A browser that records calls and shows a search page, then suggestions once something is typed. */
function fakeBrowser() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let typed = "";
  const browser: BrowserSession = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "browser_type") typed = String(args.text);
      if (name !== "browser_snapshot") return "### Ran Playwright code";
      return typed ? `- textbox "Search HSN Chapter by Description" [ref=e231]: ${typed}\n- generic [ref=e251]: "08134090"` : '- textbox "Search HSN Chapter by Description" [ref=e231]';
    },
  };
  return { browser, calls };
}

describe("isOfficialUrl", () => {
  it("allows only https pages on the official sites", () => {
    expect(isOfficialUrl(GST_HSN_SEARCH)).toBe(true);
    expect(isOfficialUrl("https://cbic-gst.gov.in/gst-goods-services-rates.html")).toBe(true);
    expect(isOfficialUrl("http://services.gst.gov.in/")).toBe(false);
    expect(isOfficialUrl("https://gst.gov.in.evil.com/")).toBe(false);
    expect(isOfficialUrl("https://notgst.gov.in/")).toBe(false);
    expect(isOfficialUrl("not a url")).toBe(false);
  });
});

describe("runBrowserTask", () => {
  it("opens the portal, types slowly, reads the suggestions and reports with the source", async () => {
    const { browser, calls } = fakeBrowser();
    const result = await runBrowserTask({
      model: scripted(
        call("open", { url: GST_HSN_SEARCH }),
        call("type", { ref: "e231", text: "makhana" }),
        call("finish", { found: true, answer: "08134090", sourceUrl: GST_HSN_SEARCH }),
      ),
      browser,
      task: "HSN code for makhana?",
      startUrl: GST_HSN_SEARCH,
    });
    expect(result).toEqual({ found: true, answer: "08134090", source: GST_HSN_SEARCH, steps: 3 });
    expect(calls.map((c) => c.name)).toEqual(["browser_navigate", "browser_snapshot", "browser_type", "browser_wait_for", "browser_snapshot"]);
    expect(calls[2]!.args).toMatchObject({ target: "e231", text: "makhana", slowly: true });
  });

  it("refuses other sites, and drops a source that isn't official", async () => {
    const { browser, calls } = fakeBrowser();
    const result = await runBrowserTask({
      model: scripted(call("open", { url: "https://example.com" }), call("finish", { found: true, answer: "made up", sourceUrl: "https://example.com" })),
      browser,
      task: "anything",
      startUrl: GST_HSN_SEARCH,
    });
    expect(calls).toHaveLength(0); // nothing reached the browser
    expect(result).toMatchObject({ found: true, source: null });
  });

  it("says so when it runs out of steps without an answer", async () => {
    const { browser } = fakeBrowser();
    const result = await runBrowserTask({ model: scripted(call("pressKey", { key: "Enter" })), browser, task: "x", startUrl: GST_HSN_SEARCH, maxSteps: 2 });
    expect(result).toMatchObject({ found: false, source: null, steps: 2 });
  });
});

describe("dropOldPages", () => {
  it("keeps only the latest page outline", () => {
    const page = (id: string, text: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "open", output: { type: "text", value: text } }] });
    const messages: ModelMessage[] = [{ role: "user", content: "task" }, page("1", "first page"), { role: "assistant", content: "next" }, page("2", "second page")];
    const kept = dropOldPages(messages);
    expect(JSON.stringify(kept[1])).not.toContain("first page");
    expect(JSON.stringify(kept[3])).toContain("second page");
  });
});

describe("portalNotice", () => {
  it("tells the owner what the portal showed and where, or that it found nothing", () => {
    expect(portalNotice("HSN for makhana?", { found: true, answer: "- 08134090: OTHER", source: GST_HSN_SEARCH, steps: 5 })).toBe(
      '🔎 From the GST portal (services.gst.gov.in), for "HSN for makhana?":\n\n- 08134090: OTHER\n\nThese are the portal\'s own results. For the GST rate on one, ask me, e.g. "HSN 0802 pe kitna GST?"',
    );
    expect(portalNotice("HSN for X?", { found: false, answer: "No results.", source: null, steps: 4 })).toBe('🔎 I checked the GST portal for "HSN for X?" but couldn\'t find it. No results.');
  });
});
