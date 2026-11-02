import Link from "next/link";
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
      <Chat />
    </main>
  );
}
