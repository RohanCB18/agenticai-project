"""Sharma Traders' order desk, with Sarvam doing the talking.

A shop's agent (Munshi, or any other A2A agent) can write to the wholesaler in plain words, in
Hindi, Kannada, English or a mix: "basmati hai kya?", "ghee kab aayega?", "minimum se kam hai,
kya add karun?". Sarvam (sarvam-105b, Sarvam's OpenAI-compatible chat API) reads it, uses the
desk's tools, and answers like a wholesaler's counter clerk would.

What it can't do is invent a number. Prices, packs, discounts, stock, the minimum order and
delivery dates come only from the tools, which are the same plain code as the structured quote and
order skills (pricing.py, catalog.py), and every quote it makes is signed by that code. It can't
place an order either: an order is a separate, structured request with the signed quote id, which
Munshi sends only after the shop owner says yes. So a cleverly worded message can talk to the desk,
not talk it into a different price.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from typing import Any

import httpx

from munshi_distributor.catalog import CATALOG, find_item
from munshi_distributor.pricing import (
    MIN_ORDER_PAISE,
    SUPPLIER,
    OrderError,
    delivery_slot,
    delivery_status,
    quote,
    rupees,
)

SARVAM_URL = "https://api.sarvam.ai/v2/chat/completions"
SARVAM_MODEL = "sarvam-105b"
MAX_STEPS = 5  # model turns per message: enough to look up, quote and answer
TIMEOUT_S = 25.0
# sarvam-105b thinks before it answers, and the thinking counts against max_tokens: live, with
# 1,500 it spent 1,436 thinking and the reply stopped mid-word ("Amul G"), or came back empty.
MAX_TOKENS = 4096
# How much it thinks first: "none" answers in a few seconds, inside the time a shop's agent waits;
# with "low" a question took six turns and thousands of tokens of thinking.
EFFORT = os.environ.get("DISTRIBUTOR_SARVAM_EFFORT", "none")

SYSTEM = f"""You are the order desk of {SUPPLIER}, a wholesaler supplying kirana shops and small \
supermarkets. Another business's agent is writing to you on behalf of a shop.

How you work:
- Use the tools for every fact: what you stock (find_items), prices and what an order would cost \
(make_quote: always use it for a total, so the shop gets a signed quote), and where an order is \
(track_order). Never state a price, pack size, discount, stock \
level, minimum order or delivery date that a tool didn't give you in this conversation.
- Goods go out in whole packs (a 25 kg bag, a box of 48). Minimum order {rupees(MIN_ORDER_PAISE)}. \
Discounts: 2% from ₹5,000, 4% from ₹15,000. Prices are fixed by the price list and not negotiated: \
if asked for a lower price, say so politely and point to the volume discount instead.
- When something is out of stock or not in the catalogue, say so. Suggest another item only if it \
is the same kind of goods (another dal for a dal, another rice for a rice); otherwise just say when \
to ask again.
- When an order is under the minimum, say by how much, and suggest one or two everyday items a shop \
reorders anyway (rice, atta, dal, sugar) that would cover it, and quote the order with them \
(make_quote) so the packs and prices you give are the price list's.
- You cannot place orders. To order, the shop's agent sends the quote from make_quote with the \
owner's confirmation. If asked to order, make the quote and say that. Never write out a quote id: \
it goes with your reply as data.
- Reply in the language and script the message was written in (Hindi, Hinglish, Kannada, English). \
Be brief and businesslike, like a counter clerk: a few short lines, amounts in ₹. Think briefly."""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "find_items",
            "description": "Search the catalogue by name, local name or kind of goods. Returns matching items "
            "with pack size, price per unit and whether they're in stock. Empty query lists everything.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "e.g. 'rice', 'akki', 'dal', 'ghee'"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "make_quote",
            "description": "Price a list of goods: whole packs, stock, discount, total, whether it meets the "
            "minimum order, delivery slot, and a signed quoteId the shop can order with.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "quantity": {"type": "number"},
                                "unit": {"type": "string"},
                            },
                            "required": ["name", "quantity"],
                        },
                    }
                },
                "required": ["items"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "track_order",
            "description": "Where an order is: on its way (and when it's due) or delivered (with the invoice). "
            "Needs the orderId and the quoteId it was placed with.",
            "parameters": {
                "type": "object",
                "properties": {"orderId": {"type": "string"}, "quoteId": {"type": "string"}},
                "required": ["orderId", "quoteId"],
            },
        },
    },
]


def sarvam_key() -> str | None:
    return os.environ.get("SARVAM_API_KEY") or None


def _item_view(item) -> dict[str, Any]:
    return {
        "name": item.name,
        "pack": item.pack_label,
        "pricePerUnit": rupees(item.price_paise),
        "packPrice": rupees(item.price_paise * item.pack),
        "inStock": item.stock >= item.pack,
        "alsoCalled": list(item.aliases[:4]),
    }


def find_items(query: str) -> dict[str, Any]:
    q = query.strip().lower()
    if not q:
        return {"items": [_item_view(i) for i in CATALOG]}
    sure = find_item(q)
    words = [re.escape(w) for w in q.split() if len(w) > 2]
    # Whole words: "akki" is rice, not the poha whose local name is "avalakki".
    matches = [
        i
        for i in CATALOG
        if i is sure or any(re.search(rf"\b{w}\b", " | ".join([i.name, *i.aliases]).lower()) for w in words)
    ]
    return {"items": [_item_view(i) for i in matches]} if matches else {"items": [], "note": "nothing like that"}


# A signed quote id is a JWT, which always starts "eyJ". The model sometimes retypes one, with a
# space in it, so anything from "eyJ" on counts.
QUOTE_ID = re.compile(r"eyJ[\w.\-]{8,}")


def without_quote_ids(text: str) -> str:
    """The model was told not to write out quote ids and did anyway: they go as data, so drop them."""
    kept = []
    for line in text.splitlines():
        found = QUOTE_ID.search(line)
        if not found:
            kept.append(line)
        elif len(line[: found.start()].strip(" :-*`")) > 25:  # a sentence around it: keep the words
            kept.append(line[: found.start()].rstrip() + " (sent with this reply)")
        # else a "Quote ID: ..." line: dropped
    return "\n".join(kept).strip()


class Desk:
    """One conversation's tool calls, and the quote it made, if any, to hand back as data."""

    def __init__(self, shop: str | None):
        self.shop = shop
        self.quote: dict[str, Any] | None = None

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "find_items":
                return find_items(str(args.get("query") or ""))
            if name == "make_quote":
                self.quote = quote(list(args.get("items") or []), self.shop)
                return self.quote
            if name == "track_order":
                return delivery_status(str(args.get("quoteId") or ""), str(args.get("orderId") or ""))
        except OrderError as error:
            return {"error": error.code, "message": str(error)}
        return {"error": "unknown_tool"}


def _sarvam(messages: list[dict[str, Any]], key: str, client: httpx.Client, effort: str = EFFORT) -> dict[str, Any]:
    """One model turn: its message, with finish_reason added."""
    response = client.post(
        SARVAM_URL,
        headers={"api-subscription-key": key, "content-type": "application/json"},
        json={
            "model": SARVAM_MODEL,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto",
            "temperature": 0.2,
            "reasoning_effort": effort,
            "max_tokens": MAX_TOKENS,
        },
        timeout=TIMEOUT_S,
    )
    response.raise_for_status()
    choice = response.json()["choices"][0]
    return {**choice["message"], "finish_reason": choice.get("finish_reason")}


def converse(text: str, shop: str | None, key: str, client: httpx.Client | None = None) -> dict[str, Any]:
    """Answers one message from a shop's agent. The reply's text, and the quote it made as data, if it made one."""
    desk = Desk(shop)
    today = f"A new order today is delivered: {delivery_slot(datetime.now(UTC))}."
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": f"{SYSTEM}\n{today}"},
        {"role": "user", "content": (f"(From the agent of {shop}.) " if shop else "") + text},
    ]
    own = client is None
    client = client or httpx.Client()
    try:
        for _ in range(MAX_STEPS):
            message = _sarvam(messages, key, client)
            calls = message.get("tool_calls") or []
            if not calls and (message.get("finish_reason") == "length" or not (message.get("content") or "").strip()):
                # Thought too long and was cut off: the same turn again, answering without thinking.
                message = _sarvam(messages, key, client, effort="none")
                calls = message.get("tool_calls") or []
            if not calls:
                answer = without_quote_ids(message.get("content") or "")
                return {"message": answer or "Sorry, please ask again.", "quote": desk.quote}
            messages.append(
                {"role": "assistant", "content": (message.get("content") or "").strip(), "tool_calls": calls}
            )
            for call in calls:
                try:
                    args = json.loads(call["function"].get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                result = desk.run(call["function"]["name"], args if isinstance(args, dict) else {})
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)})
        return {"message": "Sorry, that took too long to work out. Please ask more simply.", "quote": desk.quote}
    finally:
        if own:
            client.close()
