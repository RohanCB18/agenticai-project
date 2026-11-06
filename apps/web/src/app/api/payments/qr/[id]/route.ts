import { createClient } from "@/lib/supabase/server";

/** The QR image for the web chat. Read as the signed-in user, so RLS keeps it to their shop. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return new Response("Sign in first", { status: 401 });

  const { data } = await supabase.from("payment_qrs").select("qr_png").eq("id", id).maybeSingle();
  if (!data) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(data.qr_png, "base64"), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
}
