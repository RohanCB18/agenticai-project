import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-4 py-20">
      <p className="text-sm uppercase tracking-wider text-accent">ಮುನ್ಷಿ · मुंशी · Munshi</p>
      <h1 className="font-display text-5xl font-semibold leading-tight text-balance">
        Your shop&apos;s accountant, in your language.
      </h1>
      <p className="max-w-xl text-lg text-muted">
        Tell Munshi who took what on credit, what came in, and what to reorder. It keeps the khata, collects udhaar over
        UPI, and pays suppliers, but only after you say haan.
      </p>
      <div>
        <Link href="/dashboard" className="inline-block rounded-md bg-accent px-5 py-3 font-medium text-on-accent">
          Open my khata
        </Link>
      </div>
    </main>
  );
}
