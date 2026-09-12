import type { OcrTextResult } from './types';

/** Runs Latin-script recognition locally and normalizes away the native library's object types. */
export async function recognizeTextFromImage(imageUri: string): Promise<OcrTextResult> {
  // Lazy loading keeps a missing native module from crashing the scanner before the user captures.
  const { recognizeText } = await import('rn-mlkit-ocr');
  const result = await recognizeText(imageUri, 'latin');

  return {
    text: result.text,
    blocks: result.blocks.map((block) => ({
      text: block.text,
      frame: { ...block.frame },
      lines: block.lines.map((line) => ({
        text: line.text,
        frame: { ...line.frame },
        elements: line.elements.map((element) => ({
          text: element.text,
          frame: { ...element.frame },
        })),
      })),
    })),
  };
}
