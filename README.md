# Recall

Recall is a mobile application for Android and iOS that helps people learn when a product they
own has been recalled or declared unsafe. A user will scan or photograph a product once, confirm
its identity, and add it to a personal inventory. Recall will then compare owned products with
trusted recall notices and explain verified matches with their source and recommended action.

This repository is being built for the **Nebius × NVIDIA Global AI Hackathon 2026**, primarily for
the Best Apps and Agents Track.

## Current status

Phase 1 establishes the mobile foundation:

- Expo SDK 57, React Native, TypeScript, and Expo Router
- Android, iOS, and web-compatible navigation shell
- Home, Scan, My Products, Alerts, and Settings screens
- Reusable safety-oriented design tokens and UI components
- Strict TypeScript, ESLint, and Prettier configuration

Scanning, authentication, storage, recall retrieval, notifications, and AI matching are
intentionally not implemented yet. The current screens clearly mark those capabilities as future
work and contain no fake integrations.

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

The example environment file contains names only. Phase 1 does not require any credentials.

## Security

**Never put `NEBIUS_API_KEY`, a Supabase service-role key, or any other privileged credential in
the Expo client.** Expo public environment variables are bundled into the app and are readable by
users. Nebius/NVIDIA requests will be introduced in a later phase through a secure Supabase Edge
Function or equivalent server-side component.

Do not commit `.env` files, credentials, service-account files, private keys, or generated native
configuration containing secrets. The repository includes defensive ignore rules, but every
contributor remains responsible for reviewing changes before committing.

## License

Released under the [MIT License](LICENSE).
