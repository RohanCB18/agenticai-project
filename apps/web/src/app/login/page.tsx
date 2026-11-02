import { Suspense } from "react";
import { AuthForm } from "./auth-form";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-4 py-16">
      <div className="flex flex-col gap-2">
        <p className="font-display text-3xl font-semibold">Munshi</p>
        <p className="text-muted">Your shop&apos;s books, kept by voice.</p>
      </div>
      <Suspense fallback={<AuthForm />}>
        <FormWithNext searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function FormWithNext({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { next } = await searchParams;
  return <AuthForm next={typeof next === "string" ? next : undefined} />;
}
