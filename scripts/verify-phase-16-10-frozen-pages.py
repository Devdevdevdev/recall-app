#!/usr/bin/env python3
"""Reparse frozen authoritative HTML; no network, database, or AI calls."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "phase169parser", ROOT / "scripts/prototype-cpsc-authoritative-pages.py"
)
assert SPEC and SPEC.loader
PARSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARSER)
DATASET = json.loads((ROOT / "docs/phase-16-9-prototype-dataset.json").read_text())
BY_NUMBER = {page["recallNumber"]: page for page in DATASET["pages"]}


def extract(html):
    tree = PARSER.Tree()
    tree.feed(html)
    root = tree.root
    description = PARSER.fields(root)["description"]
    return {
        "description": PARSER.norm(" ".join(node.text() for node in description.descendants("p"))),
        "tables": [PARSER.table_rows(table) for table in description.descendants("table")],
    }


def verify(number, filename):
    raw = (ROOT / "tests/fixtures/cpsc-pages" / filename).read_bytes()
    page = BY_NUMBER[number]
    assert PARSER.digest(raw) == page["rawPageHash"]
    actual = extract(raw.decode("utf-8"))
    assert actual["description"] == page["description"]
    assert actual["tables"] == page["tables"]
    return raw.decode("utf-8"), actual


aga_html, aga = verify("26756", "aga.html")
char_html, char = verify("26773", "char-broil.html")
friedrich_html, friedrich = verify("26776", "friedrich.html")
assert len(aga["tables"][0]) == 7
assert len({tuple(row) for row in aga["tables"][0][1:]}) == 6
assert len(char["tables"][0]) == 10
assert len({tuple(row) for row in char["tables"][0][1:]}) == 9
assert not friedrich["tables"]

# Cosmetic DOM changes do not alter extracted safety evidence.
cosmetic = char_html.replace("<td", '<td data-tracking="ignored"', 1)
assert cosmetic != char_html
assert extract(cosmetic) == char

# A row-value edit changes the preserved row, without changing other rows.
model = char["tables"][0][1][1]
assert model in char_html
semantic = char_html.replace(model, "25302199", 1)
assert extract(semantic)["tables"] != char["tables"]

print("frozen CPSC HTML: 3 hashes verified; AGA 6 pairs; Char-Broil 9 pairs; cosmetic stable; row edit detected")
