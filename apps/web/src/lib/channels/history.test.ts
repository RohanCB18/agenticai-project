import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { rememberInThread } from "./history";

type Thread = { merchant_id: string; channel: string; messages: unknown[]; updated_at: string };

/** agent_threads, in memory: enough for reading, updating and adding a thread. */
function fakeDb(threads: Thread[]) {
  const from = () => {
    const filters: [string, unknown][] = [];
    let patch: Partial<Thread> | null = null;
    const rows = () => threads.filter((t) => filters.every(([k, v]) => t[k as keyof Thread] === v));
    const q = {
      select: () => q,
      update: (values: Partial<Thread>) => ((patch = values), q),
      insert: async (row: Thread) => (threads.push(row), { error: null }),
      eq: (key: string, value: unknown) => (filters.push([key, value]), q),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (r: { error: null }) => void) => {
        for (const row of rows()) Object.assign(row, patch);
        resolve({ error: null });
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

describe("Munshi's own messages in the chat history", () => {
  it("are added after the conversation so far, without moving its last-reply time", async () => {
    // A typed "haan" answers a restock ask only if the ask came after Munshi's last reply, which
    // updated_at marks: the ask going into the history mustn't move it.
    const thread: Thread = { merchant_id: "m1", channel: "telegram", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Namaste" }], updated_at: "2026-11-28T03:00:00Z" };
    const db = fakeDb([thread]);
    await rememberInThread(db, "m1", "telegram", { munshi: "📦 Running low: Maggi Noodles 9 packet left." });
    expect(thread.messages.at(-1)).toEqual({ role: "assistant", content: "📦 Running low: Maggi Noodles 9 packet left." });
    expect(thread.updated_at).toBe("2026-11-28T03:00:00Z");
  });

  it("keep the owner's typed answer with Munshi's reply to it", async () => {
    const thread: Thread = { merchant_id: "m1", channel: "telegram", messages: [], updated_at: "2026-11-28T03:00:00Z" };
    await rememberInThread(fakeDb([thread]), "m1", "telegram", { owner: "haan", munshi: "✅ Order ST-1 placed with Sharma Traders." });
    expect(thread.messages).toEqual([
      { role: "user", content: "haan" },
      { role: "assistant", content: "✅ Order ST-1 placed with Sharma Traders." },
    ]);
  });

  it("start a chat that has no history yet, dated so any later ask still counts as new", async () => {
    const threads: Thread[] = [];
    await rememberInThread(fakeDb(threads), "m1", "whatsapp", { munshi: "🛒 New online order" });
    expect(threads).toEqual([{ merchant_id: "m1", channel: "whatsapp", messages: [{ role: "assistant", content: "🛒 New online order" }], updated_at: "1970-01-01T00:00:00.000Z" }]);
  });

  it("never fail the message they follow", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { from: () => ({ select: () => { throw new Error("database down"); } }) } as unknown as SupabaseClient;
    await expect(rememberInThread(broken, "m1", "telegram", { munshi: "hi" })).resolves.toBeUndefined();
    quiet.mockRestore();
  });
});
