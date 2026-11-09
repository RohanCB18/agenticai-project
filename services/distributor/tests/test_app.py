import uuid

import httpx
from a2a.client import ClientConfig, ClientFactory
from a2a.helpers import get_data_parts, get_text_parts, new_data_part, new_message, new_text_part
from a2a.types import AgentCard, Role, SendMessageRequest
from fastapi.testclient import TestClient
from google.protobuf.json_format import ParseDict

from munshi_distributor.app import app

client = TestClient(app)


def test_health():
    assert client.get("/health").json()["status"] == "ok"


def test_agent_card_advertises_both_skills_over_json_rpc():
    card = client.get("/.well-known/agent-card.json").json()
    assert card["name"] == "Sharma Traders Wholesale Agent"
    assert [skill["id"] for skill in card["skills"]] == ["quote_reorder", "place_order"]
    assert card["supportedInterfaces"][0]["protocolBinding"] == "JSONRPC"
    assert card["supportedInterfaces"][0]["url"].endswith("/a2a")


async def _send(*parts) -> tuple[dict, str]:
    """Sends one message with the official A2A client, in process, and returns the reply's data and text."""
    card = ParseDict(client.get("/.well-known/agent-card.json").json(), AgentCard())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8102") as http:
        a2a = ClientFactory(ClientConfig(httpx_client=http, streaming=False)).create(card)
        request = SendMessageRequest(message=new_message(list(parts), role=Role.ROLE_USER, context_id=uuid.uuid4().hex))
        async for response in a2a.send_message(request):
            assert response.HasField("message")
            return get_data_parts(response.message.parts)[0], get_text_parts(response.message.parts)[0]
    raise AssertionError("no reply")


async def test_quote_then_order_over_a2a():
    items = [
        {"name": "Rice", "quantity": 20, "unit": "kg"},
        {"name": "Maggi", "quantity": 30},
        {"name": "Ghee", "quantity": 2},
    ]
    quote, summary = await _send(
        new_data_part({"action": "quote", "items": items, "shop": {"name": "Sri Ganesh Stores"}})
    )
    assert quote["type"] == "quote"
    assert [(line["item"], line["quantity"]) for line in quote["lines"]] == [
        ("Sona Masoori Rice", 25),
        ("Maggi Noodles", 48),
    ]
    assert quote["total"] == "₹1,876"  # 25 kg x ₹52 + 48 x ₹12
    assert quote["unavailable"] == [{"requested": "Ghee", "item": "Amul Ghee", "reason": "out of stock this week"}]
    assert "Total ₹1,876" in summary

    order, summary = await _send(new_data_part({"action": "order", "quoteId": quote["quoteId"]}))
    assert order["status"] == "confirmed"
    assert order["orderId"].startswith("ST-")
    assert order["total"] == "₹1,876"
    again, _ = await _send(new_data_part({"action": "order", "quoteId": quote["quoteId"]}))
    assert again["orderId"] == order["orderId"]  # placing the same quote twice is one order


async def test_plain_text_from_any_agent():
    quote, _ = await _send(new_text_part("Please quote 25 kg rice, 10 kg toor dal and 2 kg caviar"))
    assert [line["sku"] for line in quote["lines"]] == ["RICE-SM", "DAL-TOOR"]
    assert quote["unavailable"] == [{"requested": "caviar", "reason": "not in our catalogue"}]


async def test_a_forged_quote_is_refused():
    quote, _ = await _send(new_data_part({"action": "quote", "items": [{"name": "rice", "quantity": 25}]}))
    header, payload, signature = quote["quoteId"].split(".")
    forged = f"{header}.{payload}.{signature[:-4]}AAAA"
    reply, _ = await _send(new_data_part({"action": "order", "quoteId": forged}))
    assert reply == {"type": "error", "code": "invalid_quote", "message": "This quote wasn't issued by Sharma Traders."}


async def test_unclear_requests_get_instructions():
    reply, _ = await _send(new_text_part("hello"))
    assert reply["type"] == "help"
