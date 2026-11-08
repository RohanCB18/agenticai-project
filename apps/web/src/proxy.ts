import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
