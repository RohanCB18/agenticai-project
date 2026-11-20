import { describe, expect, it } from "vitest";

// A real browsing task: Sarvam drives Chromium in a Vercel Sandbox on the GST portal. Off by
// default: set BROWSER_LIVE=1 with BROWSER_SANDBOX_SNAPSHOT, Vercel credentials (VERCEL_OIDC_TOKEN)
// and SARVAM_API_KEY (loaded from .env.local below).
const live = process.env.BROWSER_LIVE === "1";
if (live) process.loadEnvFile(".env.local");

describe.skipIf(!live)("browsing the GST portal", () => {
  it("finds an item's HSN code on the official HSN search", async () => {
    const { lookUpOnGstPortal } = await import("./browser");
    const started = Date.now();
    const result = await lookUpOnGstPortal("What is the HSN code for makhana (fox nut)?");
    console.log(`browse took ${((Date.now() - started) / 1000).toFixed(1)} s in ${result.steps} steps:`, result);
    expect(result.found).toBe(true);
    expect(result.answer).toMatch(/0802|0813|2008/);
    expect(result.source).toMatch(/^https:\/\/[a-z.]*gst\.gov\.in\//);
  }, 200_000);
});
