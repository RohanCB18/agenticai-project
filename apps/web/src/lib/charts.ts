import "server-only";
import type { ChartRunner } from "@munshi/agents";
import { Sandbox } from "@vercel/sandbox";

// Runs a chart program the agent wrote in a Vercel Sandbox: a fresh microVM started from a snapshot
// with pandas and matplotlib installed (scripts/build-chart-snapshot.mjs), with no network access and
// no secrets, stopped right after. Model-written code never runs in the app itself.

const REGION = "bom1"; // where the snapshot lives, next to the app
/** The whole chart: start the sandbox, run the program, read the picture. Fits inside a chat turn. */
export const CHART_TIMEOUT_MS = 25_000;
const PROGRAM_TIMEOUT_MS = 15_000;
const WORKDIR = "/vercel/sandbox";

// Runs before the agent's code: a headless backend, and fonts that exist in the image.
const PRELUDE = 'import matplotlib\nmatplotlib.use("Agg")\n';

export function createSandboxChartRunner(snapshotId: string): ChartRunner {
  return {
    async run({ code, files }) {
      const signal = AbortSignal.timeout(CHART_TIMEOUT_MS);
      const sandbox = await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        region: REGION,
        networkPolicy: "deny-all",
        timeout: 2 * 60 * 1000, // the platform stops it even if stop() below never runs
        persistent: false,
        signal,
      });
      try {
        await sandbox.writeFiles(
          [
            ...Object.entries(files).map(([path, content]) => ({ path: `${WORKDIR}/${path}`, content: Buffer.from(content) })),
            { path: `${WORKDIR}/chart.py`, content: Buffer.from(PRELUDE + code) },
          ],
          { signal },
        );
        const result = await sandbox.runCommand({ cmd: "python", args: ["chart.py"], cwd: WORKDIR, signal, timeoutMs: PROGRAM_TIMEOUT_MS });
        const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
        if (result.exitCode !== 0) return { ok: false, error: stderr.trim().slice(-1500) || `The program stopped with exit code ${result.exitCode}.` };
        const png = await sandbox.readFileToBuffer({ path: `${WORKDIR}/chart.png` }, { signal });
        if (!png?.length) return { ok: false, error: "The program ran but didn't save chart.png." };
        return { ok: true, png: new Uint8Array(png), stdout: stdout.trim().slice(-600) };
      } finally {
        await sandbox.stop().catch(() => {});
      }
    },
  };
}

/** Charts are on when CHART_SANDBOX_SNAPSHOT names the snapshot to start from. */
export function configuredChartRunner(): ChartRunner | undefined {
  const snapshotId = process.env.CHART_SANDBOX_SNAPSHOT;
  return snapshotId ? createSandboxChartRunner(snapshotId) : undefined;
}
