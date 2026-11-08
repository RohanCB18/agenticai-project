import { type Desk, MissingModelKeyError } from "@munshi/agents";
import { createAgentUIStreamResponse } from "ai";
import { ApprovalSecretMissingError, buildKhataAgent } from "@/lib/agent";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ error: "Sign in to use Munshi." }, { status: 401 });

  const { data: merchant } = await supabase.from("merchants").select("id, shop_name, preferred_language").single();
  if (!merchant) return Response.json({ error: "No shop found for this account." }, { status: 404 });

  const { messages } = (await request.json()) as { messages: { role?: string; metadata?: { source?: string } }[] };
  // The chat UI marks spoken messages; entries from them are logged with source "voice".
  const lastUser = messages.findLast((m) => m.role === "user");
  const source = lastUser?.metadata?.source === "voice" ? "voice" : "chat";

  let agent;
  let desk: Desk | undefined;
  try {
    agent = buildKhataAgent({
      db: supabase,
      merchant: { id: merchant.id, shopName: merchant.shop_name, language: merchant.preferred_language },
      source,
      onRoute: (route) => void (desk = route.desk),
    });
  } catch (error) {
    if (error instanceof ApprovalSecretMissingError || error instanceof MissingModelKeyError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messages,
    // The chat shows which desk answered.
    messageMetadata: ({ part }) => (part.type === "finish" && desk ? { desk } : undefined),
    // Tool and stream errors are masked as "An error occurred." by default. Log the real
    // cause, and show it in the chat during development so failures are debuggable.
    onError: (error) => {
      console.error("[munshi] chat error:", error);
      if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
      return "Something went wrong. Please try again.";
    },
  });
}
