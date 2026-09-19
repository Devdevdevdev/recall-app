# Phase 14 official recall-source audit

Audit date: 18 September 2026. This document preserves the access decision made before adding a new
live authority. The activation update below records the separately approved production result.

## Decision

Health Canada's English Recalls and Safety Alerts open dataset is the first Phase 14 international
adapter. At the time of this audit it remained inactive pending migration review, bounded dry-run
verification, and explicit activation approval. That approval was later granted and verified.

EU Safety Gate remains the preferred future European source, but it is deferred because the public
portal's export feature could not be verified as a documented, stable, unattended API contract.
Recall will not automate a private or reverse-engineered portal endpoint.

## Audited authorities

### EU Safety Gate — deferred

- Authority: European Commission Safety Gate rapid alert system.
- Jurisdictions: EU and EEA national authorities; the portal also describes Northern Ireland
  participation. `EU` and `EEA` remain region codes, never ISO country codes.
- Categories: dangerous non-food products.
- Access: the official search portal supports filtered PDF and Excel/XML exports. The Commission's
  annual report states that alerts are updated daily.
- Update semantics: authorities can modify or withdraw alerts after publication.
- Stable identifiers: public alert numbers such as `A12/00487/26` are visible in official notices.
- Identifier richness: brand, model/type and product descriptions are commonly present; GTIN,
  serial and lot availability is notice-dependent.
- Language: alerts are machine-translated across portal languages. A translation must never become
  authoritative matching evidence.
- Official notice URL: `https://ec.europa.eu/safety-gate-alerts/screen/webReport`.
- Usage/licence: no documented unattended download API, rate contract, or ingestion-specific terms
  were verified during this audit.
- Gate result: deferred. UI export is not a sufficiently stable server integration boundary.

### Health Canada Recalls and Safety Alerts — adapter implemented, active

- Authority: Health Canada, with records contributed by the responsible Canadian organizations.
- Jurisdiction: Canada (`CA`).
- Categories: food, consumer products, health products, medical devices, cannabis and vehicles.
- Access: official English and French JSON APIs and CSV datasets listed in the Government of Canada
  open-data catalogue. The selected English JSON feed is updated daily.
- Endpoint:
  `https://recalls-rappels.canada.ca/sites/default/files/opendata-donneesouvertes/HCRSAMOpenData.json`.
- Update semantics: each row provides `Last updated`; the adapter uses that date for bounded windows
  and a per-source `last_updated_date` watermark. Legacy rows where the source provides no update
  date are outside incremental ingestion; no date is invented. The source record is retained
  unchanged.
- Stable identifier: numeric `NID`.
- Identifier richness: the summary feed explicitly provides title, product, issue, category,
  organization, remedy, class, archive state and official URL. It does not expose reliable GTIN,
  model, serial or lot fields, so the adapter never extracts those values from prose.
- Source language: English (`en`) for the selected feed. The French feed remains separate.
- Official notice URL: supplied per row on `recalls-rappels.canada.ca` and host-validated.
- Retrieval limits: 30-second timeout, 24 MiB response ceiling, 14-day maximum source window, and
  at most 100 records. Multi-source automation subdivides the existing global 100-record cap.
- Licence: Open Government Licence – Canada. Attribution and non-endorsement requirements apply.
- Gate result: passed architecture, fixture, bounded dry-run, and separately approved production
  activation verification.

## Production activation update — 19 September 2026

Health Canada is active alongside CPSC. The approved one-day `2026-09-17` canary fetched and
normalized 9 official records, rejected 0, inserted 9 notices and 9 scopes, and advanced only the
Health Canada watermark to `{"kind":"last_updated_date","value":"2026-09-17"}`. Stable NIDs were
preserved and no GTIN, brand, model, serial, or lot value was inferred from prose. Targeted matching
for those notices produced 0 candidate pairs, 0 matches, and 0 alerts, with 0 deliberate AI calls
and 0 deliberate push calls. CPSC remained active and unchanged.

### ACCC Product Safety Australia — deferred

- Authority: Australian Competition and Consumer Commission.
- Jurisdiction: Australia (`AU`).
- Categories: general consumer products regulated by the ACCC; food, road vehicles, therapeutic
  goods and agricultural/veterinary products are directed to other regulators.
- Access: official recall search and category-filtered RSS feeds.
- Update semantics: publication dates are visible in the official recall listing.
- Stable identifiers: stable official notice URLs appear available, but a documented machine ID
  contract was not verified.
- Identifier richness: product/model details vary by notice.
- Source language: English.
- Rate/usage/licence: no documented bulk API, bounded query contract, or ingestion-specific licence
  was verified.
- Gate result: deferred rather than scraping consumer HTML or depending on undocumented site
  internals. RSS can be reconsidered after identifier and reuse terms are confirmed.

### OECD GlobalRecalls — deferred

- Authority: OECD GlobalRecalls, an aggregator of recalls made public by governmental bodies.
- Jurisdictions: global, with economy-of-recall metadata.
- Categories: consumer products across participating economies.
- Access: public search portal and RSS. OECD documentation describes an API-assisted import path for
  participating jurisdictions, not a verified public read API for bounded ingestion.
- Update semantics and stable identifiers: portal records exist, but a public consumption contract
  and durable external-ID semantics were not verified.
- Identifier richness: varies by contributing authority.
- Source language: multilingual.
- Official notice URL: contributing-authority links are preserved by the portal.
- Rate/usage/licence: public automated reuse terms were not established in this audit.
- Gate result: deferred. It may later become a relationship/linking source, but it must never erase
  or replace the originating authority's notice.

## Provenance and authority rules

- Official authorities alone establish that a recall exists.
- Raw source rows are stored unchanged.
- Normalization maps explicit fields only; it does not mine prose for identifiers.
- Each authority notice remains independent. Cross-source similarity is not deduplication.
- Jurisdiction is relevance context. It cannot reject an exact valid GTIN match by itself.
- No translation, model inference, push delivery, or production source activation was performed
  during the original audit. The later activation used the explicit zero-AI/zero-push canary
  described above.

## Official references

- Expo SDK 57 reference: https://docs.expo.dev/versions/v57.0.0/
- Safety Gate portal: https://ec.europa.eu/safety-gate-alerts/screen/webReport
- Safety Gate 2024 report: https://webgate.ec.europa.eu/safety/consumers/consumers_safety_gate/statisticsAndAnualReports/2024/Safety_Gate_2024_report_EN.pdf
- Health Canada dataset catalogue: https://open.canada.ca/data/en/dataset/d38de914-c94c-429b-8ab1-8776c31643e3
- Open Government Licence – Canada: https://open.canada.ca/en/open-government-licence-canada
- ACCC recall search: https://www.productsafety.gov.au/recalls
- OECD GlobalRecalls portal: https://globalrecalls.oecd.org/
- OECD portal implementation report: https://doi.org/10.1787/d8b0d605-en
