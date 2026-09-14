# Recall

Recall is a mobile application for Android and iOS that helps people learn when a product they
own has been recalled or declared unsafe. A user will scan or photograph a product once, confirm
its identity, and add it to a personal inventory. Recall will then compare owned products with
trusted recall notices and explain verified matches with their source and recommended action.

This repository is being built for the **Nebius × NVIDIA Global AI Hackathon 2026**, primarily for
the Best Apps and Agents Track.

## Current status

Phase 9 adds a measured, server-only Nebius/NVIDIA comparison alongside the deterministic matcher,
verified CPSC ingestion, and Phase 6.1 mobile flow:

- Expo SDK 57, React Native, TypeScript, and Expo Router
- Android, iOS, and web-compatible navigation shell
- Home, Scan, My Products, Alerts, and Settings screens
- Reusable safety-oriented design tokens and UI components
- A guarded Supabase client configuration for Android, iOS, and web
- Real email/password sign-up, sign-in, persisted sessions, and sign-out
- Protected Expo Router auth and authenticated route groups
- Real authenticated product list, pull-to-refresh, manual product creation, detail, editing, and
  confirmed deletion
- Camera barcode acquisition using Expo SDK 57's `expo-camera`, with confirmation before the
  existing product form is prefilled and saved
- Still-image product-label OCR using pinned `rn-mlkit-ocr@0.3.1` and the Latin-only Google ML Kit
  model, with conservative model/serial/lot extraction and review before ProductForm
- Temporary label photos processed only on device and deleted from app cache on best effort; no
  image is uploaded, persisted, or added to the photo library
- A custom native development-client configuration because ML Kit OCR is not available in Expo Go,
  while web retains a safe mobile-only explanation and manual entry
- GS1 check-digit validation for GTIN-8, GTIN-12, GTIN-13, and GTIN-14 while preserving leading
  zeroes, plus manual entry when camera access is unavailable
- Native Android/iOS purchase-date selection through Expo-compatible
  `@react-native-community/datetimepicker`, with a browser-native web date fallback; dates are
  stored as date-only `YYYY-MM-DD` values without UTC conversion
- Clear distinction between a validated GTIN and a meaningful non-GTIN Code 128 product code; the
  latter can lead into label OCR but is never guessed to be a GTIN, model, serial, or lot number
- A Supabase-backed inventory repository that maps database rows to domain objects and derives
  product ownership from the authenticated user
- Framework-independent domain models and repository interfaces
- A migration-defined PostgreSQL schema with constraints, indexes, privileges, and Row Level
  Security
- A server-only Supabase Edge Function that retrieves date-bounded JSON recall records from the
  official CPSC Retrieval API, preserves raw CPSC payloads, and safely upserts notices/scopes
- Pure server-safe `deterministic_v1` candidate retrieval, per-scope evidence evaluation, and
  multi-scope aggregation with a versioned common match contract
- A frozen 30-case public-CPSC benchmark with explicit label provenance, privacy validation,
  three-class metrics, false-positive reporting, decision coverage, latency, and zero AI cost
- A dependency-free Nebius Token Factory client with destination validation, bounded timeouts and
  retries, redacted errors, and no React Native import path
- A fixed `nemotron_v1` prompt, forced strict function-tool schema, local output validation, and an
  explicit benchmark projection that excludes expected labels and evaluation metadata
- A real one-pass evaluation of `nvidia/nemotron-3-super-120b-a12b`: 70.0% exact accuracy, 90.0%
  strict recall, four false positives, 86.7% structured-output success, and USD 0.0616212 measured
  inference cost on the 30 controlled cases
- Strict TypeScript, ESLint, and Prettier configuration

Password recovery, magic links, OAuth/social login, external product lookup, production match
orchestration/persistence, notifications, and scheduled ingestion are intentionally not implemented
yet. Phase 9 AI execution is benchmark-only and read-only. Scanning acquires
only barcode data or visible label text; it does not identify a commercial product. Product detail
screens do not make safety or recall conclusions before authoritative recall data exists.

## Planned architecture

The mobile app will capture product identifiers through barcode scanning, images, and on-device
OCR. A secure backend will retrieve candidate notices from trusted recall sources. Nebius Token
Factory will run an NVIDIA open-source Nemotron model to normalize noisy product metadata and
reason about exact model, reference, lot, and date-range matches. Structured results and source
provenance will be stored in Supabase and used to deliver alerts.

The deterministic baseline is deliberately conservative: exact structured identifiers dominate,
product-name similarity alone cannot confirm, and ambiguity becomes `needs_review`. Its confidence
is an evidence-strength heuristic, not a probability. AI may later assist with matching; it will
never be treated as the authority that a recall exists. See
[docs/architecture.md](docs/architecture.md) for the complete planned flow.

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
boundary, measured results, costs, and limitations.

## Security

**Never put `NEBIUS_API_KEY`, a Supabase secret/service-role key, or any other privileged
credential in the Expo client.** Expo public environment variables are bundled into the app and are readable by
users. The mobile client uses only the Supabase publishable key, and Row Level Security protects
user data. The CPSC ingestion Edge Function performs privileged recall writes only with
server-side credentials and its own `RECALL_INGESTION_KEY`; no mobile client invokes it.
Phase 9 Nebius calls remain server/local-process only and benchmark-only. They do not create an
endpoint, database write, match row, notification, or alert. The measured false positives prohibit
using `nemotron_v1` as a production automatic-alert policy.

Do not commit `.env` files, credentials, service-account files, private keys, or generated native
configuration containing secrets. The repository includes defensive ignore rules, but every
contributor remains responsible for reviewing changes before committing.

## License

Released under the [MIT License](LICENSE).
