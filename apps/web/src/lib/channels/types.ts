// A messaging channel (Telegram, WhatsApp) turns platform updates into these shapes and
// knows how to send replies; the conversation logic itself is shared (conversation.ts).

export type MessagingChannel = "telegram" | "whatsapp";

type InboundBase = {
  channel: MessagingChannel;
  /** Platform update id, used to process each delivery once. */
  updateId: string;
  /** Where to reply. Also the linked account's id (Telegram chat id, WhatsApp phone digits). */
  chatId: string;
  profileName?: string;
};

export type DecisionResult = "approved" | "denied" | "stale";

export type Inbound = InboundBase &
  (
    | { kind: "text"; text: string }
    | { kind: "voice"; download: () => Promise<Blob>; filename: string }
    | { kind: "image"; download: () => Promise<Blob>; filename: string }
    | { kind: "decision"; approvalId: string; approved: boolean; acknowledge?: (result: DecisionResult) => Promise<void> }
    | { kind: "link"; code: string }
    | { kind: "unsupported" }
  );

export type LinkButton = { text: string; url: string };
export type ApprovalLabels = { yes: string; no: string };

export interface ChannelSender {
  sendText(chatId: string, text: string, buttons?: LinkButton[]): Promise<void>;
  /** Sends an MP3 voice reply. */
  sendVoice(chatId: string, mp3: Uint8Array): Promise<void>;
  /** Sends a PNG, used for the in-shop payment QR. */
  sendPhoto(chatId: string, png: Uint8Array, caption: string): Promise<void>;
  /** Sends Haan / Nahi buttons that come back as a "decision" inbound for `approvalId`. */
  sendApproval(chatId: string, prompt: string, approvalId: string, labels?: ApprovalLabels): Promise<void>;
  /** Optional "typing…" / "recording voice…" indicator while Munshi works. */
  showWorking?(chatId: string, kind: "typing" | "voice"): Promise<void>;
}

/** Approval buttons carry "y:<approvalId>" or "n:<approvalId>" (AI SDK ids are 30 chars, well under Telegram's 64-byte limit). */
export function decisionPayload(approvalId: string, approved: boolean) {
  return `${approved ? "y" : "n"}:${approvalId}`;
}

export function parseDecisionPayload(data: string): { approvalId: string; approved: boolean } | null {
  const match = /^([yn]):([A-Za-z0-9-]{1,60})$/.exec(data);
  return match ? { approved: match[1] === "y", approvalId: match[2]! } : null;
}
