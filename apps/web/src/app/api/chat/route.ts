import { type Desk, type KhataUIMessage, MissingModelKeyError } from "@munshi/agents";
import { createAgentUIStreamResponse, createIdGenerator } from "ai";
import { after } from "next/server";
import { ApprovalSecretMissingError, buildKhataAgent } from "@/lib/agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { watchPayouts } from "@/lib/supplier-payouts";
import { flushTraces, traced } from "@/lib/telemetry";
import { closeStaleApprovals, replySummary, saveWebChat } from "@/lib/web-chat";

export const maxDuration = 60;
const FUNCTION_LIMIT_MS = 55_000; // what's safe to use of the 60 s
const PAYOUT_WATCH_MS = 40_000;

/** Whether this reply started a supplier payment that Cashfree hasn't finished yet. */
function startedPayout(message: KhataUIMessage) {
  return message.parts.some(
    (part) => part.type === "tool-paySupplier" && part.state === "output-available" && (part.output as { status?: string } | undefined)?.status === "payout_started",
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ error: "Sign in to use Munshi." }, { status: 401 });

  const { data: merchant } = await supabase.from("merchants").select("id, shop_name, preferred_language").single();
  if (!merchant) return Response.json({ error: "No shop found for this account." }, { status: 404 });

  const body = (await request.json()) as { messages: KhataUIMessage[] };
  const messages = closeStaleApprovals(body.messages);
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

  // after() runs once the stream has finished, so the trace is complete before it is sent. A
  // supplier payment approved in this run is then watched, so the owner hears how it ended (on
  // Telegram, and on the Suppliers page) even if Cashfree's webhook never comes.
  let payoutStarted = false;
  after(async () => {
    await flushTraces();
    if (!payoutStarted) return;
    const forMs = Math.min(PAYOUT_WATCH_MS, FUNCTION_LIMIT_MS - (Date.now() - startedAt));
    await watchPayouts(createAdminClient(), merchant.id, { forMs }).catch((error: unknown) =>
      console.error("[munshi] payout watch failed:", error instanceof Error ? error.message : error),
    );
  });
  const streamAgent = agent;
  return traced({ merchantId: merchant.id, channel: "chat", source: source === "voice" ? "voice" : undefined }, () =>
    createAgentUIStreamResponse({
      agent: streamAgent,
      uiMessages: messages,
      // Persistence mode: replies get stable ids, and onEnd hands back the whole conversation.
      originalMessages: messages as never,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      // The chat shows which desk answered.
      messageMetadata: ({ part }) => (part.type === "finish" && desk ? { desk } : undefined),
      // Saved so a refresh or another device opens the chat where it was left. The server's
      // client: the owner was checked above, and the request's cookies may be gone by now.
      onEnd: async ({ messages: updated, responseMessage, isAborted }) => {
        payoutStarted = startedPayout(responseMessage as KhataUIMessage);
        console.info(`[munshi] chat run: ${desk ?? "?"} desk, ${replySummary(responseMessage as KhataUIMessage)}${isAborted ? " (stopped)" : ""}`);
        await saveWebChat(createAdminClient(), merchant.id, updated as KhataUIMessage[]);
      },
      // Tool and stream errors are masked as "An error occurred." by default. Log the real
      // cause, and show it in the chat during development so failures are debuggable.
      onError: (error) => {
        console.error("[munshi] chat error:", error);
        if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
        return "Something went wrong. Please try again.";
      },
    }),
  );
}
