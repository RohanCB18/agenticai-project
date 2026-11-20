// Munshi's browser bridge. Runs inside the Vercel Sandbox, not in the app: it starts Playwright MCP
// over stdio and answers tool calls on 127.0.0.1 only. The app reaches it through the sandbox's
// command channel (runCommand + curl), so the browser is never exposed to the internet, and the
// sandbox's network policy decides which sites the browser itself can reach.
//
// POST {"op":"tools"}                         -> the MCP tool list
// POST {"op":"call","name":...,"args":{...}}  -> the tool's MCP result

import { execSync } from "node:child_process";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 9000;
const cli = `${execSync("npm root --global").toString().trim()}/@playwright/mcp/cli.js`;

const client = new Client({ name: "munshi-browser-bridge", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    // Headless Chromium with an in-memory profile: nothing is saved between tasks.
    args: [cli, "--headless", "--browser", "chromium", "--no-sandbox", "--isolated", "--viewport-size", "1280x800", "--timeout-navigation", "30000"],
    stderr: "inherit",
  }),
);

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { op, name, args } = JSON.parse(body || "{}");
      const result = op === "tools" ? await client.listTools() : await client.callTool({ name, arguments: args ?? {} });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`bridge ready on 127.0.0.1:${PORT}`));
