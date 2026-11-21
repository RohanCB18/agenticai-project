import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWebChat } from "@/lib/web-chat";
import { Chat } from "./chat";

export default function ChatPage() {
  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between gap-4 border-b border-line py-4">
        <div>
          <p className="font-display text-xl font-semibold">Munshi</p>
          <p className="text-sm text-muted">Say it the way you&apos;d tell your helper.</p>
        </div>
        <Link href="/dashboard" className="text-sm text-muted underline-offset-4 hover:underline">
          Khata
        </Link>
      </header>
      <Suspense fallback={<p className="flex-1 py-6 text-muted">Opening your chat…</p>}>
        <SavedChat />
      </Suspense>
    </main>
  );
}

/** The conversation as it was left, so a refresh or another device carries on from there. */
async function SavedChat() {
  await connection();
  const merchant = await getCurrentMerchant();
  const messages = await loadWebChat(await createClient(), merchant.id);
  return <Chat initialMessages={messages} />;
}
