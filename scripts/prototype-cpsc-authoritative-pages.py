#!/usr/bin/env python3
"""Offline, read-only CPSC page evidence prototype for the Phase 16.8 cohort.

Consumes the accepted audit's public CPSC HTML downloads. No database writes,
matching calls, AI calls, or network requests occur in this program.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import unicodedata
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/phase-16-8-source-manifest.json"
PAGES = Path("/private/tmp/phase168-pages-manifest.json")
OUTPUT = ROOT / "docs/phase-16-9-prototype-dataset.json"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def digest(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def norm(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


def canonical_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "https" or parts.hostname not in {"cpsc.gov", "www.cpsc.gov"}:
        raise ValueError(f"Nonofficial CPSC URL: {value}")
    if not parts.path.startswith("/Recalls/"):
        raise ValueError(f"Nonrecall CPSC URL: {value}")
    return urlunsplit(("https", "www.cpsc.gov", parts.path.rstrip("/"), "", ""))


class Node:
    def __init__(self, tag: str, attrs: dict[str, str] | None = None):
        self.tag, self.attrs, self.children = tag, attrs or {}, []

    def text(self) -> str:
        return norm(" ".join(c.text() if isinstance(c, Node) else c for c in self.children))

    def descendants(self, tag: str | None = None):
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.descendants(tag)

    def has_class(self, name: str) -> bool:
        return name in self.attrs.get("class", "").split()


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def fields(root: Node) -> dict[str, Node]:
    result = {}
    for row in root.descendants("div"):
        if not row.has_class("view-rows"):
            continue
        labels = [n for n in row.descendants("div") if n.has_class("recall-product__field-title")]
        if labels:
            key = norm(labels[0].text()).rstrip(":").lower()
            if key in {"description", "recall number", "recall date"}:
                result[key] = row
    return result


def recall_detail_sections(root: Node) -> dict[str, str]:
    sections = {}
    details = next(node for node in root.descendants("div") if node.has_class("recall-product__details"))
    for wrapper in details.descendants("div"):
        if not wrapper.has_class("recall-product__details-fields"):
            continue
        labels = [node for node in wrapper.descendants("div") if node.has_class("recall-product__field-title")]
        if not labels:
            continue
        label = norm(labels[0].text()).rstrip(":").lower()
        text = wrapper.text()
        sections[label] = norm(text[len(labels[0].text()):])
    return sections


def table_rows(table: Node) -> list[list[str]]:
    # Preserve cells and explicit rowspan instead of inferring blank values.
    rows, pending = [], {}
    for tr in table.descendants("tr"):
        cells, column = [], 0
        for cell in [x for x in tr.children if isinstance(x, Node) and x.tag in {"td", "th"}]:
            while column in pending:
                cells.append(pending[column][0])
                pending[column][1] -= 1
                if pending[column][1] == 0:
                    del pending[column]
                column += 1
            value = cell.text()
            colspan = int(cell.attrs.get("colspan", "1"))
            rowspan = int(cell.attrs.get("rowspan", "1"))
            for _ in range(colspan):
                cells.append(value)
                if rowspan > 1:
                    pending[column] = [value, rowspan - 1]
                column += 1
        while column in pending:
            cells.append(pending[column][0])
            pending[column][1] -= 1
            if pending[column][1] == 0:
                del pending[column]
            column += 1
        if cells:
            rows.append(cells)
    return rows


def candidate(number, url, revision, section, kind, value, excerpt, *, table=None, row=None, group=None):
    fingerprint = digest(norm(excerpt))
    address = {
        "source": "cpsc", "recallNumber": number, "canonicalUrl": url,
        "sourceRevisionHash": revision, "section": section,
        "tableHeaderHash": digest("|".join(table[0])) if table else None,
        "rowIdentity": row, "evidenceFingerprint": fingerprint,
    }
    return {"status": "unreviewed", "kind": kind, "value": value,
            "operator": "in" if isinstance(value, list) else "range" if isinstance(value, dict) else "exact",
            "interpretation": "mandatory_candidate", "group": group,
            "evidence": {"address": address, "rawExcerpt": excerpt}}


def extract(number, url, revision, description, tables):
    candidates, unresolved = [], []
    if number == "26756":  # AGA: each official table row has a required date range.
        for table in tables:
            if len(table) != 7 or [norm(x).lower() for x in table[0]] != ["model", "production date range"]:
                continue
            for row in table[1:]:
                if len(row) != 2 or not re.fullmatch(r"[A-Z0-9]+", row[0]) or norm(row[1]) != "3/19/25 to 7/24/26":
                    continue
                group = f"aga:{row[0]}"
                candidates.append(candidate(number, url, revision, "recall-details/description", "model_exact", row[0], " | ".join(row), table=table, row=row[0], group=group))
                candidates.append(candidate(number, url, revision, "recall-details/description", "production_date_range", {"from": "2025-03-19", "to": "2026-07-24", "inclusive": True}, " | ".join(row), table=table, row=row[0], group=group))
        if len(candidates) != 12:
            unresolved.append("AGA table shape or values changed; no complete row approval possible")
            candidates.clear()
    elif number == "26773":  # Char-Broil: table models AND date-code set in prose.
        code_phrase = re.search(r"Only Bistro Pro Electric Grills with date codes of (2510.*?) are included in this recall\.", description)
        codes = re.findall(r"\b25(?:10|11|12)\b", code_phrase.group(1)) if code_phrase else []
        matching = [t for t in tables if len(t) == 10 and [x.lower().rstrip(".") for x in t[0]] == ["model description", "model no"]]
        if len(set(codes)) == 3 and len(matching) == 1:
            table = matching[0]
            for row in table[1:]:
                if len(row) != 2 or not re.fullmatch(r"253021\d{2}", row[1]):
                    continue
                group = f"char-broil:{row[1]}"
                candidates.append(candidate(number, url, revision, "recall-details/description", "model_exact", row[1], " | ".join(row), table=table, row=row[1], group=group))
                candidates.append(candidate(number, url, revision, "recall-details/description", "date_code_set", sorted(set(codes)), code_phrase.group(0), group=group))
        if len(candidates) != 18:
            unresolved.append("Char-Broil table/date association changed or incomplete")
            candidates.clear()
    elif number == "26776":
        unresolved.append("Friedrich says only some serial numbers; affected values absent")
    elif number in {"26763", "26783"}:
        unresolved.append("Masked VIN/serial ranges have unsupported semantics")
    elif number == "26784":
        unresolved.append("Listed models require unknown serial subset")
    elif number == "26780":
        unresolved.append("Wheel and package date-code alternatives cross fields")
    elif number == "26774":
        unresolved.append("Sticker code has no explicit identifier type")
    elif number == "26779":
        unresolved.append("Model requires an ambiguous GFCI/cord feature condition")
    elif number == "26778":
        unresolved.append("Model list introduced as including; exhaustiveness unproven")
    elif number == "20164":
        unresolved.append("Product number, date range, and sticker absence require unsupported conjunction")
    elif number == "26777":
        model = re.search(r"\bHDFS400\b", description)
        if model:
            candidates.append(candidate(number, url, revision, "recall-details/description", "model_exact", model.group(), description))
    elif number == "26785":
        model = re.search(r"\bHT-10\b", description)
        if model:
            candidates.append(candidate(number, url, revision, "recall-details/description", "model_exact", model.group(), description))
    elif number == "26754":
        model = re.search(r"model number (XR-8801)\b", description)
        if model:
            candidates.append(candidate(number, url, revision, "recall-details/description", "model_exact", model.group(1), description))
    return candidates, unresolved


def run():
    manifest = json.loads(MANIFEST.read_text())
    stored = {row["external_id"]: row for row in (json.loads(line) for line in Path("/private/tmp/phase168-stored.jsonl").read_text().splitlines())}
    page_records = json.loads(PAGES.read_text())
    by_path = {urlsplit(p["url"]).path.lower(): p for p in page_records}
    identities = {}
    rows = []
    for notice in manifest["noticeRows"]:
        url = canonical_url(notice["officialUrl"])
        number = str(notice["cpscRecallNumber"])
        key = f"cpsc:{number}:{url}"
        page_record = by_path[urlsplit(url).path.lower()]
        raw = Path(page_record["file"]).read_bytes()
        raw_hash = digest(raw)
        assert raw_hash == notice["officialPageHtmlSha256"]
        parser = Tree()
        parser.feed(raw.decode("utf-8", "replace"))
        root = parser.root
        title = next(x.text() for x in root.descendants("h1") if x.has_class("page-title"))
        detail_fields = fields(root)
        recall_display = detail_fields["recall number"].text()
        assert re.search(r"\b" + re.escape(number[:2] + "-" + number[2:]) + r"\b", recall_display)
        page_date = datetime.strptime(detail_fields["recall date"].text().removeprefix("Recall Date: "), "%B %d, %Y").date().isoformat()
        assert page_date == stored[notice["storedExternalId"]]["raw_payload"]["RecallDate"][:10]
        desc_field = detail_fields["description"]
        detail_sections = recall_detail_sections(root)
        descriptions = [n.text() for n in desc_field.descendants("p")]
        tables = [table_rows(t) for t in desc_field.descendants("table")]
        description = norm(" ".join(descriptions))
        evidence = {"recallNumber": number, "canonicalUrl": url, "title": title,
                    "publicationDate": page_date, "description": description, "tables": tables,
                    "recallDetails": detail_sections}
        evidence_hash = digest(json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        section_hashes = {"title": digest(title), "publicationDate": digest(page_date),
                          "descriptionText": digest(description), "recallDetails": {k: digest(v) for k, v in detail_sections.items()},
                          "tables": [digest(json.dumps(t, ensure_ascii=False, separators=(",", ":"))) for t in tables]}
        candidates, unresolved = extract(number, url, evidence_hash, description, tables)
        if key not in identities:
            identities[key] = {"identity": key, "recallNumber": number, "canonicalUrl": url,
                               "title": title, "publicationDate": page_date,
                               "fetchTimestamp": datetime.fromtimestamp(Path(page_record["file"]).stat().st_mtime, timezone.utc).isoformat(),
                               "fetchTimestampProvenance": "Phase 16.8 cached file modification time",
                               "httpStatus": int(page_record["result"].split()[0]), "rawPageHash": raw_hash,
                               "normalizedEvidenceHash": evidence_hash, "sourceRevisionIdentity": f"cpsc:{number}:{evidence_hash}",
                               "sectionHashes": section_hashes, "description": description,
                               "recallDetails": detail_sections, "tables": tables,
                               "candidates": candidates, "unresolved": unresolved, "storedIds": []}
        identities[key]["storedIds"].append(notice["storedExternalId"])
        rows.append({"storedExternalId": notice["storedExternalId"], "currentApiId": str(notice["liveApiRecallId"]),
                     "recallNumber": number, "storedUrl": notice["officialUrl"], "canonicalUrl": url,
                     "storedPayloadHash": notice["storedPayloadSha256"], "currentPayloadHash": notice["liveApiPayloadSha256"],
                     "identity": key})
    unique = list(identities.values())
    result = {"prototypeGeneratedFromAuditAt": max(x["fetchTimestamp"] for x in unique), "input": "Phase 16.8 CPSC-only captured pages",
              "counts": {"storedNotices": len(rows), "pagesFetchedSuccessfullyInAudit": sum(x["httpStatus"] == 200 for x in unique),
                         "stableCanonicalIdentities": len(unique), "duplicateGroups": sum(len(x["storedIds"]) > 1 for x in unique),
                         "sourceRevisions": len(unique), "candidateModelCriteria": sum(c["kind"].startswith("model_") for x in unique for c in x["candidates"]),
                         "candidateDateCodeCriteria": sum(c["kind"].startswith("date_code_") for x in unique for c in x["candidates"]),
                         "candidateConjunctions": len({c["group"] for x in unique for c in x["candidates"] if c["group"]}),
                         "unresolvedIdentities": sum(bool(x["unresolved"]) for x in unique),
                         "tableDerivedCandidates": sum(c["evidence"]["address"]["rowIdentity"] is not None for x in unique for c in x["candidates"])},
              "noticeRows": rows, "pages": unique}
    if not OUTPUT.exists() or json.loads(OUTPUT.read_text()) != result:
        OUTPUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        prettier = ROOT / "node_modules/.bin/prettier"
        if prettier.exists():
            subprocess.run([str(prettier), "--write", str(OUTPUT)], check=True, capture_output=True)
    print(json.dumps(result["counts"], indent=2))


if __name__ == "__main__":
    run()
