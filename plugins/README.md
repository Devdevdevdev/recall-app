# Local Expo config plugins

## `with-rn-mlkit-ocr-latin-fix.js`

Recall pins `rn-mlkit-ocr` to `0.3.1`. In that release, the package's Expo config plugin converts
the configured `latin` model name to `Latin` before writing `$ReactNativeOcrSubspecs` into the
generated iOS Podfile. Its podspec checks for lowercase `latin`, and the plugin then appends that
lowercase fallback, producing a redundant mixed-case list rather than the requested Latin-only
configuration.

The local wrapper first delegates Android and iOS configuration to the upstream plugin, then
changes only the exact generated assignment:

```text
$ReactNativeOcrSubspecs = ['Latin', 'latin']
```

to:

```text
$ReactNativeOcrSubspecs = ['latin']
```

It expects exactly one matching assignment and fails the native generation step if the expected
upstream output changes. It does not rewrite any other Podfile content. Android remains entirely
configured by the upstream plugin with `ocrModels = ["latin"]` and `ocrUseBundled = true`.

Once an upstream release preserves lowercase iOS model names, remove the wrapper file, replace its
entry in `app.json` with the fixed `rn-mlkit-ocr` plugin, and re-run temporary native-generation
validation before upgrading the pinned dependency.

Upstream source context:
<https://github.com/ahmeterenodaci/rn-mlkit-ocr/blob/v0.3.1/plugin/src/index.ts#L56-L65>
