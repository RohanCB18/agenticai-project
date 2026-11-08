import type { Reminder } from "@munshi/agents";
import { sleep } from "workflow";
import type { LinkResult } from "@/lib/reminders";
import { ON_DEMAND_KEY, REMINDER_APPROVAL_PREFIX, reminderDecision, reminderToken } from "./reminder-hook";

// Udhaar reminders as a durable workflow: work out who is due, ask the owner on Telegram, wait
// for the tap (nothing runs while it waits), then make one payment link per customer. Each step
// is recorded and retried on its own, so a crash or a redeploy halfway through carries on where
// it stopped instead of asking twice or making the same links again.
//
// Steps import app code dynamically. The workflow body runs in a sandbox without Node, and this
// keeps Supabase, Cashfree and Telegram code out of it.

export type ReminderRunInput = { merchantId: string; chatId: string; key: string };

export type ReminderRunResult = {
  status: "nothing_due" | "listed" | "expired" | "declined" | "sent";
  customers: number;
  links: number;
};

/** An evening list stays open until the next morning. */
const ANSWER_WINDOW = "12h";

const NOTHING_DUE = "🔔 Nobody needs a reminder right now. Everyone with udhaar either paid recently, was asked in the last 3 days, or owes under ₹50.";

export async function udhaarReminders({ merchantId, chatId, key }: ReminderRunInput): Promise<ReminderRunResult> {
  "use workflow";
  // Bound to the token start() reserved, so the owner's tap reaches this run and no other.
  const decision = reminderDecision.create({ token: reminderToken(merchantId, key) });

  const plan = await planReminders(merchantId);
  const customers = plan.reminders.length;
  if (customers === 0) {
    // The evening list stays quiet when nobody is due; an owner who asked gets an answer.
    if (key === ON_DEMAND_KEY) await tell(chatId, NOTHING_DUE);
    return { status: "nothing_due", customers, links: 0 };
  }
  const reachable = plan.reminders.filter((r) => r.phone);
  if (reachable.length === 0) {
    await tell(chatId, plan.summary);
    return { status: "listed", customers, links: 0 };
  }

  await askOwner(chatId, plan.summary, `${REMINDER_APPROVAL_PREFIX}${key}`);
  const answer = await Promise.race([decision, sleep(ANSWER_WINDOW).then(() => null)]);
  if (!answer) return { status: "expired", customers, links: 0 };
  if (!answer.approved) {
    await tell(chatId, "Okay, no reminders this time.");
    return { status: "declined", customers, links: 0 };
  }

  const results: LinkResult[] = [];
  for (const reminder of reachable) {
    try {
      results.push(await makeLink(merchantId, plan.shopName, reminder));
    } catch {
      // The step already retried. One customer's failure shouldn't stop the others' links.
      results.push({ name: reminder.name, phone: reminder.phone, amount: reminder.amount, url: null, problem: "couldn't make a link, try again from chat" });
    }
  }
  await report(chatId, plan.shopName, results);
  return { status: "sent", customers, links: results.filter((r) => r.url).length };
}

async function planReminders(merchantId: string) {
  "use step";
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const reminders = await import("@/lib/reminders");
  return reminders.planReminders(createAdminClient(), merchantId);
}

async function askOwner(chatId: string, summary: string, approvalId: string) {
  "use step";
  const { telegramSender } = await import("@/lib/channels/telegram");
  await telegramSender.sendApproval(chatId, summary, approvalId, { yes: "✅ Haan, links banao", no: "❌ Aaj nahi" });
}

async function makeLink(merchantId: string, shopName: string, reminder: Reminder) {
  "use step";
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { makeReminderLink } = await import("@/lib/reminders");
  return makeReminderLink(createAdminClient(), merchantId, shopName, reminder);
}

async function report(chatId: string, shopName: string, results: LinkResult[]) {
  "use step";
  const { telegramSender } = await import("@/lib/channels/telegram");
  const { remindersReport } = await import("@/lib/reminders");
  const { text, buttons } = remindersReport(shopName, results);
  await telegramSender.sendText(chatId, text, buttons);
}

async function tell(chatId: string, text: string) {
  "use step";
  const { telegramSender } = await import("@/lib/channels/telegram");
  await telegramSender.sendText(chatId, text);
}
