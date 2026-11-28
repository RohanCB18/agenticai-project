"""Quotes and orders. Plain code: no model ever decides a price, a discount or a delivery date.

A quote id is a signed JWT holding the exact lines and total. Anyone can read it (Munshi shows it
to the owner before asking to order), only this wholesaler can sign it, and an order is accepted
only for an unexpired quote with a valid signature. So the agent keeps no quote database.
"""

from __future__ import annotations

import hashlib
import math
import os
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta, timezone

import jwt

from munshi_distributor.catalog import find_item

SUPPLIER = "Sharma Traders"
MIN_ORDER_PAISE = 100_000  # ₹1,000
DISCOUNTS = ((1_500_000, 4), (500_000, 2))  # (subtotal at or above, percent off), biggest first
QUOTE_TTL = timedelta(hours=24)
CUTOFF_HOUR = 18  # orders after 6 pm go out a day later
INDIA = timezone(timedelta(hours=5, minutes=30), "IST")  # no daylight saving, so a fixed offset is exact
ISSUER = "sharma-traders"

_DEV_SECRET = secrets.token_urlsafe(32)


def _secret() -> str:
    secret = os.environ.get("DISTRIBUTOR_QUOTE_SECRET")
    if secret:
        return secret
    if os.environ.get("VERCEL"):
        raise RuntimeError(
            "DISTRIBUTOR_QUOTE_SECRET must be set in production, or quotes signed by one instance fail on another."
        )
    return _DEV_SECRET


def rupees(paise: int) -> str:
    """₹ with Indian digit grouping: 123456 paise is ₹1,234.56; whole rupees drop the paise."""
    whole, frac = divmod(abs(paise), 100)
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        digits = ",".join([head, *groups, tail]) if head else ",".join([*groups, tail])
    sign = "-" if paise < 0 else ""
    return f"{sign}₹{digits}" + (f".{frac:02d}" if frac else "")


def _next_working_day(day: date) -> date:
    day += timedelta(days=1)
    while day.weekday() == 6:  # the godown is shut on Sundays
        day += timedelta(days=1)
    return day


def demo_delivery_minutes() -> int:
    """For a demo, DISTRIBUTOR_DELIVERY_MINUTES delivers that many minutes after the quote, not next morning."""
    try:
        return max(0, int(os.environ.get("DISTRIBUTOR_DELIVERY_MINUTES") or 0))
    except ValueError:
        return 0


def _delivery_day(now: datetime) -> date:
    local = now.astimezone(INDIA)
    packed = local.date()
    if local.hour >= CUTOFF_HOUR or packed.weekday() == 6:
        packed = _next_working_day(packed)
    return _next_working_day(packed)


def delivery_slot(now: datetime) -> str:
    """The morning after the order is packed: the same day before 6 pm, else the next working day."""
    minutes = demo_delivery_minutes()
    if minutes:
        return f"today, about {minutes} minutes after you order (demo)"
    return f"{_delivery_day(now).strftime('%a %d %b')}, 10 am to 1 pm"


def delivered_at(ordered: datetime) -> datetime:
    """When the van reaches the shop for an order placed at `ordered`: 11 am on the delivery day, or demo minutes."""
    minutes = demo_delivery_minutes()
    if minutes:
        return ordered + timedelta(minutes=minutes)
    day = _delivery_day(ordered)
    return datetime(day.year, day.month, day.day, 11, tzinfo=INDIA)


def quote(items: list[dict], shop: str | None, now: datetime | None = None) -> dict:
    """Prices the requested items. Unknown or out-of-stock items are listed, never guessed at."""
    now = now or datetime.now(UTC)
    lines, unavailable = [], []
    for requested in items:
        name = str(requested.get("name", "")).strip()
        quantity = float(requested.get("quantity") or 0)
        if not name or quantity <= 0:
            unavailable.append({"requested": name or "?", "reason": "needs a name and a quantity above zero"})
            continue
        item = find_item(name)
        if item is None:
            unavailable.append({"requested": name, "reason": "not in our catalogue"})
            continue
        if item.stock < item.pack:
            unavailable.append({"requested": name, "item": item.name, "reason": "out of stock this week"})
            continue
        packs = math.ceil(quantity / item.pack)
        packs = min(packs, item.stock // item.pack)
        units = packs * item.pack
        line = {
            "requested": name,
            "sku": item.sku,
            "item": item.name,
            "packs": packs,
            "pack": item.pack_label,
            "quantity": units,
            "unit": item.unit,
            "unitPrice": rupees(item.price_paise),
            "amount": rupees(units * item.price_paise),
            "amountPaise": units * item.price_paise,
        }
        if units < quantity:
            line["note"] = f"only {units} {item.unit} in stock"
        elif units > quantity:
            line["note"] = f"rounded up to whole packs of {item.pack_label}"
        lines.append(line)

    subtotal = sum(line["amountPaise"] for line in lines)
    percent = next((p for floor, p in DISCOUNTS if subtotal >= floor), 0)
    discount = subtotal * percent // 100
    total = subtotal - discount
    expires = now + QUOTE_TTL
    slot = delivery_slot(now)
    result = {
        "type": "quote",
        "supplier": SUPPLIER,
        "lines": lines,
        "unavailable": unavailable,
        "subtotal": rupees(subtotal),
        "discount": f"{percent}% ({rupees(discount)})" if percent else None,
        "total": rupees(total),
        "totalPaise": total,
        "minimumOrder": rupees(MIN_ORDER_PAISE),
        "meetsMinimum": total >= MIN_ORDER_PAISE,
        "deliverySlot": slot,
        "payment": "Cash or UPI on delivery",
        "validUntil": expires.isoformat(),
    }
    if lines:
        claims = {
            "iss": ISSUER,
            "jti": uuid.uuid4().hex,
            "iat": int(now.timestamp()),
            "exp": int(expires.timestamp()),
            "shop": shop or "",
            # "requested" is the shop's own name for the item, so the delivery note can say which of
            # the shop's products to add the goods to.
            "lines": [
                {k: line[k] for k in ("requested", "sku", "item", "packs", "pack", "quantity", "unit", "amount")}
                for line in lines
            ],
            "total": rupees(total),
            "totalPaise": total,
            "deliverySlot": slot,
        }
        result["quoteId"] = jwt.encode(claims, _secret(), algorithm="HS256")
    return result


class OrderError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def place_order(quote_id: str, now: datetime | None = None) -> dict:
    """Confirms an order for a quote this wholesaler signed. The same quote always gives the same order."""
    try:
        claims = jwt.decode(
            quote_id, _secret(), algorithms=["HS256"], issuer=ISSUER, options={"require": ["exp", "jti"]}
        )
    except jwt.ExpiredSignatureError as error:
        raise OrderError("quote_expired", "This quote has expired. Ask for a fresh one.") from error
    except jwt.InvalidTokenError as error:
        raise OrderError("invalid_quote", "This quote wasn't issued by Sharma Traders.") from error
    if claims["totalPaise"] < MIN_ORDER_PAISE:
        raise OrderError("below_minimum", f"Orders start at {rupees(MIN_ORDER_PAISE)}; this one is {claims['total']}.")
    order_id = order_id_for(claims)
    return {
        "type": "order",
        "status": "confirmed",
        "supplier": SUPPLIER,
        "orderId": order_id,
        "lines": claims["lines"],
        "total": claims["total"],
        "totalPaise": claims["totalPaise"],
        "deliverySlot": claims["deliverySlot"],
        "payment": "Cash or UPI on delivery",
        "confirmedAt": (now or datetime.now(UTC)).isoformat(),
    }


def order_id_for(claims: dict) -> str:
    return "ST-" + hashlib.sha256(claims["jti"].encode()).hexdigest()[:8].upper()


def delivery_status(quote_id: str, order_id: str, ordered_at: str | None = None, now: datetime | None = None) -> dict:
    """
    Where an order is: on its way, or delivered with the delivery note (the invoice the driver hands
    over, as data). The quote this wholesaler signed is the order's record, so this needs no order
    database: its signature is checked, its expiry isn't (a delivery comes after the quote's 24 hours).
    """
    now = now or datetime.now(UTC)
    try:
        claims = jwt.decode(
            quote_id,
            _secret(),
            algorithms=["HS256"],
            issuer=ISSUER,
            options={"require": ["jti", "iat"], "verify_exp": False},
        )
    except jwt.InvalidTokenError as error:
        raise OrderError("invalid_quote", "This order wasn't placed with Sharma Traders.") from error
    if order_id_for(claims) != order_id:
        raise OrderError("wrong_order", f"Order {order_id} isn't the order for this quote.")
    # When it was ordered: this demo keeps no order book, so the shop says, and it can only be within
    # the quote's 24 hours (orders are refused after that).
    quoted = datetime.fromtimestamp(claims["iat"], UTC)
    ordered = quoted
    if ordered_at:
        try:
            ordered = min(max(datetime.fromisoformat(ordered_at), quoted), quoted + QUOTE_TTL)
        except (ValueError, TypeError):  # not a date, or one without a time zone
            ordered = quoted
    arrives = delivered_at(ordered)
    if now < arrives:
        return {
            "type": "delivery",
            "status": "on_the_way",
            "supplier": SUPPLIER,
            "orderId": order_id,
            "expectedAt": arrives.isoformat(),
            "deliverySlot": claims["deliverySlot"],
        }
    return {
        "type": "delivery",
        "status": "delivered",
        "supplier": SUPPLIER,
        "orderId": order_id,
        "invoiceNo": "INV-" + order_id.removeprefix("ST-"),
        "lines": claims["lines"],
        "total": claims["total"],
        "totalPaise": claims["totalPaise"],
        "deliveredAt": arrives.isoformat(),
    }
