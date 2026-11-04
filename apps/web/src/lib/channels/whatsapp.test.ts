import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inboundMessages, phoneDigits, verifyWhatsAppSignature, type WebhookPayload } from "./whatsapp";

const secret = "app_secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("WhatsApp webhook signature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts Meta's signature over the raw body", () => {
    expect(verifyWhatsAppSignature(body, sign(body), secret)).toBe(true);
  });

  it("rejects a tampered body, a missing header and the wrong secret", () => {
    expect(verifyWhatsAppSignature(body.replace("[]", "[{}]"), sign(body), secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, null, secret)).toBe(false);
    expect(verifyWhatsAppSignature(body, sign(body), "other")).toBe(false);
  });
});

describe("inboundMessages", () => {
  const payload: WebhookPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "111" },
              contacts: [{ profile: { name: "Lakshmi" }, wa_id: "919800000099" }],
              messages: [
                { id: "wamid.1", from: "+919800000099", timestamp: "1", type: "audio", audio: { id: "m1", mime_type: "audio/ogg; codecs=opus", voice: true } },
              ],
            },
          },
          // A delivery status update carries no messages.
          { field: "messages", value: { metadata: { phone_number_id: "111" } } },
          // Another business number on the same app is ignored.
          { field: "messages", value: { metadata: { phone_number_id: "222" }, messages: [{ id: "wamid.2", from: "1", timestamp: "1", type: "text" }] } },
        ],
      },
    ],
  };

  it("returns this number's messages with the sender's profile name", () => {
    const messages = inboundMessages(payload, "111");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ message: { id: "wamid.1", type: "audio" }, profileName: "Lakshmi" });
  });

  it("normalises phone numbers to digits", () => {
    expect(phoneDigits("+91 98000-00099")).toBe("919800000099");
  });
});
