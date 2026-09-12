# Recall

Recall is a mobile application for Android and iOS that helps people learn when a product they
own has been recalled or declared unsafe. A user will scan or photograph a product once, confirm
its identity, and add it to a personal inventory. Recall will then compare owned products with
trusted recall notices and explain verified matches with their source and recommended action.

This repository is being built for the **Nebius × NVIDIA Global AI Hackathon 2026**, primarily for
the Best Apps and Agents Track.

## Current status

Phase 3 adds real Supabase email/password authentication while preserving the Phase 1 mobile shell
and Phase 2 database foundation:

- Expo SDK 57, React Native, TypeScript, and Expo Router
- Android, iOS, and web-compatible navigation shell
- Home, Scan, My Products, Alerts, and Settings screens
- Reusable safety-oriented design tokens and UI components
- A guarded Supabase client configuration for Android, iOS, and web
- Real email/password sign-up, sign-in, persisted sessions, and sign-out
- Protected Expo Router auth and authenticated route groups
- Framework-independent domain models and repository interfaces
- A migration-defined PostgreSQL schema with constraints, indexes, privileges, and Row Level
  Security
- Strict TypeScript, ESLint, and Prettier configuration

Password recovery, magic links, OAuth/social login, scanning, OCR, recall ingestion,
notifications, and AI matching execution are intentionally not implemented yet. The current
screens contain no fake data or integrations.

## Planned architecture

The mobile app will capture product identifiers through barcode scanning, images, and on-device
OCR. A secure backend will retrieve candidate notices from trusted recall sources. Nebius Token
Factory will run an NVIDIA open-source Nemotron model to normalize noisy product metadata and
reason about exact model, reference, lot, and date-range matches. Structured results and source
provenance will be stored in Supabase and used to deliver alerts.

AI will assist with matching; it will never be treated as the authority that a recall exists. See
[docs/architecture.md](docs/architecture.md) for the complete planned flow.

## Local setup

Prerequisites:

- Node.js 22.13 or later (required by Expo SDK 57)
- npm
- Expo Go or an Android/iOS simulator for device testing

Install and validate the project:

```bash
npm install
cp .env.example .env.local
npm run check
npm start
```

From the Expo terminal, open the project on Android, iOS, or web. You can also run `npm run
android`, `npm run ios`, or `npm run web` directly.

The example environment file contains names only. The application continues to load without
Supabase configuration during local development. To connect it, set
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the ignored `.env.local`
file. Both variables are public client configuration, not secrets; privacy depends on database
grants and Row Level Security.

Database changes live in `supabase/migrations/` and must be applied through the normal Supabase
migration workflow. See [docs/database.md](docs/database.md) for the schema and security model.
See [docs/authentication.md](docs/authentication.md) for the authentication architecture, dashboard
settings, and manual test plan.

## Security

**Never put `NEBIUS_API_KEY`, a Supabase secret/service-role key, or any other privileged
credential in the Expo client.** Expo public environment variables are bundled into the app and are readable by
users. The mobile client uses only the Supabase publishable key, and Row Level Security protects
user data. Nebius/NVIDIA requests and privileged recall writes will be introduced in a later phase
through a secure Supabase Edge Function or equivalent server-side component. When implemented,
Edge Functions may use Supabase's platform-provided publishable/secret key environment
configuration; secret credentials remain server-side only.

Do not commit `.env` files, credentials, service-account files, private keys, or generated native
configuration containing secrets. The repository includes defensive ignore rules, but every
contributor remains responsible for reviewing changes before committing.

## License

Released under the [MIT License](LICENSE).
