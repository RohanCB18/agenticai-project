"""What the wholesaler stocks, and how a shop's names for things map onto it.

A demo catalogue for "Sharma Traders", a kirana wholesaler. Prices are wholesale, per unit, in
paise; goods go out in whole packs (a 25 kg bag, a box of 48), so quantities round up.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    unit: str
    pack: int  # units per pack: a quote never splits a pack
    price_paise: int  # per unit
    stock: int  # units in the godown
    aliases: tuple[str, ...] = field(default_factory=tuple)

    @property
    def pack_label(self) -> str:
        return f"{self.pack} {self.unit}" if self.pack > 1 else self.unit


CATALOG: tuple[Item, ...] = (
    Item("RICE-SM", "Sona Masoori Rice", "kg", 25, 5_200, 2_000, ("rice", "chawal", "akki", "arisi", "chaval", "चावल")),
    Item(
        "DAL-TOOR",
        "Toor Dal",
        "kg",
        5,
        13_800,
        400,
        ("toor dal", "arhar", "tuvar", "togari bele", "thuvaram paruppu", "dal"),
    ),
    Item("DAL-MOONG", "Moong Dal", "kg", 5, 11_600, 300, ("moong", "mung", "hesaru bele", "pasi paruppu")),
    Item("SUGAR", "Sugar", "kg", 25, 4_000, 1_500, ("sugar", "cheeni", "chini", "sakkare", "sakkarai", "चीनी")),
    Item("ATTA", "Aashirvaad Atta", "kg", 10, 4_200, 800, ("atta", "wheat flour", "gehun", "godhi hittu")),
    Item("OIL-SUN", "Sunflower Oil", "litre", 15, 13_500, 450, ("oil", "sunflower oil", "tel", "enne", "ennai")),
    Item("SALT", "Tata Salt", "kg", 25, 2_200, 600, ("salt", "namak", "uppu")),
    Item("MAGGI", "Maggi Noodles", "packet", 48, 1_200, 2_400, ("maggi", "noodles")),
    Item("TEA", "Red Label Tea 250g", "packet", 12, 13_000, 300, ("tea", "chai", "chai patti")),
    Item("BISCUIT-PG", "Parle-G Biscuits", "packet", 60, 450, 3_000, ("parle g", "parle-g", "biscuit", "biscuits")),
    Item("SOAP-LB", "Lifebuoy Soap", "piece", 24, 3_000, 960, ("soap", "lifebuoy", "sabun")),
    Item("DETERGENT", "Surf Excel", "kg", 10, 12_000, 200, ("surf", "surf excel", "detergent")),
    Item("BESAN", "Besan", "kg", 10, 9_000, 250, ("besan", "gram flour", "kadle hittu")),
    Item("POHA", "Poha", "kg", 10, 5_600, 300, ("poha", "avalakki", "aval", "chivda")),
    Item("RAVA", "Rava", "kg", 10, 4_400, 300, ("rava", "sooji", "suji", "semolina")),
    Item("GHEE", "Amul Ghee", "litre", 12, 62_000, 0, ("ghee", "tuppa", "nei")),  # out of stock this week
)

SURE = 0.82  # below this a name is a guess, and a wholesaler doesn't ship guesses


def _clean(text: str) -> str:
    return re.sub(r"[^\w\sऀ-෿]", " ", text.lower()).strip()


def _score(query: str, candidate: str) -> float:
    q, c = _clean(query), _clean(candidate)
    if not q or not c:
        return 0.0
    if q == c:
        return 1.0
    # "Rice" matches "Sona Masoori Rice"; "toor" matches "toor dal".
    if re.search(rf"\b{re.escape(q)}\b", c) or re.search(rf"\b{re.escape(c)}\b", q):
        return 0.9
    return SequenceMatcher(None, q, c).ratio()


def find_item(name: str) -> Item | None:
    """The catalogue item a shop's product name means, or None when no match is sure enough."""
    best, best_score = None, 0.0
    for item in CATALOG:
        score = max(_score(name, candidate) for candidate in (item.name, *item.aliases))
        if score > best_score:
            best, best_score = item, score
    return best if best_score >= SURE else None
