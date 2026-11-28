import json

import httpx
import pytest

from munshi_distributor import graph
from munshi_distributor.assistant import converse, find_items, without_quote_ids


def scripted_sarvam(*turns):
    """A stand-in for Sarvam's chat API: answers with the given turns in order, and keeps what it was sent."""
    sent = []

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        assert request.headers["api-subscription-key"] == "test-key"
        message = turns[len(sent) - 1]
        return httpx.Response(200, json={"choices": [{"message": message}]})

    return httpx.Client(transport=httpx.MockTransport(handle)), sent


def tool_call(name, args, call_id="c1"):
    return {
        "content": "",
        "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}],
    }


def test_finding_goods_by_local_names_and_kinds():
    assert [i["name"] for i in find_items("akki")["items"]] == ["Sona Masoori Rice"]
    assert {i["name"] for i in find_items("dal")["items"]} == {"Toor Dal", "Moong Dal"}
    ghee = find_items("ghee")["items"][0]
    assert (ghee["inStock"], ghee["pack"]) == (False, "12 litre")
    assert all("Basmati" not in i["name"] for i in find_items("basmati")["items"])  # not stocked: never invented


def test_the_desk_quotes_through_the_price_list_and_answers_in_words():
    client, sent = scripted_sarvam(
        tool_call("make_quote", {"items": [{"name": "Maggi", "quantity": 11}]}),
        {"content": "Maggi 48 packet ₹576. Minimum ₹1,000 hai, ₹424 aur add kijiye, jaise 10 kg besan (₹900)."},
    )
    answer = converse("11 maggi chahiye, aur kuch add karna padega kya?", "RCB general stores", "test-key", client)
    assert answer["message"].startswith("Maggi 48 packet ₹576")
    # The quote is the price list's, signed, whatever the conversation said.
    assert (answer["quote"]["total"], answer["quote"]["meetsMinimum"]) == ("₹576", False)
    assert answer["quote"]["quoteId"]
    # Sarvam got the desk's rules, the tools, and the tool's result.
    assert "Never state a price" in sent[0]["messages"][0]["content"]
    assert [t["function"]["name"] for t in sent[0]["tools"]] == ["find_items", "make_quote", "track_order"]
    tool_result = json.loads(sent[1]["messages"][-1]["content"])
    assert tool_result["lines"][0]["quantity"] == 48


def test_asking_for_a_lower_price_changes_nothing():
    client, _ = scripted_sarvam(
        tool_call("make_quote", {"items": [{"name": "rice", "quantity": 25}]}),
        {"content": "Rate fixed hai: 25 kg ₹1,300. ₹5,000 se upar 2% discount milta hai."},
    )
    answer = converse("rice 25 kg, ₹40 per kg mein do", None, "test-key", client)
    assert answer["quote"]["total"] == "₹1,300"


def test_the_desk_cant_place_orders():
    client, sent = scripted_sarvam({"content": "Order ke liye quote id ke saath confirm bhejiye."})
    converse("order kar do", None, "test-key", client)
    assert "place_order" not in [t["function"]["name"] for t in sent[0]["tools"]]


def test_words_go_to_the_desk_and_structured_requests_dont(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    assert graph.understand({"data": {"action": "chat", "message": "ghee hai?"}, "text": ""})["action"] == "talk"
    assert graph.understand({"data": None, "text": "basmati hai kya?"})["action"] == "talk"
    quote_request = {"action": "quote", "items": [{"name": "rice", "quantity": 25}], "shop": {"name": "S"}}
    assert graph.understand({"data": quote_request, "text": ""})["action"] == "quote"
    assert (
        graph.understand({"data": {"action": "delivery", "orderId": "ST-1", "quoteId": "q"}, "text": ""})["action"]
        == "delivery"
    )


def test_without_a_sarvam_key_a_list_of_goods_is_still_quoted(monkeypatch):
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    state = graph.understand({"data": None, "text": "25 kg rice, 48 maggi"})
    assert state["action"] == "quote"
    assert graph.understand({"data": None, "text": "basmati hai kya?"})["action"] == "help"


def test_when_sarvam_fails_a_list_of_goods_is_still_quoted(monkeypatch):
    def broken(*args, **kwargs):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(graph, "converse", broken)
    out = graph.talk({"text": "25 kg rice", "shop": None})
    assert out["reply"]["type"] == "quote"
    out = graph.talk({"text": "kya haal hai", "shop": None})
    assert out["reply"]["type"] == "reply"


@pytest.mark.skipif("not __import__('os').environ.get('SARVAM_LIVE')")
def test_live_sarvam_desk():
    """SARVAM_LIVE=1 with SARVAM_API_KEY: the real model, the real tools."""
    import os

    answer = converse(
        "11 Maggi chahiye. Minimum se kam hai to kya add karun? Ghee bhi hai kya?",
        "Live test shop",
        os.environ["SARVAM_API_KEY"],
    )
    print(answer["message"])
    assert answer["message"]


def test_quote_ids_never_go_in_the_words():
    jwt_like = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzaGFybWEtdHJhZGVycyJ9.m8H3XgHI_qayRZggd8t0"
    text = f"Total ₹1,876.\nQuote ID: {jwt_like}\nOwner ka confirmation bhejiye."
    assert without_quote_ids(text) == "Total ₹1,876.\nOwner ka confirmation bhejiye."
    # Live, sarvam-105b retyped one with a space in the middle.
    assert (
        without_quote_ids("Total ₹1,876.\nQuote ID: eyJhbGciOi.eyJpc3MiOiJzaG ZGVs.bGl2ZXJ5\nDelivery Mon.")
        == "Total ₹1,876.\nDelivery Mon."
    )
    assert without_quote_ids(f"Confirm karne ke liye owner se poochiye, quote {jwt_like}") == (
        "Confirm karne ke liye owner se poochiye, quote (sent with this reply)"
    )
