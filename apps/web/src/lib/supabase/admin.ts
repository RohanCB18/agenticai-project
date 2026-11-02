import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Bypasses RLS. Only for server code with no user session (webhooks) or for writes
 * the user must not be able to forge (payment link rows). Never import from client code.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("SUPABASE_SECRET_KEY is missing. Copy the secret key from `npx supabase status` into apps/web/.env.local.");
  }
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}
