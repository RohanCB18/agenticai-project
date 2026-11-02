import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Merchant = {
  id: string;
  shopName: string;
  ownerName: string | null;
  preferredLanguage: "kn" | "hi" | "ta" | "bn" | "en";
};

/**
 * Data access layer: the one place that turns the session into a merchant.
 * Must be called inside a <Suspense> boundary (it reads cookies).
 */
export async function getCurrentMerchant(): Promise<Merchant> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");

  const { data, error } = await supabase
    .from("merchants")
    .select("id, shop_name, owner_name, preferred_language")
    .single();

  if (error || !data) redirect("/login");

  return {
    id: data.id,
    shopName: data.shop_name,
    ownerName: data.owner_name,
    preferredLanguage: data.preferred_language,
  };
}
