"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addSamples, refillLow, setShopOpen } from "./actions";

const button = "rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-accent disabled:opacity-50";

/** Opens or closes the store, and copies its link. */
export function OpenControls({ open, url }: { open: boolean; url: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const toggle = () =>
    startTransition(async () => {
      const result = await setShopOpen(!open);
      setNote("error" in result ? result.error : null);
      router.refresh();
    });

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNote("Link copied.");
    } catch {
      setNote(url);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={toggle} disabled={pending} className={open ? button : "rounded-md bg-accent px-4 py-2 font-medium text-on-accent disabled:opacity-50"}>
        {pending ? "…" : open ? "Close the store" : "Open the online store"}
      </button>
      {open && url && (
        <>
          <a href={url} target="_blank" rel="noreferrer" className="rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
            Open the store ↗
          </a>
          <button type="button" onClick={copy} className={button}>
            Copy link
          </button>
        </>
      )}
      {note && <p className="w-full text-sm text-muted">{note}</p>}
    </div>
  );
}

/** For a demo: fill the shelves with a supermarket's range, and refill what ran low. */
export function DemoControls() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const run = (what: "samples" | "refill") =>
    startTransition(async () => {
      if (what === "samples") {
        const result = await addSamples();
        setNote(
          "error" in result
            ? result.error
            : result.added + result.priced === 0
              ? "The shop already sells all of them."
              : `Added ${result.added} product${result.added === 1 ? "" : "s"}${result.priced ? `, and priced ${result.priced} of yours` : ""}.`,
        );
      } else {
        const result = await refillLow();
        setNote("error" in result ? result.error : result.refilled.length ? `Refilled ${result.refilled.join(", ")}.` : "Nothing is low.");
      }
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={() => run("samples")} disabled={pending} className={button}>
        Add a supermarket&apos;s range
      </button>
      <button type="button" onClick={() => run("refill")} disabled={pending} className={button}>
        Refill low items
      </button>
      {note && <p className="w-full text-sm text-muted">{note}</p>}
    </div>
  );
}
