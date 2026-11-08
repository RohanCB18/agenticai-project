import { defineHook } from "workflow";
import { z } from "zod";

// Shared by the reminders workflow and the code that resumes it when the owner taps a button.
// It has no app imports on purpose: it is bundled into the workflow sandbox, which has no Node.

/** The owner's answer to a reminder list. */
export const reminderDecision = defineHook({ schema: z.object({ approved: z.boolean() }) });

/** Telegram approval ids for reminder lists are "rem-<key>". */
export const REMINDER_APPROVAL_PREFIX = "rem-";

/** Lists the owner asks for with /reminders share this key, so only one waits for an answer at a time. */
export const ON_DEMAND_KEY = "now";

/** The token a run waits on. Built from the shop linked to the chat, never from what a button says. */
export const reminderToken = (merchantId: string, key: string) => `reminders:${merchantId}:${key}`;
