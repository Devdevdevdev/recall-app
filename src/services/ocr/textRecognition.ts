import { OcrUnavailableError, type OcrTextResult } from './types';

/** Platform fallback. Metro selects the native or web implementation in app bundles. */
export async function recognizeTextFromImage(_imageUri: string): Promise<OcrTextResult> {
  throw new OcrUnavailableError();
}
