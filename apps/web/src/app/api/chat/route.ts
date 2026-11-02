import { createKhataAgent, MissingModelKeyError, resolveModel } from "@munshi/agents";
import { createAgentUIStreamResponse } from "ai";
import { createSupabaseKhataStore } from "@/lib/khata-store";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ error: "Sign in to use Munshi." }, { status: 401 });

  // Without this secret a client could forge an "approved" payment in the chat history.
  const approvalSecret = process.env.TOOL_APPROVAL_SECRET;
  if (!approvalSecret) {
    return Response.json({ error: "TOOL_APPROVAL_SECRET is missing. Generate one with `openssl rand -base64 32` and add it to apps/web/.env.local." }, { status: 503 });
  }

  const { data: merchant } = await supabase.from("merchants").select("id, shop_name, preferred_language").single();
  if (!merchant) return Response.json({ error: "No shop found for this account." }, { status: 404 });

  let model;
  try {
    model = resolveModel(
      {
        sarvamApiKey: process.env.SARVAM_API_KEY,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        fallbackModel: process.env.MUNSHI_FALLBACK_MODEL,
      },
      (error) => console.warn("[munshi] Sarvam failed, falling back to Claude:", error instanceof Error ? error.message : error),
    );
  } catch (error) {
    if (error instanceof MissingModelKeyError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }

  const { messages } = await request.json();
  const agent = createKhataAgent({
    model,
    store: createSupabaseKhataStore(supabase, merchant.id, { source: "chat" }),
    shopName: merchant.shop_name,
    language: merchant.preferred_language,
    approvalSecret,
  });

  return createAgentUIStreamResponse({ agent, uiMessages: messages });
}
