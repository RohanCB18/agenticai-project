import "server-only";
import { start } from "workflow/api";
import { HookConflictError, HookNotFoundError } from "workflow/errors";
import { ON_DEMAND_KEY, reminderDecision, reminderToken } from "@/workflows/reminder-hook";
import { type ReminderRunInput, udhaarReminders } from "@/workflows/udhaar-reminders";

/**
 * Starts a reminders run, at most one per shop and key. The hook token is claimed when the run
 * is admitted, so a repeated cron call or a double /reminders can't send a second list: it
 * gets the run that already owns the token instead.
 */
export async function startReminders(input: ReminderRunInput) {
  try {
    const run = await start(udhaarReminders, [input], {
      experimental_hook: {
        token: reminderToken(input.merchantId, input.key),
        // The evening list keeps its date for two days, even after it ends. An on-demand list
        // frees its key when it ends, so the owner can ask again.
        ...(input.key === ON_DEMAND_KEY ? {} : { experimental_minRetention: "2 days" }),
      },
    });
    return { started: true, runId: run.runId } as const;
  } catch (error) {
    if (HookConflictError.is(error)) return { started: false, runId: error.conflictingRunId } as const;
    throw error;
  }
}

/** Passes the owner's tap to the run waiting on it. False when that list was answered or expired. */
export async function answerReminders(merchantId: string, key: string, approved: boolean) {
  try {
    await reminderDecision.resume(reminderToken(merchantId, key), { approved });
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}
