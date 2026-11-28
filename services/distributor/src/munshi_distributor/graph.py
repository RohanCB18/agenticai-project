"""The wholesaler agent's workflow, as a LangGraph graph.

    understand --> quote    --> END
               |-> order    --> END
               |-> delivery --> END
               |-> talk     --> END   (Sarvam, with the desk's tools)
               `-> help     --> END

`understand` reads either a structured request (an A2A data part, which is what Munshi sends for
quotes, orders and deliveries) or words from any agent ("basmati hai kya?", "10 kg rice, 48
maggi"). Structured requests go straight to plain code. Words go to the order desk in
assistant.py, where Sarvam answers using the same code as tools; without a Sarvam key, a list of
goods is still quoted. Pricing and orders are plain code in pricing.py either way, so a request
phrased cleverly can't talk the agent into a different price.
"""

from __future__ import annotations

import re
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from munshi_distributor.assistant import converse, sarvam_key
from munshi_distributor.pricing import SUPPLIER, OrderError, delivery_status, place_order, quote

Action = Literal["quote", "order", "delivery", "talk", "help"]


class WholesalerState(TypedDict, total=False):
    data: dict[str, Any] | None
    text: str
    action: Action
    items: list[dict[str, Any]]
    shop: str | None
    quote_id: str | None
    order_id: str | None
    ordered_at: str | None
    reply: dict[str, Any]
    summary: str


UNITS = r"kg|kgs|kilo|kilos|packets?|pkts?|pcs|pieces?|litres?|liters?|box(?:es)?|bags?"
QTY_FIRST = re.compile(rf"(\d+(?:\.\d+)?)\s*(?:{UNITS})?\s+(?:of\s+)?(\D+?)", re.IGNORECASE)  # "10 kg rice"
NAME_FIRST = re.compile(rf"(\D+?)\s+(\d+(?:\.\d+)?)\s*(?:{UNITS})?", re.IGNORECASE)  # "rice 10 kg"
JWT = re.compile(r"[\w-]+\.[\w-]+\.[\w-]+")


def parse_items(text: str) -> list[dict[str, Any]]:
    """Items from plain text, one per comma, 'and' or line."""
    items = []
    for chunk in re.split(r"[,;\n]|\band\b|\baur\b", text, flags=re.IGNORECASE):
        chunk = re.sub(
            r"^(please\s+)?(quote|send|need|want)\s*(for|me)?\s*", "", chunk.strip(), flags=re.IGNORECASE
        ).strip()
        if match := QTY_FIRST.fullmatch(chunk):
            items.append({"name": match.group(2).strip(), "quantity": float(match.group(1))})
        elif match := NAME_FIRST.fullmatch(chunk):
            items.append({"name": match.group(1).strip(), "quantity": float(match.group(2))})
    return items


def understand(state: WholesalerState) -> WholesalerState:
    data = state.get("data") or {}
    text = (state.get("text") or "").strip()
    action = str(data.get("action") or "").lower()
    if action == "delivery":
        return {
            "action": "delivery",
            "quote_id": data.get("quoteId"),
            "order_id": data.get("orderId"),
            "ordered_at": data.get("orderedAt"),
        }
    if action == "order" or (
        not data and re.match(r"(confirm|place|order)\b", text, re.IGNORECASE) and JWT.search(text)
    ):
        found = JWT.search(text)
        return {"action": "order", "quote_id": data.get("quoteId") or (found.group(0) if found else None)}
    shop = data.get("shop")
    shop_name = shop.get("name") if isinstance(shop, dict) else None
    if action == "quote" and data.get("items"):
        return {"action": "quote", "items": list(data["items"]), "shop": shop_name}
    words = str(data.get("message") or "").strip() if action == "chat" else ("" if action else text)
    if words and sarvam_key():
        return {"action": "talk", "text": words, "shop": shop_name}
    items = parse_items(words)
    if items:
        return {"action": "quote", "items": items, "shop": shop_name}
    return {"action": "help"}


def make_quote(state: WholesalerState) -> WholesalerState:
    result = quote(state.get("items") or [], state.get("shop"))
    lines = (
        ", ".join(f"{line['quantity']} {line['unit']} {line['item']}" for line in result["lines"]) or "nothing we stock"
    )
    summary = f"Quote from {result['supplier']}: {lines}. Total {result['total']}, delivery {result['deliverySlot']}."
    if result["unavailable"]:
        summary += (
            " Can't supply: " + ", ".join(f"{u['requested']} ({u['reason']})" for u in result["unavailable"]) + "."
        )
    if result["lines"] and not result["meetsMinimum"]:
        summary += f" Orders start at {result['minimumOrder']}."
    return {"reply": result, "summary": summary}


def make_order(state: WholesalerState) -> WholesalerState:
    quote_id = state.get("quote_id")
    if not quote_id:
        reply = {
            "type": "error",
            "code": "missing_quote",
            "message": "Send the quoteId from a quote to place an order.",
        }
        return {"reply": reply, "summary": reply["message"]}
    try:
        order = place_order(quote_id)
    except OrderError as error:
        reply = {"type": "error", "code": error.code, "message": str(error)}
        return {"reply": reply, "summary": reply["message"]}
    return {
        "reply": order,
        "summary": f"Order {order['orderId']} confirmed: {order['total']}, delivery {order['deliverySlot']}.",
    }


def check_delivery(state: WholesalerState) -> WholesalerState:
    quote_id, order_id = state.get("quote_id"), state.get("order_id")
    if not quote_id or not order_id:
        reply = {
            "type": "error",
            "code": "missing_order",
            "message": "Send the orderId and the quoteId it was placed from.",
        }
        return {"reply": reply, "summary": reply["message"]}
    try:
        status = delivery_status(quote_id, order_id, state.get("ordered_at"))
    except OrderError as error:
        reply = {"type": "error", "code": error.code, "message": str(error)}
        return {"reply": reply, "summary": reply["message"]}
    if status["status"] == "delivered":
        summary = f"Order {order_id} delivered, invoice {status['invoiceNo']}, {status['total']}."
    else:
        summary = f"Order {order_id} is on its way: {status['deliverySlot']}."
    return {"reply": status, "summary": summary}


def talk(state: WholesalerState) -> WholesalerState:
    """The order desk answers in words, with any quote it made as data."""
    text, shop = state.get("text") or "", state.get("shop")
    try:
        answer = converse(text, shop, sarvam_key() or "")
    except Exception as error:  # Sarvam down or slow: a list of goods still gets its quote
        print(f"[wholesaler] desk couldn't answer: {error}")
        items = parse_items(text)
        if items:
            return make_quote({"items": items, "shop": shop})
        reply = {
            "type": "reply",
            "supplier": SUPPLIER,
            "message": "Our order desk can't answer just now. Send the items and quantities for a quote.",
        }
        return {"reply": reply, "summary": reply["message"]}
    reply = {"type": "reply", "supplier": SUPPLIER, "message": answer["message"]}
    if answer.get("quote"):
        reply["quote"] = answer["quote"]
    return {"reply": reply, "summary": answer["message"]}


def explain(state: WholesalerState) -> WholesalerState:
    message = (
        'Send items to quote, e.g. {"action": "quote", "items": [{"name": "rice", "quantity": 25}]} '
        'or "25 kg rice, 48 maggi". To order, send {"action": "order", "quoteId": "..."}.'
    )
    return {"reply": {"type": "help", "message": message}, "summary": message}


def _route(state: WholesalerState) -> Action:
    return state["action"]


def build_graph():
    graph = StateGraph(WholesalerState)
    graph.add_node("understand", understand)
    graph.add_node("quote", make_quote)
    graph.add_node("order", make_order)
    graph.add_node("delivery", check_delivery)
    graph.add_node("talk", talk)
    graph.add_node("help", explain)
    graph.add_edge(START, "understand")
    graph.add_conditional_edges(
        "understand",
        _route,
        {"quote": "quote", "order": "order", "delivery": "delivery", "talk": "talk", "help": "help"},
    )
    for node in ("quote", "order", "delivery", "talk", "help"):
        graph.add_edge(node, END)
    return graph.compile()


GRAPH = build_graph()
