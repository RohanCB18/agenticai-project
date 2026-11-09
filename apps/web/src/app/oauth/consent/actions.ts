"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** The owner's answer on the consent page. Supabase returns where to send them back to the app. */
export async function decide(formData: FormData) {
  const authorizationId = formData.get("authorization_id");
  if (typeof authorizationId !== "string" || !authorizationId) redirect("/dashboard");

  const supabase = await createClient();
  const options = { skipBrowserRedirect: true };
  const { data, error } =
    formData.get("decision") === "allow"
      ? await supabase.auth.oauth.approveAuthorization(authorizationId, options)
      : await supabase.auth.oauth.denyAuthorization(authorizationId, options);
  if (error || !data?.redirect_url) redirect(`/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}&failed=1`);
  redirect(data.redirect_url);
}
