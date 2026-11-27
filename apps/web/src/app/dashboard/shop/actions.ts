"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMerchant } from "@/lib/auth";
import { addSampleProducts, refillLowStock, setStoreOpen } from "@/lib/online-shop";
import { createAdminClient } from "@/lib/supabase/admin";

// The owner's controls for their online store. Signed in: each acts on their own shop only.

export async function setShopOpen(open: boolean): Promise<{ slug: string | null } | { error: string }> {
  const merchant = await getCurrentMerchant();
  try {
    const result = await setStoreOpen(createAdminClient(), merchant.id, open);
    revalidatePath("/dashboard/shop");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't change the store." };
  }
}

export async function addSamples(): Promise<{ added: number; priced: number } | { error: string }> {
  const merchant = await getCurrentMerchant();
  try {
    const result = await addSampleProducts(createAdminClient(), merchant.id);
    revalidatePath("/dashboard/shop");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't add the products." };
  }
}

export async function refillLow(): Promise<{ refilled: string[] } | { error: string }> {
  const merchant = await getCurrentMerchant();
  try {
    const result = await refillLowStock(createAdminClient(), merchant.id);
    revalidatePath("/dashboard/shop");
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Couldn't refill the stock." };
  }
}
