import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

// MCP hosts sign in with OAuth 2.1, and Supabase Auth is the authorization server: the host
// registers itself, sends the owner to Munshi's consent page (/oauth/consent), and gets a token for
// that owner. The token is an ordinary Supabase user token, so every query made with it is still
// filtered by Row Level Security to the owner's own shop.

export const MCP_PATH = "/api/mcp";

/** The Supabase Auth issuer, which hosts discover as the authorization server. */
export const authorizationServer = () => `${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;

/** RFC 9728 protected resource metadata: where a host learns how to get a token for /api/mcp. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    resource_name: "Munshi",
    authorization_servers: [authorizationServer()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
  };
}

export const metadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** 401 that tells an MCP host where to start signing in. */
export function unauthorized(origin: string, error?: "invalid_token") {
  const challenge = [`Bearer resource_metadata="${metadataUrl(origin)}"`, error ? `error="${error}"` : null].filter(Boolean).join(", ");
  return Response.json({ error: error ?? "Sign in to Munshi to use this server." }, { status: 401, headers: { "WWW-Authenticate": challenge } });
}

export type McpCaller = { db: SupabaseClient; userId: string; clientId: string; token: string; expiresAt?: number };

/** Checks the bearer token and returns a database client that acts as its owner, or null. */
export async function authenticate(request: Request): Promise<McpCaller | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Verifies the signature (against Supabase's published keys) and the expiry.
  const { data, error } = await db.auth.getClaims(token);
  const claims = data?.claims as { sub?: string; client_id?: string; exp?: number } | undefined;
  if (error || !claims?.sub) return null;
  return { db, userId: claims.sub, clientId: claims.client_id ?? "session", token, expiresAt: claims.exp };
}
