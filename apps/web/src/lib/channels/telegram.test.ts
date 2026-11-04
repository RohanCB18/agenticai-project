import { describe, expect, it } from "vitest";
import { telegramInbound, telegramWebhookSecret, verifyTelegramSecret } from "./telegram";
import { decisionPayload, parseDecisionPayload } from "./types";

const chat = { id: 700000001, type: "private" };
const from = { id: 700000001, first_name: "Lakshmi", last_name: "R" };

describe("Telegram webhook secret", () => {
  it("is a valid secret_token and only the bot's own value passes", () => {
    const secret = telegramWebhookSecret("123:abc");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    expect(verifyTelegramSecret(secret, "123:abc")).toBe(true);
    expect(verifyTelegramSecret(secret, "123:other")).toBe(false);
    expect(verifyTelegramSecret(null, "123:abc")).toBe(false);
  });
});

describe("telegramInbound", () => {
  it("reads a deep-link /start as a link code", () => {
    const inbound = telegramInbound({ update_id: 1, message: { message_id: 1, chat, from, text: "/start Abc_123-xyzABC456defGHI" } });
    expect(inbound).toMatchObject({ kind: "link", code: "Abc_123-xyzABC456defGHI", chatId: "700000001", profileName: "Lakshmi R", updateId: "1" });
  });

  it("treats a bare /start and normal text as text", () => {
    expect(telegramInbound({ update_id: 2, message: { message_id: 2, chat, from, text: "/start" } })).toMatchObject({ kind: "text", text: "/start" });
    expect(telegramInbound({ update_id: 3, message: { message_id: 3, chat, from, text: "Ramesh ne 450 liya" } })).toMatchObject({ kind: "text" });
  });

  it("reads voice notes", () => {
    const inbound = telegramInbound({ update_id: 4, message: { message_id: 4, chat, from, voice: { file_id: "f1", mime_type: "audio/ogg" } } });
    expect(inbound).toMatchObject({ kind: "voice", filename: "voice.ogg" });
  });

  it("reads approval taps", () => {
    const inbound = telegramInbound({
      update_id: 5,
      callback_query: { id: "q1", from, data: decisionPayload("aitxt-ABCDEFGHIJKLMNOPQRSTUVWX", true), message: { message_id: 9, chat, text: "Send?" } },
    });
    expect(inbound).toMatchObject({ kind: "decision", approvalId: "aitxt-ABCDEFGHIJKLMNOPQRSTUVWX", approved: true, chatId: "700000001" });
  });

  it("ignores groups and unknown button data", () => {
    expect(telegramInbound({ update_id: 6, message: { message_id: 6, chat: { id: -1, type: "group" }, from, text: "hi" } })).toBeNull();
    expect(telegramInbound({ update_id: 7, callback_query: { id: "q2", from, data: "rm -rf", message: { message_id: 1, chat } } })).toBeNull();
  });
});

describe("decision payloads", () => {
  it("fit Telegram's 64-byte callback_data limit and round-trip", () => {
    const payload = decisionPayload("aitxt-ABCDEFGHIJKLMNOPQRSTUVWX", false);
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(64);
    expect(parseDecisionPayload(payload)).toEqual({ approvalId: "aitxt-ABCDEFGHIJKLMNOPQRSTUVWX", approved: false });
  });
});
