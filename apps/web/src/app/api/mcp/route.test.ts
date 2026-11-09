import { beforeEach, describe, expect, it, vi } from "vitest";

// Sign-in at the door of /api/mcp: no token or a bad one gets a 401 that points the host at the
// OAuth metadata; a good token for an account without a shop gets a plain answer.

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" } }));

const claims = vi.fn();
const merchant = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getClaims: (token: string) => claims(token) },
    from: () => ({ select: () => ({ maybeSingle: () => merchant() }) }),
  }),
}));

const { POST, OPTIONS } = await import("./route");
const { GET: metadata } = await import("../../.well-known/oauth-protected-resource/route");

const post = (headers: Record<string, string> = {}) =>
  POST(new Request("https://munshi.test/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }));

describe("/api/mcp sign-in", () => {
  beforeEach(() => {
    claims.mockReset();
    merchant.mockReset();
  });

  it("asks a host without a token to sign in, and says where", async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://munshi.test/.well-known/oauth-protected-resource/api/mcp"');
    expect(claims).not.toHaveBeenCalled();
  });

  it("rejects a token Supabase doesn't accept", async () => {
    claims.mockResolvedValue({ data: null, error: new Error("invalid JWT") });
    const response = await post({ authorization: "Bearer forged" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("explains when the account has no shop", async () => {
    claims.mockResolvedValue({ data: { claims: { sub: "user-1", client_id: "claude" } }, error: null });
    merchant.mockResolvedValue({ data: null, error: null });
    const response = await post({ authorization: "Bearer good" });
    expect(response.status).toBe(403);
    expect(claims).toHaveBeenCalledWith("good");
  });

  it("answers browser preflights and shares the challenge header", async () => {
    const preflight = OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect((await post()).headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
  });

  it("publishes Supabase Auth as the authorization server for /api/mcp", async () => {
    const body = await metadata(new Request("https://munshi.test/.well-known/oauth-protected-resource")).json();
    expect(body).toMatchObject({
      resource: "https://munshi.test/api/mcp",
      authorization_servers: ["https://ref.supabase.co/auth/v1"],
      bearer_methods_supported: ["header"],
    });
  });
});
