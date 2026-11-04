# Munshi

A voice-first AI bookkeeper for Indian shops. A shop owner speaks in Kannada, Hindi, Tamil or Bengali; Munshi keeps the khata, collects udhaar over UPI, manages stock, pays suppliers and handles GST. Every rupee it moves waits for the owner's "haan".

> Status: **Phase 2 (voice)**. A khata agent on Sarvam-105B (Claude as fallback) records udhaar, payments, sales and stock, and sends Cashfree UPI payment links after the owner approves. Paid links update the khata through a signed webhook. The owner can tap the mic and speak in any Indian language: Saaras v4 transcribes it (biased toward the shop's customer and product names), and Bulbul speaks the reply back in the same language. The same agent works over **Telegram**: link the shop in one tap, then send voice notes or texts and get spoken replies, with Haan / Nahi buttons for payment links. WhatsApp shares the same channel core and switches on with Meta keys.

## How the agent works

```
🎤 speech ──► /api/voice/transcribe (Saaras v4) ─┐
                                                  ▼
owner message ──► /api/chat ──► ToolLoopAgent (AI SDK 7) ──► reply ──► /api/voice/speak (Bulbul) ──► 🔊
                                   │  model: sarvam-105b ──(error)──► claude-opus-5-5
                                   │  tools: findCustomer, addCustomer, recordCredit, recordPayment,
                                   │         recordSale, getBalances, getStock, updateStock, sendPaymentLink
                                   ▼
                    sendPaymentLink needs owner approval (HMAC-signed) ──► Cashfree Payment Link
                                                                              │ customer pays via UPI
                    khata updated ◄── payment_received ◄── /api/webhooks/cashfree (signature verified)
```

## Layout

```
apps/web               Next.js 16 app: auth, khata dashboard, chat with tool and approval cards, Cashfree webhook
packages/agents        Khata agent, tools, Sarvam→Claude fallback model, name matching for spoken names
packages/db            Shared money helpers (paise), zod schemas, generated DB types
supabase/              Migrations, seed data, pgTAP RLS tests
services/mcp           FastMCP server exposing the khata to any MCP host (Phase 5: MCP Apps)
services/distributor   Wholesaler agent with an A2A Agent Card (Phase 5: LangGraph + A2A tasks)
.github/workflows      CI: web, Python and database jobs
```

## Run locally

Prerequisites: Node 22+, Docker Desktop (running), [uv](https://docs.astral.sh/uv/).

```bash
npm install
npm run db:start          # starts local Supabase in Docker, applies migrations + seed
npx supabase status       # copy the API URL and publishable key
cp apps/web/.env.example apps/web/.env.local   # fill in Supabase, Sarvam, Anthropic, Cashfree sandbox keys
npm run dev               # http://localhost:3000
npm run telegram:dev      # optional: Telegram bot, forwards updates to the local app (no public URL needed)
```

Demo login (local seed only): `demo@munshi.test` / `munshi-demo-123`.

```bash
npx supabase test db      # RLS tests: one shop can never see another's books
npx turbo run typecheck lint test
uv sync --all-packages && uv run pytest -q
```

## Design rules

- Money is integer paise everywhere. No floats in the ledger.
- Every table is scoped to a merchant and protected by RLS; the web app queries as the signed-in user.
- Agents can only *request* money movement. Payouts and payment links go through the `approvals` table and need the owner's confirmation. Payouts go only to suppliers the owner verified.
- Ledger history, stock movements and the audit log are append-only.
