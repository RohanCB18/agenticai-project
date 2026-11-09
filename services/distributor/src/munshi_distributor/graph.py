"""The wholesaler agent's workflow, as a LangGraph graph.

    understand --> quote --> END
               |-> order --> END
               `-> help  --> END

`understand` reads either a structured request (an A2A data part, which is what Munshi sends) or
plain text from any other agent ("10 kg rice, 48 maggi"). Pricing and orders are plain code in
pricing.py, so a request phrased cleverly can't talk the agent into a different price.
"""

from __future__ import annotations

import re
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from munshi_distributor.pricing import OrderError, place_order, quote

Action = Literal["quote", "order", "help"]


class WholesalerState(TypedDict, total=False):
    data: dict[str, Any] | None
    text: str
    action: Action
    items: list[dict[str, Any]]
    shop: str | None
    quote_id: str | None
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
    if action == "order" or (
        not data and re.match(r"(confirm|place|order)\b", text, re.IGNORECASE) and JWT.search(text)
    ):
        found = JWT.search(text)
        return {"action": "order", "quote_id": data.get("quoteId") or (found.group(0) if found else None)}
    items = data.get("items") if action == "quote" else parse_items(text)
    if items:
        shop = data.get("shop")
        return {"action": "quote", "items": list(items), "shop": shop.get("name") if isinstance(shop, dict) else None}
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
    graph.add_node("help", explain)
    graph.add_edge(START, "understand")
    graph.add_conditional_edges("understand", _route, {"quote": "quote", "order": "order", "help": "help"})
    for node in ("quote", "order", "help"):
        graph.add_edge(node, END)
    return graph.compile()


GRAPH = build_graph()
