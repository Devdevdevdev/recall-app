# Recall

Recall is a mobile application for Android and iOS that helps people learn when a product they
own has been recalled or declared unsafe. A user will scan or photograph a product once, confirm
its identity, and add it to a personal inventory. Recall will then compare owned products with
trusted recall notices and explain verified matches with their source and recommended action.

This repository is being built for the **Nebius × NVIDIA Global AI Hackathon 2026**, primarily for
the Best Apps and Agents Track.

## Current status

**Phase 14 is released.** Recall now monitors two active official product-safety sources: the U.S.
Consumer Product Safety Commission (CPSC) and Health Canada. This is multi-source coverage, not
worldwide coverage.

The released product includes:

- An Expo SDK 57 app for Android and iOS with authenticated inventory, alerts, settings, coverage,
  barcode scanning, and on-device label OCR.
- A primary product identity that keeps product name and brand separate from structured identifiers
  such as GTIN, model, serial, and lot. Every inventory item also records an editable `scan_date` as
  a date-only value without changing matching evidence.
- Temporary label images processed only on device and deleted from cache on best effort. Images,
  private OCR payloads, and personal product history are not sent to the model.
- Official recall adapters for CPSC and Health Canada. Source URLs, authority identity, notice
  language, jurisdiction, raw provenance, and normalized scope evidence are preserved.
- Autonomous monitoring on a bounded six-hour schedule. Each source has isolated retrieval state;
  one source failure does not erase successful work from the other. Matching, AI, and push each
  retain independent limits and kill switches.
- RLS-protected Supabase inventory and alerts, private worker leases, canonical evidence
  fingerprints, transactional alert creation, and server-only push delivery.

### Nebius Token Factory + NVIDIA Nemotron

Recall uses **Nebius Token Factory** to run
`nvidia/nemotron-3-super-120b-a12b` for the small subset of candidate matches that deterministic
rules cannot safely resolve. The API key is server-only, destinations and model identity are pinned,
requests have bounded timeouts/retries, and outputs must pass strict local schemas.

The production policy is deterministic-first:

1. Exact structured identifiers and safe scope boundaries are evaluated locally.
2. Confirmed and rejected deterministic decisions bypass AI.
3. Only `needs_review` cases may reach Nemotron.
4. A model confirmation is advisory until a local verifier finds source-addressable evidence in the
   official notice.
5. AI rejection, invalid output, provider failure, or unverifiable evidence remains
   `needs_review`—never a silent safety conclusion.

Official authorities establish that a recall exists. Recall and Nemotron answer only whether the
controlled evidence for an owned product falls inside that official scope.

Phase 15 adds a separate 200-case safety benchmark with development, frozen holdout, and adversarial
stress splits. On this controlled CPSC-backed set, deterministic v1 measured 86.5% accuracy with
three unsafe confirmations, standalone Nemotron measured 89.5% with seven, and guarded hybrid
measured 84.5% with three. Guarded hybrid used 101 requests and USD 0.160123; eleven schema-exhausted
cases failed closed to `needs_review`. These are internal benchmark measurements, not population
claims. Historical benchmark artifacts remain immutable.

Known limitations remain explicit: Recall covers only CPSC and Health Canada; it does not identify a
commercial product from a photo, infer missing identifiers, translate authoritative notices, or
claim representative real-world accuracy. Password recovery, magic links, social login, and public
demo-build publication are still incomplete.

## Architecture

The mobile app captures product identifiers through barcode scanning, images, and on-device OCR.
A secure backend retrieves bounded candidates from authoritative recall records, runs the
deterministic matcher, and escalates only abstentions to NVIDIA Nemotron through Nebius Token
Factory. Locally verified structured results and source provenance are stored transactionally in
Supabase and exposed as authenticated in-app alerts. The official authority establishes that a
recall exists; Recall and Nemotron only assess whether an owned product fits the official scope.

The deterministic baseline is deliberately conservative: exact structured identifiers dominate,
product-name similarity alone cannot confirm, and ambiguity becomes `needs_review`. Its confidence
is an evidence-strength heuristic, not a probability. AI is never treated as the authority that a
recall exists. See [docs/architecture.md](docs/architecture.md) for the complete flow.

## Local setup

Prerequisites:

- Node.js 22.13 or later (required by Expo SDK 57)
- npm
- Expo Go for barcode-only testing, or native Android/iOS build tools for label OCR testing

Install and validate the project:

```bash
npm install
cp .env.example .env.local
npm run check
npm start
```

From the Expo terminal, open the project on Android, iOS, or web. You can also run `npm run
android`, `npm run ios`, or `npm run web` directly.

Label OCR requires Recall's native development build because it includes ML Kit code. For a local
Android physical-device build run `npx expo run:android --device`; after installation use `npx expo
start --dev-client` for JavaScript-only iterations. Expo Go continues to support the barcode flow
but cannot run `rn-mlkit-ocr`. See [docs/ocr-scanning.md](docs/ocr-scanning.md) for native build,
privacy, parser, workaround, and physical-device instructions.

Remote push also requires the custom development build. For EAS Android builds, keep the local
`google-services.json` ignored and provide it through the secret FILE variable
`GOOGLE_SERVICES_JSON`; `app.config.js` preserves `./google-services.json` as the local fallback.
Build with `npx eas build --profile development --platform android`. See
[docs/push-notifications.md](docs/push-notifications.md) for credentials, privacy, delivery, and the
first-push approval procedure.

The example environment file contains names only. The application continues to load without
Supabase configuration during local development. To connect it, set
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the ignored `.env.local`
file. Both variables are public client configuration, not secrets; privacy depends on database
grants and Row Level Security.

Database changes live in `supabase/migrations/` and must be applied through the normal Supabase
migration workflow. See [docs/database.md](docs/database.md) for the schema and security model.
See [docs/authentication.md](docs/authentication.md) for the authentication architecture, dashboard
settings, and manual test plan. See [docs/product-inventory.md](docs/product-inventory.md) for the
inventory data boundary and ownership model. See [docs/barcode-scanning.md](docs/barcode-scanning.md)
for the Phase 5 scanner permissions, validation, privacy model, and physical-device test plan.
See [docs/ocr-scanning.md](docs/ocr-scanning.md) for the Phase 6 on-device OCR architecture and
manual test plan, [docs/product-inventory.md](docs/product-inventory.md) for date handling, and
[docs/barcode-scanning.md](docs/barcode-scanning.md) for barcode classifications.
See [docs/recall-ingestion.md](docs/recall-ingestion.md) for CPSC provenance, dry-run, and
deployment steps, [docs/recall-matching.md](docs/recall-matching.md) for deterministic matching
rules and the integration boundary, and
[benchmarks/recall-matching/README.md](benchmarks/recall-matching/README.md) for the executable
evaluations, and [docs/nebius-nemotron.md](docs/nebius-nemotron.md) for the Phase 9 provider
boundary, measured results, costs, and limitations. See
[docs/automatic-recall-loop.md](docs/automatic-recall-loop.md) for Phase 10 operation, budgets,
idempotency, deployment, and manual verification.
See [docs/push-notifications.md](docs/push-notifications.md) for Phase 11 device registration,
delivery security, retry semantics, and Android verification.
See [docs/autonomous-monitoring.md](docs/autonomous-monitoring.md) for the bounded multi-source
schedule, controls, and safe status projection, and [docs/global-coverage.md](docs/global-coverage.md)
for the released CPSC and Health Canada coverage boundary.

## Security

**Never put `NEBIUS_API_KEY`, a Supabase secret/service-role key, or any other privileged
credential in the Expo client.** Expo public environment variables are bundled into the app and are readable by
users. The mobile client uses only the Supabase publishable key, and Row Level Security protects
user data. The CPSC ingestion and recall-matching Edge Functions perform privileged work only with
server-side credentials and separate administrative secrets; no mobile client invokes them.
Phase 10 preserves the Phase 9.1 guard: only deterministic abstentions can reach Nemotron, and a
model confirmation must still pass local, source-addressable evidence verification before an alert
can be created. The controlled holdout and implementation tests do not establish general-world
accuracy; production operation must remain monitored and bounded.

Do not commit `.env` files, credentials, service-account files, private keys, or generated native
configuration containing secrets. The repository includes defensive ignore rules, but every
contributor remains responsible for reviewing changes before committing.

## License

Released under the [MIT License](LICENSE).
