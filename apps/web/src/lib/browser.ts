import "server-only";
import { type BrowseResult, type BrowserSession, GST_HSN_SEARCH, OFFICIAL_SITES, resolveModel, runBrowserTask } from "@munshi/agents";
import { Sandbox } from "@vercel/sandbox";

// The browser the agent drives: Playwright MCP and Chromium in a Vercel Sandbox started from a
// snapshot (scripts/build-browser-snapshot.mjs). Its network reaches only the official sites, and it
// has no public port: each tool call goes through the sandbox's command channel to the bridge
// (sandbox/browser-bridge.mjs) listening on 127.0.0.1 inside it.

const REGION = "bom1";
const BRIDGE = "http://127.0.0.1:9000";
/** One browsing task, start to answer. A workflow step runs it, so it isn't bound by a chat turn. */
export const BROWSE_TIMEOUT_MS = 150_000;

async function openSandboxBrowser(snapshotId: string, signal: AbortSignal): Promise<{ browser: BrowserSession; close: () => Promise<void> }> {
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    region: REGION,
    timeout: 4 * 60 * 1000, // the platform stops it even if close() never runs
    persistent: false,
    networkPolicy: { allow: OFFICIAL_SITES.flatMap((site) => [site, `*.${site}`]) },
    signal,
  });
  const close = async () => {
    await sandbox.stop().catch(() => {});
  };
  try {
    await sandbox.runCommand({ cmd: "bash", args: ["-lc", "cd ~/munshi-browser && node bridge.mjs > /tmp/bridge.log 2>&1"], detached: true, signal });
    const post = async (payload: object, seconds: number) => {
      const result = await sandbox.runCommand("curl", ["-s", "--max-time", String(seconds), "-X", "POST", BRIDGE, "-d", JSON.stringify(payload)], { signal });
      return result.exitCode === 0 ? await result.stdout() : "";
    };
    // The bridge starts Chromium first: wait until it answers.
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = Boolean(await post({ op: "tools" }, 2));
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!ready) throw new Error("The browser didn't start");

    const browser: BrowserSession = {
      async call(name, args) {
        const out = await post({ op: "call", name, args }, 45);
        if (!out) return "### Error\nThe browser didn't answer.";
        const result = JSON.parse(out) as { content?: { type: string; text?: string }[]; error?: string };
        if (result.error) return `### Error\n${result.error}`;
        return (result.content ?? []).map((part) => part.text ?? "").join("\n");
      },
    };
    return { browser, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const browserConfigured = () => Boolean(process.env.BROWSER_SANDBOX_SNAPSHOT && process.env.SARVAM_API_KEY);

/** Looks something up on the GST portal (an item's HSN code), with Sarvam driving the browser. */
export async function lookUpOnGstPortal(question: string): Promise<BrowseResult> {
  const snapshotId = process.env.BROWSER_SANDBOX_SNAPSHOT;
  const sarvamApiKey = process.env.SARVAM_API_KEY;
  if (!snapshotId || !sarvamApiKey) throw new Error("Browsing is off: BROWSER_SANDBOX_SNAPSHOT or SARVAM_API_KEY is missing");

  const signal = AbortSignal.timeout(BROWSE_TIMEOUT_MS);
  const { browser, close } = await openSandboxBrowser(snapshotId, signal);
  try {
    return await runBrowserTask({
      model: resolveModel({ sarvamApiKey }),
      browser,
      task: `${question} Use the portal's HSN search (search by description) and report the HSN codes and descriptions it shows.`,
      startUrl: GST_HSN_SEARCH,
      abortSignal: signal,
    });
  } finally {
    await close();
  }
}
