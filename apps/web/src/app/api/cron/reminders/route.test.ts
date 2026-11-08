import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startReminders = vi.fn();
vi.mock("@/lib/reminder-runs", () => ({ startReminders: (...args: unknown[]) => startReminders(...args) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: [
            { merchant_id: "shop-1", external_user_id: "111" },
            { merchant_id: "shop-2", external_user_id: "222" },
            { merchant_id: "shop-3", external_user_id: "333" },
          ],
          error: null,
        }),
      }),
    }),
  }),
}));

const { GET } = await import("./route");
const call = (authorization?: string) => GET(new Request("https://munshi.test/api/cron/reminders", { headers: authorization ? { authorization } : {} }));

describe("GET /api/cron/reminders", () => {
  beforeEach(() => vi.stubEnv("CRON_SECRET", "s3cret-value"));
  afterEach(() => {
    vi.unstubAllEnvs();
    startReminders.mockReset();
  });

  it("refuses to run without CRON_SECRET configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(503);
    expect(startReminders).not.toHaveBeenCalled();
  });

  it("refuses callers without the secret", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong-value")).status).toBe(401);
    expect(startReminders).not.toHaveBeenCalled();
  });

  it("starts one run per Telegram-linked shop, keyed by today's date in India", async () => {
    startReminders.mockResolvedValueOnce({ started: true }).mockResolvedValueOnce({ started: false }).mockRejectedValueOnce(new Error("queue down"));
    const response = await call("Bearer s3cret-value");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { key: string; started: number; alreadyRan: number; failed: number };
    expect(body).toMatchObject({ started: 1, alreadyRan: 1, failed: 1 });
    expect(body.key).toMatch(/^\d{8}$/);
    expect(startReminders).toHaveBeenCalledWith({ merchantId: "shop-1", chatId: "111", key: body.key });
  });
});
