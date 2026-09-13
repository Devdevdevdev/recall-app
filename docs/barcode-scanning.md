# Barcode scanning

## Phase 5 and 6.1 scope

Recall uses `expo-camera` and Expo SDK 57's `CameraView` to acquire a physical product barcode.
The scanner accepts `ean13`, `ean8`, `upc_a`, `upc_e`, `itf14`, and `code128` events. QR codes,
URLs, Aztec, and PDF417 values are deliberately filtered out.

The app configures the `expo-camera` plugin with the iOS explanation “Allow Recall to use your
camera to scan product barcodes.” Barcode scanning is enabled and Android audio recording is
explicitly disabled (`recordAudioAndroid: false`). Recall does not request microphone, photo
library, or media permissions for this feature.

## Scan flow and validation

```text
Scan tab → camera permission → live CameraView → barcode confirmation
         → existing Add Product form (prefilled GTIN) → existing repository → Supabase
```

Only an accepted GTIN is handed to the existing product form. The camera never writes to Supabase
and never creates a product itself. The form validates the untrusted route parameter again before
save; it also requires a product name because barcode scanning does not identify a product, brand,
model, or category.

`src/domain/barcode.ts` is framework-independent. It trims outer whitespace, requires digits only,
preserves leading zeroes, accepts GTIN-8, GTIN-12, GTIN-13, and GTIN-14, and calculates the GS1
modulo-10 check digit. It never parses a GTIN as a JavaScript number. A scanner's value remains as
`rawValue` while a separate normalized value is used for the form. UPC-A and EAN-13 remain their
respective 12- and 13-digit values; Recall does not remove leading zeroes or convert between them.

Deterministic validation vectors: valid GTIN-8 `96385074`, valid UPC-A `036000291452`, valid
EAN-13 `4006381333931`, valid GTIN-14 `10614141123459`, and valid leading-zero UPC-A
`012345678905`. Changing the last digit of each produces an invalid checksum; non-digits, wrong
lengths, and internal whitespace are invalid too.

After the first supported event, a synchronous scanner lock and explicit `detected` state unmount
the preview and prevent repeated callbacks, navigation, or product creation. “Scan again” clears
that state and reactivates scanning. The preview is rendered only while the Scan tab is focused.

### GTIN and non-GTIN classifications

The pure barcode domain model classifies each supported scanner result as `valid_gtin`,
`non_gtin_product_code`, or `invalid_or_unsupported`. GTIN checksum validation remains strict;
only valid GTIN-8, GTIN-12, GTIN-13, and GTIN-14 values receive the existing **Product barcode
detected** confirmation and **Use this barcode** handoff with `identification_method =
barcode_scan`.

A non-empty Code 128 payload without control characters is a meaningful decoded product code even
when it is not a GTIN. For example, `8SSA10M42792C1SG85R0L15` is shown as **Product code
detected**, labelled Code 128, and explains that it may be another manufacturer identifier. It is
kept only in current scanner state, never placed into `gtin`, `model_number`, `serial_number`, or
`lot_number`, and never persisted. The available **Read product label** action moves deliberately
into the existing OCR mode without running combined barcode/OCR inference. This transient evidence
can later be supplied to a structured product-identification engine after its purpose is known.

Empty, malformed, control-character, or unsupported results retain invalid/unsupported messaging.
An invalid-check-digit EAN/UPC/ITF result is likewise not treated as a non-GTIN Code 128 product
code.

## Privacy, availability, and limitations

Recall does not capture, save, upload, or transmit camera frames. It does not call external product
or barcode APIs. The user must confirm the GTIN before it reaches the existing form.

If permission is denied, permanently denied, the camera cannot mount, or a browser cannot provide
camera access, the screen explains the issue and retains the manual-entry route. The app therefore
continues to render on web even where scanning is unavailable.

Products created through the confirmed scanner route retain `identification_method = barcode_scan`
and `identification_confidence = null`. Manual entries retain `manual`. No database migration is
needed because the existing text identification field supports both values.

Phase 6 adds label OCR as a separate Scan mode without changing this barcode state machine. Barcode
mode remains the default and still takes no photo. External product lookup, recall matching, and
automatic product identity remain future work. See [ocr-scanning.md](ocr-scanning.md).

## Physical-device manual test plan

1. Reset camera permission, open **Scan**, and choose **Allow camera access**. Confirm the preview
   opens and no microphone prompt appears.
2. Deny permission. Confirm no crash, a useful explanation, and **Enter product manually**.
3. Scan valid EAN-13 `4006381333931`. Confirm exactly one EAN-13 confirmation appears with the
   digits shown unchanged.
4. Choose **Use this barcode**. Confirm the existing Add Product form opens with the GTIN filled;
   enter a name, save, and confirm the record appears under **My Products**.
5. Restart Recall and confirm the product persists. Inspect the row through the normal product
   detail flow or Supabase console: method is `barcode_scan` and confidence is null.
6. Keep the barcode in view after first detection. Confirm there is no repeated navigation or
   additional product. Choose **Scan again** and confirm the preview resumes.
7. Scan an invalid check digit or exercise `validateGtin` with one. Confirm it cannot be used as a
   confirmed GTIN. Test manual entry, Home → Scan, web fallback, and sign-out route protection.
8. Scan Code 128 `8SSA10M42792C1SG85R0L15` (or another meaningful non-GTIN code). Confirm it is
   called a product code, is not placed into GTIN or another identifier field, and offers **Read
   product label**, **Scan again**, and manual entry.
9. From that Code 128 result choose **Read product label**. Confirm the existing OCR camera and
   review flow work normally and no duplicate camera preview is created.
