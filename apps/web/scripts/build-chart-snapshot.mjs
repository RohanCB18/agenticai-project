// Builds the Vercel Sandbox snapshot charts run in: Python 3.13 with pandas and matplotlib already
// installed and the font cache warm, so a chart starts in seconds instead of installing packages
// each time. Run again only to upgrade the libraries.
//
// Run from apps/web:  node scripts/build-chart-snapshot.mjs
// (locally it signs in with your Vercel CLI login; on Vercel, with the project's OIDC token)
// Then set CHART_SANDBOX_SNAPSHOT to the printed id, in .env.local and in Vercel.

import { Sandbox } from "@vercel/sandbox";

const REGION = "bom1"; // next to the app's functions and Supabase (Mumbai)

const sandbox = await Sandbox.create({ runtime: "python3.13", region: REGION, timeout: 10 * 60 * 1000, persistent: false });
const run = async (cmd, args) => {
  const result = await sandbox.runCommand(cmd, args);
  if (result.exitCode !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${(await result.stderr()).slice(-2000)}`);
  return (await result.stdout()).trim();
};

try {
  console.log("installing pandas and matplotlib…");
  await run("pip", ["install", "--quiet", "--no-cache-dir", "pandas>=2.2,<4", "matplotlib>=3.9,<4"]);
  // The first matplotlib import builds its font cache (several seconds): do it here, once.
  console.log(await run("python", ["-c", "import matplotlib, pandas; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.figure(); plt.savefig('/tmp/warm.png'); print('matplotlib', matplotlib.__version__, 'pandas', pandas.__version__)"]));
  const snapshot = await sandbox.snapshot({ expiration: 0 }); // stops the sandbox
  console.log(`\nCHART_SANDBOX_SNAPSHOT=${snapshot.snapshotId}`);
} catch (error) {
  await sandbox.stop().catch(() => {});
  throw error;
}
