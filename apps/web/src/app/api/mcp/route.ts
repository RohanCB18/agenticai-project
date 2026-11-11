import { createMcpHandler } from "@modelcontextprotocol/server";
import { createSupabaseKhataStore } from "@/lib/khata-store";
import { configuredKnowledge } from "@/lib/knowledge";
import { authenticate, unauthorized } from "@/lib/mcp/auth";
import { createMunshiMcpServer } from "@/lib/mcp/server";

export const maxDuration = 60;

// Remote MCP endpoint (Streamable HTTP, stateless). Hosts connect to https://<app>/api/mcp and
// sign in with OAuth (see lib/mcp/auth.ts). Each request gets a fresh server for the caller's shop.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

async function serve(request: Request) {
  const origin = new URL(request.url).origin;
  const caller = await authenticate(request);
  if (!caller) return unauthorized(origin, request.headers.has("authorization") ? "invalid_token" : undefined);

  // RLS: the caller's token only sees their own shop.
  const { data: merchant } = await caller.db.from("merchants").select("id, shop_name").maybeSingle();
  if (!merchant) return Response.json({ error: "This account has no Munshi shop yet. Sign up at Munshi first." }, { status: 403 });

  const store = createSupabaseKhataStore(caller.db, merchant.id, { source: "mcp", actor: `mcp:${caller.clientId}` });
  const handler = createMcpHandler(() => createMunshiMcpServer({ store, shopName: merchant.shop_name, knowledge: configuredKnowledge() }), {
    onerror: (error) => console.error("[munshi] mcp request failed:", error.message),
  });
  return handler.fetch(request, { authInfo: { token: caller.token, clientId: caller.clientId, scopes: [], expiresAt: caller.expiresAt } });
}

async function withCors(request: Request) {
  const response = await serve(request);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const GET = withCors;
export const POST = withCors;
export const DELETE = withCors;
export const OPTIONS = () => new Response(null, { status: 204, headers: CORS });
