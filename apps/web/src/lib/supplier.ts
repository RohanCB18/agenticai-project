import "server-only";
import { type Message, Role, type SendMessageResult } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { type QuoteRequestItem, SupplierError, type SupplierAgent, type SupplierOrder, type SupplierQuote } from "@munshi/agents";

// Munshi's side of A2A: a client for a wholesaler's agent. It finds the agent from its Agent Card
// (/.well-known/agent-card.json), sends one message per request with a JSON data part, and reads
// the JSON data part of the reply. The wholesaler's agent is a separate Python service
// (services/distributor, LangGraph); A2A is the only thing the two share.

const TIMEOUT_MS = 15_000;

type Reply = { type?: string; code?: string; message?: string } & Record<string, unknown>;

/** The data part of an A2A reply: a direct message, or the last agent message of a task. */
export function replyData(result: SendMessageResult): Reply | null {
  const message: Message | undefined =
    "parts" in result && "messageId" in result ? result : [...(result.history ?? [])].reverse().find((m) => m.role === Role.ROLE_AGENT);
  const data = message?.parts.find((part) => part.content?.$case === "data")?.content;
  return data?.$case === "data" && data.value && typeof data.value === "object" ? (data.value as Reply) : null;
}

export function createA2ASupplier(baseUrl: string, opts: { fetchImpl?: typeof fetch } = {}): SupplierAgent {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  let client: ReturnType<typeof factory.createFromUrl> | undefined;
  let name = "the wholesaler";

  async function send(data: Record<string, unknown>): Promise<Reply> {
    client ??= factory.createFromUrl(baseUrl).catch((error: unknown) => {
      client = undefined; // try discovery again next time
      throw error;
    });
    const result = await (await client).sendMessage(
      {
        tenant: "",
        message: {
          messageId: crypto.randomUUID(),
          contextId: "",
          taskId: "",
          role: Role.ROLE_USER,
          parts: [{ content: { $case: "data", value: data }, metadata: undefined, filename: "", mediaType: "application/json" }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: undefined,
        metadata: undefined,
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const reply = replyData(result);
    if (!reply) throw new SupplierError("bad_reply", "The wholesaler's agent sent no data.");
    if (reply.type === "error") throw new SupplierError(reply.code ?? "refused", reply.message ?? "The wholesaler refused.");
    if (typeof reply.supplier === "string") name = reply.supplier;
    return reply;
  }

  return {
    get name() {
      return name;
    },
    async quote(items: QuoteRequestItem[], shopName: string) {
      const reply = await send({ action: "quote", items, shop: { name: shopName } });
      if (reply.type !== "quote") throw new SupplierError("bad_reply", "The wholesaler's agent didn't send a quote.");
      return reply as unknown as SupplierQuote;
    },
    async order(quoteId: string) {
      const reply = await send({ action: "order", quoteId });
      if (reply.type !== "order") throw new SupplierError("bad_reply", "The wholesaler's agent didn't confirm the order.");
      return reply as unknown as SupplierOrder;
    },
  };
}

/** The wholesaler configured for this deployment, if any. */
export function configuredSupplier(): SupplierAgent | undefined {
  const url = process.env.DISTRIBUTOR_URL;
  return url ? createA2ASupplier(url) : undefined;
}
