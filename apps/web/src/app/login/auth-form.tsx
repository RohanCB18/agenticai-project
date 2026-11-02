"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type AuthState } from "./actions";

const LANGUAGES = [
  { value: "kn", label: "ಕನ್ನಡ Kannada" },
  { value: "hi", label: "हिन्दी Hindi" },
  { value: "ta", label: "தமிழ் Tamil" },
  { value: "bn", label: "বাংলা Bengali" },
  { value: "en", label: "English" },
];

const field =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function AuthForm({ next }: { next?: string }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [state, action, pending] = useActionState<AuthState, FormData>(mode === "signin" ? signIn : signUp, {});

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next ?? ""} />
      {mode === "signup" && (
        <>
          <label className="flex flex-col gap-1.5 text-sm">
            Shop name
            <input id="shopName" name="shopName" required className={field} placeholder="Lakshmi General Stores" />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Language Munshi should speak
            <select id="preferredLanguage" name="preferredLanguage" defaultValue="kn" className={field}>
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="flex flex-col gap-1.5 text-sm">
        Email
        <input id="email" name="email" type="email" autoComplete="email" required className={field} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Password
        <input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          minLength={8}
          required
          className={field}
        />
      </label>

      {state.error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-4 py-2.5 font-medium text-on-accent transition-opacity disabled:opacity-60"
      >
        {pending ? "Please wait…" : mode === "signin" ? "Sign in" : "Create shop account"}
      </button>

      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="text-sm text-muted underline-offset-4 hover:underline"
      >
        {mode === "signin" ? "New shop? Create an account" : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
