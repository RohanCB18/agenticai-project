"""Sharma Traders' wholesaler agent, served over A2A (Agent2Agent protocol 1.0, JSON-RPC).

Other agents find it from its Agent Card at /.well-known/agent-card.json and send messages to /a2a.
Munshi's stock desk asks it for quotes and, after the shop owner says yes, places orders. Every
reply is one message carrying JSON data (the quote or order) plus a one-line text summary, so the
agent needs no task database and runs on serverless functions.
"""

from __future__ import annotations

import os

from a2a.helpers import get_data_parts, new_data_part, new_message, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandlerV2
from a2a.server.routes import add_a2a_routes_to_fastapi, create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentProvider, AgentSkill
from fastapi import FastAPI
from pydantic_settings import BaseSettings, SettingsConfigDict

from munshi_distributor.graph import GRAPH
from munshi_distributor.pricing import MIN_ORDER_PAISE, SUPPLIER, rupees

RPC_PATH = "/a2a"


def _default_url() -> str:
    # On Vercel, the production domain; locally, uvicorn's address.
    host = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL")
    return f"https://{host}" if host else "http://127.0.0.1:8102"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DISTRIBUTOR_", env_file=".env", extra="ignore")
    public_url: str = ""
    name: str = f"{SUPPLIER} Wholesale Agent"


settings = Settings()
PUBLIC_URL = (settings.public_url or _default_url()).rstrip("/")


def agent_card() -> AgentCard:
    return AgentCard(
        name=settings.name,
        description=(
            f"Kirana wholesaler agent for {SUPPLIER}. Quotes reorders (rice, dal, sugar, oil, atta, "
            "Maggi and more) in whole packs, and confirms orders for delivery the next working morning. "
            f"Minimum order {rupees(MIN_ORDER_PAISE)}. Prices come from the wholesaler's price list "
            "and are not negotiated."
        ),
        version="1.0.0",
        provider=AgentProvider(organization=f"{SUPPLIER} (demo)", url=PUBLIC_URL),
        supported_interfaces=[
            AgentInterface(url=f"{PUBLIC_URL}{RPC_PATH}", protocol_binding="JSONRPC", protocol_version="1.0")
        ],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False),
        default_input_modes=["application/json", "text/plain"],
        default_output_modes=["application/json", "text/plain"],
        skills=[
            AgentSkill(
                id="quote_reorder",
                name="Quote a reorder",
                description=(
                    'Send {"action": "quote", "items": [{"name": "rice", "quantity": 25, "unit": "kg"}], '
                    '"shop": {"name": "..."}} or plain text. Returns priced lines rounded up to whole packs, '
                    "items it can't supply, the total, the delivery slot and a signed quoteId valid for 24 hours."
                ),
                tags=["ordering", "pricing", "fmcg", "kirana"],
                examples=["25 kg rice, 48 maggi, 10 kg toor dal"],
                input_modes=["application/json", "text/plain"],
                output_modes=["application/json"],
            ),
            AgentSkill(
                id="place_order",
                name="Place an order",
                description=(
                    'Send {"action": "order", "quoteId": "..."} to confirm a quote. '
                    "The same quote always gives the same order id."
                ),
                tags=["ordering"],
                input_modes=["application/json"],
                output_modes=["application/json"],
            ),
        ],
    )


class WholesalerExecutor(AgentExecutor):
    """Runs the LangGraph workflow for one incoming message and answers with one message."""

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        parts = context.message.parts if context.message else []
        data = next((d for d in get_data_parts(parts) if isinstance(d, dict)), None)
        state = await GRAPH.ainvoke({"data": data, "text": context.get_user_input()})
        reply = new_message(
            [new_data_part(state["reply"]), new_text_part(state["summary"])], context_id=context.context_id
        )
        await event_queue.enqueue_event(reply)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        return None  # every request finishes in one step, so there is nothing running to cancel


def create_app() -> FastAPI:
    card = agent_card()
    handler = DefaultRequestHandlerV2(
        agent_executor=WholesalerExecutor(), task_store=InMemoryTaskStore(), agent_card=card
    )
    app = FastAPI(title=settings.name)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "munshi-distributor"}

    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=create_agent_card_routes(card),
        jsonrpc_routes=create_jsonrpc_routes(handler, rpc_url=RPC_PATH, enable_v0_3_compat=True),
    )
    return app


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8102)
