const { withPodfile } = require('@expo/config-plugins');
const withRnMlkitOcr = require('rn-mlkit-ocr/app.plugin.js');

const UPSTREAM_LATIN_ASSIGNMENT = "$ReactNativeOcrSubspecs = ['Latin', 'latin']";
const CORRECTED_LATIN_ASSIGNMENT = "$ReactNativeOcrSubspecs = ['latin']";

/**
 * Narrow compatibility wrapper for rn-mlkit-ocr@0.3.1.
 *
 * Its Expo plugin capitalizes configured model names, while its podspec checks lowercase names;
 * it then appends a second lowercase fallback and generates the redundant ['Latin', 'latin'] list.
 * Source context: https://github.com/ahmeterenodaci/rn-mlkit-ocr/blob/v0.3.1/plugin/src/index.ts#L56-L65
 *
 * Remove this wrapper and configure `rn-mlkit-ocr` directly after the upstream plugin preserves
 * lowercase `latin` in `$ReactNativeOcrSubspecs`.
 */
function withRnMlkitOcrLatinFix(config, props) {
  if (
    !props ||
    props.ocrUseBundled !== true ||
    !Array.isArray(props.ocrModels) ||
    props.ocrModels.length !== 1 ||
    props.ocrModels[0] !== 'latin'
  ) {
    throw new Error(
      'Recall requires rn-mlkit-ocr@0.3.1 with only ocrModels: ["latin"] and ocrUseBundled: true.',
    );
  }

  // Register the correction first so Expo's nested mod chain applies it to the upstream output.
  config = withPodfile(config, (podfileConfig) => {
    const contents = podfileConfig.modResults.contents;
    const occurrences = contents.split(UPSTREAM_LATIN_ASSIGNMENT).length - 1;

    if (occurrences !== 1) {
      throw new Error(
        `Expected one rn-mlkit-ocr@0.3.1 Latin Podfile assignment, found ${occurrences}. ` +
          'The upstream plugin may have changed; review and remove or update the local workaround.',
      );
    }

    podfileConfig.modResults.contents = contents.replace(
      UPSTREAM_LATIN_ASSIGNMENT,
      CORRECTED_LATIN_ASSIGNMENT,
    );
    return podfileConfig;
  });

  return withRnMlkitOcr(config, props);
}

module.exports = withRnMlkitOcrLatinFix;
