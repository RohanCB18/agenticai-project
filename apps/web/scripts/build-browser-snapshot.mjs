// Builds the Vercel Sandbox snapshot the browser agent runs in: Ubuntu with Playwright MCP, Chromium
// (and the system libraries it needs) and Munshi's browser bridge (sandbox/browser-bridge.mjs)
// installed, so a browsing task starts in seconds. Run again after changing the bridge or to
// upgrade Playwright MCP.
//
// Run from a folder linked with `vercel link`:  node <path>/apps/web/scripts/build-browser-snapshot.mjs
// Then set BROWSER_SANDBOX_SNAPSHOT to the printed id, in .env.local and in Vercel.

import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";

const REGION = "bom1";
const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.84";
const MCP_SDK = "@modelcontextprotocol/sdk@1.32.2";

const sandbox = await Sandbox.create({ image: "vercel/sandbox/universal", region: REGION, timeout: 20 * 60 * 1000, persistent: false });
const run = async (script) => {
  const result = await sandbox.runCommand("bash", ["-lc", `set -e; ${script}`]);
  if (result.exitCode !== 0) throw new Error(`${script} failed:\n${(await result.stderr()).slice(-2500)}\n${(await result.stdout()).slice(-1000)}`);
  return (await result.stdout()).trim();
};

try {
  console.log(`installing ${PLAYWRIGHT_MCP}…`);
  await run(`npm install --global --no-fund --no-audit ${PLAYWRIGHT_MCP}`);
  console.log("installing Chromium and its libraries…");
  await run('cd "$(npm root --global)/@playwright/mcp" && npx --no-install playwright install --with-deps chromium');
  await run('test -f "$(npm root --global)/@playwright/mcp/cli.js"');

  console.log("installing the bridge…");
  const home = await run("echo $HOME");
  await sandbox.writeFiles([
    { path: `${home}/munshi-browser/package.json`, content: Buffer.from(JSON.stringify({ name: "munshi-browser", private: true, type: "module" })) },
    { path: `${home}/munshi-browser/bridge.mjs`, content: await readFile(new URL("../sandbox/browser-bridge.mjs", import.meta.url)) },
  ]);
  await run(`cd ~/munshi-browser && npm install --no-fund --no-audit ${MCP_SDK}`);

  // Smoke test: the bridge starts and lists Playwright's tools.
  await sandbox.runCommand({ cmd: "bash", args: ["-lc", "cd ~/munshi-browser && node bridge.mjs > /tmp/bridge.log 2>&1"], detached: true });
  const tools = await run(
    "for i in $(seq 1 40); do curl -s --max-time 5 -X POST 127.0.0.1:9000 -d '{\"op\":\"tools\"}' && exit 0; sleep 0.5; done; cat /tmp/bridge.log; exit 1",
  );
  console.log(`bridge lists ${JSON.parse(tools).tools.length} tools`);

  const snapshot = await sandbox.snapshot({ expiration: 0 }); // stops the sandbox
  console.log(`\nBROWSER_SANDBOX_SNAPSHOT=${snapshot.snapshotId}`);
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
