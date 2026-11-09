import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { decide } from "./actions";

// Supabase Auth sends the owner here when an MCP host (Claude, ChatGPT, an IDE) asks to use
// their khata. Signed-out owners are sent to /login first and come back here.

export default function ConsentPage({ searchParams }: PageProps<"/oauth/consent">) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-16">
      <Suspense fallback={<p className="text-muted">Checking the request…</p>}>
        <Consent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const CAN_DO = [
  "See who owes you, your sales and your stock",
  "Record udhaar, payments, sales and stock changes",
  "Send a customer a UPI payment link when you ask it to",
];

async function Consent({ searchParams }: { searchParams: PageProps<"/oauth/consent">["searchParams"] }) {
  await connection();
  const { authorization_id: id, failed } = await searchParams;
  if (typeof id !== "string" || !id) return <Problem text="This link is missing its request. Start connecting again from the app you were using." />;

  const merchant = await getCurrentMerchant();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) return <Problem text="This request has expired or was already answered. Start connecting again from the app you were using." />;
  // Already allowed before: Supabase hands back the redirect straight away.
  if (!("authorization_id" in data)) redirect(data.redirect_url);

  const app = data.client.name || "An app";
  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="text-sm uppercase tracking-wider text-muted">Connect to Munshi</p>
        <h1 className="font-display text-2xl font-semibold">
          {app} wants to use the khata of {merchant.shopName}
        </h1>
        {data.client.uri ? <p className="text-sm text-muted break-all">{data.client.uri}</p> : null}
      </div>
      <div className="rounded-lg border border-line bg-surface p-5">
        <p className="mb-3 text-sm text-muted">If you allow it, {app} can:</p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          {CAN_DO.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">
          Signed in as {data.user.email}. You can disconnect it any time from {app}.
        </p>
      </div>
      {failed ? <p className="text-sm text-red-600">That didn&apos;t go through. Please try again.</p> : null}
      <form action={decide} className="flex gap-3">
        <input type="hidden" name="authorization_id" value={data.authorization_id} />
        <button name="decision" value="allow" className="flex-1 rounded-md bg-accent px-4 py-2 font-medium text-on-accent">
          Allow
        </button>
        <button name="decision" value="deny" className="flex-1 rounded-md border border-line px-4 py-2 font-medium">
          Don&apos;t allow
        </button>
      </form>
    </>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="font-display text-2xl font-semibold">Can&apos;t connect</h1>
      <p className="text-muted">{text}</p>
    </div>
  );
}
