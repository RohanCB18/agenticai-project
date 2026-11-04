"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MessagingChannel } from "@/lib/channels/types";

type Props = {
  channel: MessagingChannel;
  /** Who is linked: the Telegram profile name, or a masked WhatsApp number. */
  linkedAs: string | null;
  configured: boolean;
};

const COPY: Record<MessagingChannel, { name: string; setup: string }> = {
  telegram: { name: "Telegram", setup: "Create a bot with @BotFather and add TELEGRAM_BOT_TOKEN to apps/web/.env.local." },
  whatsapp: { name: "WhatsApp", setup: "Add the WhatsApp Cloud API keys to apps/web/.env.local." },
};

export function ChannelCard({ channel, linkedAs, configured }: Props) {
  const router = useRouter();
  const [link, setLink] = useState<{ code: string; url: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { name, setup } = COPY[channel];

  async function call(method: "POST" | "DELETE") {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/link?channel=${channel}`, { method });
      const body = res.status === 204 ? null : ((await res.json()) as { code?: string; url?: string | null; error?: string });
      if (!res.ok) throw new Error(body?.error ?? "Something went wrong.");
      if (method === "POST" && body?.code) setLink({ code: body.code, url: body.url ?? null });
      else router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  if (linkedAs) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-surface p-5">
        <div>
          <p className="font-medium">{name} connected</p>
          <p className="text-sm text-muted">Voice notes and texts from {linkedAs} go into this khata.</p>
        </div>
        <button onClick={() => call("DELETE")} disabled={pending} className="text-sm text-muted underline-offset-4 hover:underline disabled:opacity-50">
          Disconnect
        </button>
        {error && <p className="w-full text-sm text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5">
      <div>
        <p className="font-medium">Connect {name}</p>
        <p className="text-sm text-muted">Send Munshi voice notes from your phone, in any language.</p>
      </div>

      {!configured ? (
        <p className="text-sm text-muted">{setup}</p>
      ) : link ? (
        <div className="flex flex-col gap-2 text-sm">
          {channel === "telegram" && link.url ? (
            <>
              <a href={link.url} target="_blank" rel="noreferrer" className="self-start rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
                Open Munshi in Telegram
              </a>
              <p className="text-muted">Tap Start in Telegram. The link works once, for 15 minutes.</p>
            </>
          ) : (
            <>
              <p>From your phone, send this on WhatsApp within 15 minutes:</p>
              <p className="self-start rounded-md border border-accent bg-paper px-3 py-2 font-mono text-lg tracking-wider">MUNSHI {link.code}</p>
              {link.url && (
                <a href={link.url} target="_blank" rel="noreferrer" className="self-start text-accent underline-offset-4 hover:underline">
                  Open in WhatsApp
                </a>
              )}
            </>
          )}
          <button onClick={() => router.refresh()} className="self-start text-muted underline-offset-4 hover:underline">
            Done, refresh
          </button>
        </div>
      ) : (
        <button
          onClick={() => call("POST")}
          disabled={pending}
          className="self-start rounded-md border border-line px-4 py-2 text-sm font-medium hover:border-accent disabled:opacity-50"
        >
          {pending ? "Creating link…" : `Connect ${name}`}
        </button>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
