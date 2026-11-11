"""Builds knowledge/gst/chunks.jsonl, the GST knowledge Munshi searches, from official notifications.

Run: uv run --with pypdf python knowledge/gst/build_chunks.py

Every entry of the goods rate schedules (9/2025-Central Tax (Rate)) and the exemption list
(10/2025) becomes one chunk, with its HSN codes, the CGST rate printed in the notification and the
total GST a customer pays (CGST + SGST, which equals IGST). The amendments in force (19/2025 and
01/2026) are applied as explicit patches, so a superseded entry is never quoted as current law.
The script fails if serial numbers in a schedule have gaps, rather than silently dropping entries.

Each chunk also gets `search`, the text that is embedded and keyword-indexed: the goods
description alone (the rate, schedule and notification sentence is the same in every entry, so it
only blurs the embeddings), with the legal packing terms said in everyday words and the everyday
names of the goods from common_names.json (see name_goods.mjs). `text` stays what the agent quotes.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

from pypdf import PdfReader

HERE = Path(__file__).parent
CACHE = HERE / ".cache"
SOURCES = {d["id"]: d for d in json.loads((HERE / "sources.json").read_text(encoding="utf-8"))["documents"]}
# Everyday names for each entry's goods, written by name_goods.mjs (search only, never quoted).
NAMES_FILE = HERE / "common_names.json"
_named = json.loads(NAMES_FILE.read_text(encoding="utf-8")) if NAMES_FILE.exists() else {}
NAMES = {
    entry: list(dict.fromkeys(_named.get("names", {}).get(entry, []) + _named.get("hindi", {}).get(entry, [])))
    for entry in set(_named.get("names", {})) | set(_named.get("hindi", {}))
}

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
NOISE = re.compile(
    r"^(<<<PAGE|\d+\s+THE GAZETTE OF INDIA|THE GAZETTE OF INDIA|\[PART II"
    r"|\(1\)\s*\(2\)\s*\(3\)|S\.\s*No\.?\s*(Chapter|$)"
    r"|Chapter/Heading|heading/Tariff|Sub-?\s*heading|Description of [Gg]oods|item\s*$"
    r"|\(Department|MINISTRY OF FINANCE|NOTIFICATION$)"
)
SCHEDULE = re.compile(r"^Schedule\s+([IVX]+)\s*[–-]\s*([\d.]+)\s*%")
ROW = re.compile(r"^(\d{1,3}[A-Z]?)\.(?:\s+(\S.*?))?\s*$")  # the HSN may start on the next line
HSN_TOKEN = re.compile(r"^(\d{2,8},?|or|and|,)$")
# The four entries whose description is just "All goods": what they cover is in the HSN heading,
# so the heading's text from the Customs Tariff (Customs Tariff Act, 1975, First Schedule) is
# added, labelled as such, for search and for the agent to say what the goods are.
HEADINGS = {
    "3605": "Matches, other than pyrotechnic articles of heading 3604",
    "5801": "Woven pile fabrics and chenille fabrics, other than fabrics of heading 5802 or 5806",
    "8517": "Telephone sets, including smartphones and other telephones for cellular networks "
    "or for other wireless networks; "
    "other apparatus for the transmission or reception of voice, images or other data",
    "9619": "Sanitary towels (pads) and tampons, napkins (diapers) and napkin liners for babies "
    "and similar articles, of any material",
}
CGST = {"I": 2.5, "II": 9.0, "III": 20.0, "IV": 1.5, "V": 0.125, "VI": 0.75, "VII": 14.0}

# Amendments in force, transcribed from the notifications (see sources.json).
INSERTS = [
    ("ctr-19-2025", "II", "4A", "2403 19 21, 2403 19 29", "Biris"),
    ("ctr-19-2025", "III", "14", "2106 90 20", "Pan masala"),
    ("ctr-19-2025", "III", "15", "2401", "Unmanufactured tobacco; tobacco refuse [other than tobacco leaves]"),
    (
        "ctr-19-2025",
        "III",
        "16",
        "2402",
        "Cigars, cheroots, cigarillos and cigarettes, of tobacco or of tobacco substitutes",
    ),
    (
        "ctr-19-2025",
        "III",
        "17",
        "2403 (other than 2403 19 21, 2403 19 29)",
        "Other manufactured tobacco and manufactured tobacco substitutes; homogenised or reconstituted tobacco; "
        "tobacco extracts and essences [other than biris]",
    ),
    (
        "ctr-19-2025",
        "III",
        "18",
        "2404 11 00",
        "Products containing tobacco or reconstituted tobacco and intended for inhalation without combustion",
    ),
    (
        "ctr-19-2025",
        "III",
        "19",
        "2404 19 00",
        "Products containing tobacco or nicotine substitutes and intended for inhalation without combustion",
    ),
]
OMITTED_SCHEDULES = {"VII": "ctr-19-2025"}
HSN_SUBSTITUTIONS = {
    ("I", "150"): ("ctr-01-2026", "2202 99 21, 2202 99 29"),
    ("I", "151"): ("ctr-01-2026", "2202 99 31, 2202 99 39"),
    ("III", "2"): ("ctr-01-2026", "2202 91 00, 2202 99 91, 2202 99 99"),
    ("III", "3"): ("ctr-01-2026", "2202 99 91, 2202 99 99"),
}


def pdf_lines(doc_id: str) -> list[str]:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{doc_id}.pdf"
    if not path.exists():
        request = urllib.request.Request(
            SOURCES[doc_id]["url"], headers={"User-Agent": "Mozilla/5.0 (Munshi knowledge builder)"}
        )
        path.write_bytes(urllib.request.urlopen(request, timeout=120).read())
    lines = []
    for page in PdfReader(path).pages:
        lines.extend((page.extract_text() or "").splitlines())
    return [re.sub(r"\s+", " ", line).strip() for line in lines]


def clean(text: str) -> str:
    text = text.replace("‖", '"').replace("―", '"').replace("–", "-").replace("—", "-")
    text = re.sub(r"\s+", " ", text).strip()
    # The PDF text layer puts spaces around hyphens inside words: "pre - packaged", "surface -active".
    return re.sub(r"(?<=[A-Za-z]) ?- ?(?=[a-z])", "-", text)


WORD = re.compile(r"[A-Za-z]+")


def repair_splits(chunks: list[dict]) -> int:
    """Joins words the PDF text layer split in two ("mixtur es", "th e", "Jagger y").

    A pair is joined only when the joined word occurs elsewhere in the same notifications and a part
    is not a word there itself, so "in to" stays apart and nothing is guessed. Returns the joins made.
    """
    vocab = Counter(w.lower() for c in chunks for w in WORD.findall(c["text"]))

    def is_word(w: str) -> bool:
        return w.lower() in ("a", "i") or (len(w) > 1 and vocab[w.lower()] >= 3)

    joins = 0

    def join(m: re.Match) -> str:
        nonlocal joins
        a, b = m.group(1), m.group(2)
        broken = [w for w in (a, b) if not is_word(w)]
        if vocab[(a + b).lower()] >= 2 and (any(len(w) >= 2 for w in broken) or len(broken) == 2):
            joins += 1
            return a + b
        return m.group(0)

    pair = re.compile(r"\b([A-Za-z]+) ([a-z]+)\b")
    for c in chunks:
        for field in ("description", "text"):
            if c.get(field):
                for _ in range(2):  # a word split twice ("pre parat ions") needs a second pass
                    c[field] = pair.sub(join, c[field])
    return joins


def search_text(chunk: dict) -> str:
    """What is embedded and keyword-indexed for a chunk (see the module docstring)."""
    if chunk["kind"] == "list":
        return chunk["text"]
    if chunk["kind"] == "definition":
        # The legal paragraph is long and dilutes the embedding; say what it defines.
        return f"{chunk['description']}: what these terms mean"
    description = chunk["description"]
    # HSN exclusions inside a description ("[other than 0910 11 10, 0910 30 10]") are codes, not words.
    words = re.sub(r"\[other than[\d\s,]+(and[\d\s,]+)?\]", "", description).strip()
    heading = chunk.get("heading")
    if heading:
        words += f". {heading}"
    # "Pre-packaged and labelled" is the legal term; owners say packed or loose.
    lowered = description.lower()
    if re.search(r"other than pre-?\s?packaged", lowered):
        words += " (loose, not packed)"
    elif "pre-packaged" in lowered or "pre-packed" in lowered:
        words += " (packed)"
    names = NAMES.get(chunk["id"])
    if names:
        words += f". Everyday names: {', '.join(names)}"
    return words


def split_hsn(rest: str) -> tuple[str, str]:
    """The leading tariff codes of a row, and the description after them."""
    if rest.startswith("Any Chapter"):
        return "Any Chapter", rest[len("Any Chapter") :].strip()
    tokens, hsn = rest.split(), []
    while tokens and HSN_TOKEN.match(tokens[0]):
        hsn.append(tokens.pop(0))
    return " ".join(hsn).strip(" ,"), " ".join(tokens)


def parse_rows(lines: list[str], start: int, stop: re.Pattern, schedule_of=None):
    """Rows from `start` until a line matching `stop`. Yields (schedule, sno, hsn, description)."""
    rows, current, schedule, seen = [], None, schedule_of, {}
    in_list = None
    for line in lines[start:]:
        if not line or DEVANAGARI.search(line):
            continue
        if stop.match(line):
            break
        header = SCHEDULE.match(line)
        if header:
            schedule, in_list, current = header.group(1), None, None
            continue
        if line.startswith("List 1 [See S. No."):
            in_list, current = {"schedule": schedule, "title": line, "text": []}, None
            rows.append(("LIST", in_list))
            continue
        if NOISE.match(line):
            continue
        if in_list is not None:
            in_list["text"].append(line)
            continue
        row = ROW.match(line)
        if row and schedule is not None:
            sno = row.group(1)
            number = int(re.match(r"\d+", sno).group())
            last = max((int(re.match(r"\d+", s).group()) for s in seen.get(schedule, [])), default=0)
            if sno not in seen.get(schedule, []) and number <= last + 6:
                hsn, description = split_hsn(row.group(2) or "")
                current = {"schedule": schedule, "sno": sno, "hsn": hsn, "description": description}
                seen.setdefault(schedule, []).append(sno)
                rows.append(("ROW", current))
                continue
        if current is not None:
            only_codes = all(HSN_TOKEN.match(t) for t in line.split())
            qualifier = line.startswith("(") and re.search(r"\d{4}", line)  # "(other than 21069020)"
            if (only_codes or qualifier) and not current["description"]:
                current["hsn"] = (current["hsn"] + " " + line).strip(" ,")
            else:
                current["description"] += " " + line
    return rows, seen


def gaps(seen: dict[str, list[str]]) -> dict[str, list[int]]:
    out = {}
    for schedule, snos in seen.items():
        numbers = sorted({int(re.match(r"\d+", s).group()) for s in snos})
        missing = [n for n in range(1, numbers[-1] + 1) if n not in numbers]
        if missing:
            out[schedule] = missing
    return out


def source_ref(doc_id: str) -> dict:
    d = SOURCES[doc_id]
    return {
        "id": doc_id,
        "title": d["title"],
        "gsr": d["gsr"],
        "dated": d["dated"],
        "effectiveFrom": d["effectiveFrom"],
        "url": d["url"],
    }


def heading_for(hsn: str, description: str) -> str | None:
    """The Customs Tariff heading text, for an entry described only as "All goods"."""
    if description.strip().rstrip(".") != "All goods":
        return None
    return HEADINGS.get(re.sub(r"\D", "", hsn)[:4])


def rate_chunk(
    schedule: str, sno: str, hsn: str, description: str, doc_id: str, amended: list[dict] | None = None
) -> dict:
    cgst = CGST[schedule]
    gst = cgst * 2
    fmt = lambda n: f"{n:g}"  # noqa: E731
    base = SOURCES["ctr-09-2025"]
    heading = heading_for(hsn, description)
    text = (
        f"{description}. HSN {hsn}. GST {fmt(gst)}% "
        f"(CGST {fmt(cgst)}% + SGST {fmt(cgst)}%, or IGST {fmt(gst)}% between states). "
        f"Schedule {schedule}, S. No. {sno} of {base['title']}, in force from 22 September 2025."
    )
    if heading:
        text += f" (HSN heading {re.sub(chr(92) + 'D', '', hsn)[:4]} in the Customs Tariff: {heading}.)"
    for a in amended or []:
        text += f" {a['note']}"
    return {
        "id": f"ctr-09-2025:{schedule}:{sno}",
        "kind": "rate",
        "schedule": schedule,
        "sno": sno,
        "hsn": hsn,
        "description": description,
        **({"heading": heading} if heading else {}),
        "cgst": cgst,
        "gst": gst,
        "text": text,
        "sources": [source_ref("ctr-09-2025")] + [source_ref(a["source"]) for a in amended or []]
        if doc_id == "ctr-09-2025"
        else [source_ref(doc_id), source_ref("ctr-09-2025")],
    }


def build() -> list[dict]:
    chunks: list[dict] = []

    # 9/2025: the rate schedules.
    lines = pdf_lines("ctr-09-2025")
    start = next(i for i, line in enumerate(lines) if SCHEDULE.match(line))
    rows, seen = parse_rows(
        lines, start, re.compile(r"^Explanation\.?\s*[-—–]+\s*For the purposes of this notification")
    )
    missing = gaps(seen)
    if missing:
        sys.exit(f"9/2025: serial numbers missing from the parsed schedules: {missing}")
    for kind, row in rows:
        if kind == "LIST":
            text = clean(" ".join(row["text"]))
            # About 1,500 characters a chunk, cut between words.
            parts, rest = [], text
            while rest:
                cut = len(rest) if len(rest) <= 1500 else rest.rfind(" ", 0, 1500)
                parts.append(rest[:cut].strip())
                rest = rest[cut:].strip()
            for n, part in enumerate(parts, start=1):
                chunks.append(
                    {
                        "id": f"ctr-09-2025:list1:{n}",
                        "kind": "list",
                        "schedule": row["schedule"],
                        "description": "List 1 to Schedule I (see S. No. 478): goods at 5% GST",
                        "gst": CGST[row["schedule"]] * 2,
                        "text": "List 1 [See S. No. 478 of Schedule I] of Notification No. 9/2025-Central Tax (Rate), "
                        f"GST 5%: {part}",
                        "sources": [source_ref("ctr-09-2025")],
                    }
                )
            continue
        schedule, sno = row["schedule"], row["sno"]
        if schedule in OMITTED_SCHEDULES:
            continue  # omitted by 19/2025 from 1 February 2026; its goods now sit in Schedules II and III
        amended = []
        hsn = clean(row["hsn"])
        if (schedule, sno) in HSN_SUBSTITUTIONS:
            doc_id, new_hsn = HSN_SUBSTITUTIONS[(schedule, sno)]
            amended.append(
                {
                    "source": doc_id,
                    "note": f"HSN substituted by {SOURCES[doc_id]['title']} "
                    f"from {SOURCES[doc_id]['effectiveFrom']} (earlier: {hsn}).",
                }
            )
            hsn = new_hsn
        chunks.append(rate_chunk(schedule, sno, hsn, clean(row["description"]), "ctr-09-2025", amended))

    for doc_id, schedule, sno, hsn, description in INSERTS:
        chunk = rate_chunk(schedule, sno, hsn, description, doc_id)
        chunk["id"] = f"{doc_id}:{schedule}:{sno}"
        chunk["text"] += f" Inserted by {SOURCES[doc_id]['title']} from {SOURCES[doc_id]['effectiveFrom']}."
        chunks.append(chunk)

    explanation = next(
        i
        for i, line in enumerate(lines)
        if re.match(r"^Explanation\.?\s*[-—–]+\s*For the purposes of this notification", line)
    )
    tail = clean(
        " ".join(line for line in lines[explanation:] if line and not DEVANAGARI.search(line) and not NOISE.match(line))
    )
    tail = tail.split("2. This notification shall come into force")[0]
    chunks.append(
        {
            "id": "ctr-09-2025:explanation",
            "kind": "definition",
            "description": "Definitions used in the GST rate schedules: unit container, pre-packaged and labelled, "
            "tariff item, heading, Chapter",
            "text": f"Notification No. 9/2025-Central Tax (Rate), definitions: {tail}",
            "sources": [source_ref("ctr-09-2025")],
        }
    )

    # 10/2025: goods exempt from GST.
    lines = pdf_lines("ctr-10-2025")
    start = next(i for i, line in enumerate(lines) if line.strip() == "SCHEDULE")
    explanation_10 = re.compile(r"^Explanation\.?\s*[-—–]*\s*For the purposes of this (notification|Schedule)")
    rows, seen = parse_rows(lines, start + 1, re.compile(explanation_10.pattern + r"|^2\.\s+This notification"), "EX")
    missing = gaps(seen)
    if missing:
        sys.exit(f"10/2025: serial numbers missing from the exemption list: {missing}")
    for _, row in rows:
        hsn, description = clean(row["hsn"]), clean(row["description"])
        chunks.append(
            {
                "id": f"ctr-10-2025:{row['sno']}",
                "kind": "exempt",
                "sno": row["sno"],
                "hsn": hsn,
                "description": description,
                "cgst": 0,
                "gst": 0,
                "text": f"{description}. HSN {hsn}. Exempt from GST (nil rate). S. No. {row['sno']} "
                "of Notification No. 10/2025-Central Tax (Rate), in force from 22 September 2025.",
                "sources": [source_ref("ctr-10-2025")],
            }
        )

    at = next(i for i, line in enumerate(lines) if explanation_10.match(line))
    tail = clean(
        " ".join(line for line in lines[at:] if line and not DEVANAGARI.search(line) and not NOISE.match(line))
    )
    tail = re.split(r"\b2\. This notification shall come into force", tail)[0]
    chunks.append(
        {
            "id": "ctr-10-2025:explanation",
            "kind": "definition",
            "description": "Definitions used in the GST exemption list: unit container, pre-packaged and labelled, "
            "tariff item, heading, Chapter, Government entity",
            "text": f"Notification No. 10/2025-Central Tax (Rate), definitions: {tail}",
            "sources": [source_ref("ctr-10-2025")],
        }
    )

    joins = repair_splits(chunks)
    for chunk in chunks:
        chunk["search"] = search_text(chunk)
    print(f"joined {joins} words the PDF text had split")
    return chunks


if __name__ == "__main__":
    out = build()
    (HERE / "chunks.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in out) + "\n", encoding="utf-8"
    )
    by_kind: dict[str, int] = {}
    for c in out:
        by_kind[c["kind"]] = by_kind.get(c["kind"], 0) + 1
    print(f"{len(out)} chunks: {by_kind}")
