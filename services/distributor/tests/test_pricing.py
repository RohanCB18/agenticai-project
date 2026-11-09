from datetime import UTC, datetime, timedelta

import jwt
import pytest

from munshi_distributor import pricing
from munshi_distributor.catalog import find_item
from munshi_distributor.pricing import OrderError, delivery_slot, place_order, quote, rupees

FRIDAY_NOON_IST = datetime(2026, 11, 13, 6, 30, tzinfo=UTC)


def test_indian_rupee_formatting():
    assert rupees(187_600) == "₹1,876"
    assert rupees(12_345_678) == "₹1,23,456.78"
    assert rupees(5_000) == "₹50"


def test_names_shops_use_map_to_the_catalogue():
    assert find_item("Akki").sku == "RICE-SM"
    assert find_item("cheeni").sku == "SUGAR"
    assert find_item("Toor Dal").sku == "DAL-TOOR"
    assert find_item("caviar") is None


def test_quantities_round_up_to_whole_packs_and_stop_at_stock():
    result = quote([{"name": "atta", "quantity": 12}, {"name": "tea", "quantity": 1_000}], "Shop", FRIDAY_NOON_IST)
    atta, tea = result["lines"]
    assert (atta["packs"], atta["quantity"], atta["note"]) == (2, 20, "rounded up to whole packs of 10 kg")
    assert (tea["quantity"], tea["note"]) == (300, "only 300 packet in stock")


def test_discounts_and_the_minimum_order():
    small = quote([{"name": "salt", "quantity": 1}], None, FRIDAY_NOON_IST)  # 25 kg x ₹22 = ₹550
    assert (small["total"], small["meetsMinimum"], small["discount"]) == ("₹550", False, None)
    big = quote([{"name": "rice", "quantity": 100}], None, FRIDAY_NOON_IST)  # ₹5,200 -> 2% off
    assert (big["subtotal"], big["discount"], big["total"]) == ("₹5,200", "2% (₹104)", "₹5,096")


def test_delivery_skips_sunday_and_the_evening_cutoff():
    assert delivery_slot(FRIDAY_NOON_IST) == "Sat 14 Nov, 10 am to 1 pm"
    saturday_evening = datetime(2026, 11, 14, 13, 0, tzinfo=UTC)  # 6:30 pm IST: packed Monday, delivered Tuesday
    assert delivery_slot(saturday_evening) == "Tue 17 Nov, 10 am to 1 pm"
    sunday_noon = datetime(2026, 11, 15, 6, 30, tzinfo=UTC)  # shut on Sunday: packed Monday
    assert delivery_slot(sunday_noon) == "Tue 17 Nov, 10 am to 1 pm"


def test_orders_need_a_live_signed_quote_above_the_minimum():
    now = datetime.now(UTC)
    ok = quote([{"name": "rice", "quantity": 25}], None, now)
    assert place_order(ok["quoteId"])["total"] == "₹1,300"

    expired = quote([{"name": "rice", "quantity": 25}], None, now - timedelta(days=2))
    with pytest.raises(OrderError) as error:
        place_order(expired["quoteId"])
    assert error.value.code == "quote_expired"

    small = quote([{"name": "salt", "quantity": 1}], None, now)
    with pytest.raises(OrderError) as error:
        place_order(small["quoteId"])
    assert error.value.code == "below_minimum"

    claims = jwt.decode(ok["quoteId"], options={"verify_signature": False})
    claims["totalPaise"] = 100  # a cheaper total, signed with someone else's key
    with pytest.raises(OrderError) as error:
        place_order(jwt.encode(claims, "not-the-key", algorithm="HS256"))
    assert error.value.code == "invalid_quote"


def test_production_refuses_to_sign_with_a_throwaway_key(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.delenv("DISTRIBUTOR_QUOTE_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        pricing.quote([{"name": "rice", "quantity": 25}], None)
