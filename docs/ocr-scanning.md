# Product label OCR

## Phase 6 scope

Recall can photograph a product label, rating plate, package label, or manufacturer sticker and
recognize its visible Latin-script text on the device. This is an acquisition aid only. OCR does
not establish a commercial product identity, determine that a recall exists, or perform recall
matching.

The native implementation is pinned to `rn-mlkit-ocr@0.3.1`, backed by Google ML Kit Text
Recognition. The Expo plugin configuration includes only `ocrModels: ["latin"]`; Android also uses
`ocrUseBundled: true`, so the hackathon build does not depend on downloading the Latin model on its
first recognition request. Chinese, Japanese, Korean, and Devanagari models are not configured.

## Development build requirement

`rn-mlkit-ocr` adds native ML Kit code and is therefore unavailable in standard Expo Go. Recall
includes `expo-dev-client` and a minimal `development` profile in `eas.json`. Barcode scanning
worked in Expo Go because `expo-camera` is included there; label OCR requires Recall's own native
development build.

For a local Android physical-device build:

1. Install Android Studio, the Android SDK, and platform tools; enable USB debugging on the device.
2. Run `npm install` in the repository.
3. Connect the device and confirm it appears with `adb devices`.
4. Run `npx expo run:android --device`. Expo generates the ignored `android/` directory, compiles,
   installs, and starts the development client without requiring an Expo account.
5. On later JavaScript-only changes, run `npx expo start --dev-client`. Rebuild after changing a
   native dependency or app/plugin configuration.

For a local iOS build on macOS, configure a unique `ios.bundleIdentifier` and the appropriate local
Xcode signing team, connect the iPhone with Developer Mode enabled, then run `npx expo run:ios
--device`. No EAS cloud build is required. Generated `ios/` and `android/` directories are ignored
and must not be committed.

## Scan and image lifecycle

```text
Scan → Read product label → live CameraView → Capture label
     → temporary cache image → on-device Latin OCR → normalized text/blocks
     → best-effort image deletion → conservative parser → user review
     → existing Add Product form → repository → Supabase text fields only
```

Phase 6 reuses the existing `expo-camera` permission flow, camera preview, and torch. It calls
`CameraView.takePictureAsync()` only after `onCameraReady`, at `0.85` JPEG quality with orientation
processing retained. It does not use continuous frames, live processors, the photo library,
storage permission, or the microphone.

The camera-created file remains in application cache. Recognition runs against that local URI.
The URI is never stored in UI/domain state or Supabase, and the file is deleted on best effort in
a `finally` block after success, failure, or an abandoned operation. Only normalized OCR text and
blocks remain in memory for review. Recall does not upload the image to Supabase Storage, Google
Cloud, Nebius, NVIDIA, OpenAI, Gemini, or any other network service.

## Code 128 handoff

Phase 6.1 lets a meaningful non-GTIN Code 128 result deliberately enter this existing label mode.
The decoded code remains transient scanner evidence; OCR still begins only after the user chooses
**Read product label** and captures a label. Recall does not combine the barcode and OCR result,
infer a product identity, or map the code to model, serial, lot, or GTIN. This keeps the verified
single-camera lifecycle and conservative OCR review unchanged. A later structured-evidence
product-identification phase may evaluate a user-confirmed barcode code together with label text.

Although `expo-file-system` declares legacy Android external-storage permissions, Recall operates
only on its private cache URI and explicitly blocks `READ_EXTERNAL_STORAGE` and
`WRITE_EXTERNAL_STORAGE` from the final manifest. `RECORD_AUDIO` is blocked as an additional
defense alongside the existing `recordAudioAndroid: false` camera setting.

## Service and platform boundary

`src/services/ocr/` owns the device integration:

- `types.ts` defines framework-independent text, block, line, element, and frame values.
- `textRecognition.native.ts` lazily loads `rn-mlkit-ocr`, requests the Latin recognizer, and copies
  the native response into Recall-owned types.
- `textRecognition.web.ts` reports that OCR is mobile-only, so the web bundle never imports the
  native ML Kit package.
- `temporaryImage.native.ts` performs narrow best-effort deletion with `expo-file-system`.

The Scan UI retains the normalized full text and blocks in memory but never stores raw native OCR
objects or logs recognized label contents. The explicit states are `idle`, `camera_ready`,
`capturing`, `recognizing_text`, `reviewing`, `no_text_found`, and `error`. Synchronous locks and
operation identifiers prevent overlapping captures and stale results.

## Conservative identifier parser

`src/domain/productLabel.ts` is pure and deterministic. It recognizes model, reference, serial,
and lot/batch values only when an explicit supported label appears on the same line or immediately
before the value. Values preserve letters, digits, leading zeroes, hyphens, slashes, dots, and
normalized internal spaces. The parser does not coerce identifiers to numbers.

Unlabeled voltage, frequency, power, certification, country-of-origin, and arbitrary numeric text
remain unclassified. Even after an explicit label, common electrical values such as `220-240V`
are rejected. The review labels every result as a possible value and shows the recognized source
text on request. Users must confirm before continuing.

The existing database has no `reference_number` column. An explicitly detected reference is shown
in review but is not silently copied into model, serial, lot, or another field. No migration was
added. The route passes only model, serial, and lot candidates, and ProductForm utilities validate
those untrusted parameters again before prefilling.

Products saved from accepted OCR identifiers use `identification_method = ocr_assisted`,
`identification_confidence = null`, and `image_path = null`. If OCR finds text but no persistable
candidate, continuing opens the manual form and preserves the `manual` method.

## Local config-plugin workaround

`rn-mlkit-ocr@0.3.1` capitalizes explicitly configured iOS model names before writing them to the
Podfile, then appends the lowercase Latin fallback expected by its podspec. This produces the
redundant mixed-case list `['Latin', 'latin']`. Recall wraps the upstream plugin with
`plugins/with-rn-mlkit-ocr-latin-fix.js`. The wrapper changes only that exact single assignment to
`['latin']`, fails closed if it is missing or duplicated, and leaves Android behavior and all
unrelated Podfile content untouched. See `plugins/README.md` for removal instructions after an
upstream fix.

React Native Directory does not currently mark `rn-mlkit-ocr` as tested on the New Architecture,
so the required pinned package is excluded from that metadata-only Expo Doctor lookup. This does
not waive native testing: the package still resolves through Expo prebuild and produces Android/iOS
bundles, while final compatibility must be confirmed by the documented physical-device development
build. Remove the Doctor exclusion when upstream directory metadata covers the package.

## Manual test plan

1. **Barcode regression:** Scan a known EAN/UPC. Confirm Phase 5 validation, duplicate locking,
   confirmation, ProductForm prefill, and `barcode_scan` persistence remain unchanged.
2. **Model:** Photograph `Model: HD9252/90`. Confirm the text and possible model appear.
3. **Serial:** Photograph a clear explicitly labeled serial. Confirm a serial appears only with
   label evidence.
4. **Lot:** Photograph `LOT: 24A17` or `Batch No B-2026-09`. Confirm the lot candidate appears.
5. **Electrical noise:** Photograph `220-240V`, `50Hz`, `1500W`, and `CE`. Confirm none is classified
   as a model, serial, or lot.
6. **No text:** Photograph a blank surface. Confirm the no-text guidance and retry/manual actions.
7. **Bad photo:** Use a blurred or distant label. Confirm no crash and a working retake flow.
8. **Product form:** Accept extracted model/serial/lot values. Confirm only those fields are
   prefilled and product name remains required.
9. **Save:** Supply a name and save. Confirm `ocr_assisted`, null confidence, and null image path in
   Supabase.
10. **Privacy:** Confirm no Storage object, image column value, cloud OCR request, or gallery item is
    created; temporary deletion is attempted after every outcome.
11. **Offline OCR:** After installing the native build, disable networking and confirm Android Latin
    OCR still works through the bundled model.
12. **Web:** Open label mode in a web export. Confirm the mobile-only explanation and manual entry;
    verify no native-module crash.
13. **Authentication:** Sign out and confirm Scan and product routes remain protected.
14. **Code 128 handoff:** Scan a meaningful non-GTIN Code 128, choose **Read product label**, and
    confirm the native OCR camera, capture, temporary-image deletion, and review behavior remain
    functional.

## Future direction

The transient `ProductScanEvidence` type can later combine a GTIN with OCR text and extracted
identifiers. A secure later phase may send confirmed structured evidence—not the temporary photo—to
Nebius-hosted NVIDIA Nemotron for ambiguous normalization and matching against trusted recall
records. That future reasoning layer remains separate from Phase 6 perception and parsing.
