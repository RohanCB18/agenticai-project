"use server";

import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { clearWebChat } from "@/lib/web-chat";

/** Clears the saved web chat. The khata itself is untouched: only the conversation goes. */
export async function startNewChat() {
  const merchant = await getCurrentMerchant();
  await clearWebChat(await createClient(), merchant.id);
}
