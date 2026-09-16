# Global coverage model

Recall is architected for multi-jurisdiction recall monitoring and captures the market context of
owned products. It does **not** yet monitor recalls worldwide.

## Current live coverage

| Jurisdiction  | Official authority                             | Source language | Status |
| ------------- | ---------------------------------------------- | --------------- | ------ |
| United States | U.S. Consumer Product Safety Commission (CPSC) | English         | Active |

The production Phase 12 schedule automatically checks official CPSC recall data every six hours at
minute 17 UTC, then runs the existing bounded matching and notification pipeline. No European,
Canadian, Australian, OECD, FDA, NHTSA, or other authority is active in Phase 13. The Coverage view
is driven by authoritative source metadata and must not present planned sources as live.

## Country of purchase

`purchase_country_code` is optional market context for an owned product. It answers “In which
country was this item purchased?” and stores a canonical uppercase ISO 3166-1 alpha-2 code such as
`BE`, `US`, or `GB`. The app displays the corresponding English country name.

It does not represent:

- the user's nationality or citizenship;
- the user's current location or GPS position;
- the device locale;
- the manufacturer's country; or
- a recall authority's jurisdiction.

Recall does not request location permission or infer this value from personal information. Existing
products remain `NULL`; current CPSC coverage is not a reason to invent `US`. A user may save an
optional default for newly created products, including barcode- and OCR-prefilled flows, and may
override it per product. Changing the default never rewrites existing inventory, and editing a
legacy product preserves its unspecified country unless the user chooses one.

## Recall jurisdictions

Recall jurisdiction belongs to an official notice, not to an owned product. Phase 13 normalizes it
as a notice relationship so future authorities can describe:

- countries, using ISO alpha-2 codes such as `US`, `CA`, or `AU`;
- regions, using controlled codes such as `EU` or `EEA`; or
- global context where an authority genuinely publishes a multi-jurisdiction notice.

The CPSC backfill associates existing CPSC notices with country `US`. It is idempotent and does not
change notice identity, original payloads, scopes, match decisions, fingerprints, or alert history.
Country-of-purchase and notice-jurisdiction values remain separate even when both happen to be
`US`.

## Source language

Source language describes the language of the authoritative material. Current CPSC source content
is recorded as English (`en`). Phase 13 adds metadata only: the app remains English-only and does
not translate, summarize into another language, or rewrite authoritative text. Multilingual-source
normalization and translation policy require a separate Phase 14 design and review.

## Matching behavior in Phase 13

Country of purchase is not a hard candidate filter, a matching signal, or an input to
`deterministic_v1`, `nemotron_v1`, `hybrid_guarded_v1`, or the safety verifier. CPSC is currently the
only live source; filtering by jurisdiction now would silently remove existing recall coverage for
products purchased elsewhere.

Country, jurisdiction, and source-language metadata are excluded from the existing evidence
fingerprint in Phase 13. Adding or backfilling that metadata alone therefore does not trigger
matching reevaluation. The matcher contracts, benchmark datasets, expected labels, and metrics are
unchanged. Phase 14 will define jurisdiction-aware source selection only when multiple real
authorities are available.

## Authority and assessment

The official authority establishes whether a recall exists and supplies the title, hazard, remedy,
scope, date, and official notice URL. Recall may compare an owned product with that official scope.
Nemotron may assist only within the existing guarded abstention path; it cannot create a recall or
replace the authority.

The user interface therefore separates:

- **Official recall information:** authority, jurisdiction, source language, hazard, remedy, date,
  and official link; and
- **Recall's match assessment:** the reason and identifiers used to decide whether the owned item
  appears to be in scope.

## Phase 14 adapter direction

Phase 14 is planned to add reviewed multi-authority ingestion. A source adapter should provide:

- stable source identity and official authority;
- declared jurisdictions and source language;
- bounded-window retrieval;
- normalized notice, scope, and jurisdiction records;
- the official notice URL; and
- a stable source-specific external ID.

Each source will require its own provenance, URL validation, rate and window limits, idempotency,
authority review, fixture coverage, and operational controls. Phase 13 adds no new network source
and intentionally avoids an unused plugin framework before those requirements are concrete.

## Safe monitoring status

Authenticated clients receive only three aggregate fields:

- `monitoringEnabled`;
- `lastSuccessfulCheckAt`; and
- `activeSourceCount`.

This is enough to show “Automatic monitoring active,” a real last-checked time when available, and
the count of active official sources. It exposes no Vault values, secrets, Cron administration,
private run history or errors, processing limits, AI credentials, prompts, push tokens, or
service-role data.
