import { OcrUnavailableError, type OcrTextResult } from './types';

export async function recognizeTextFromImage(_imageUri: string): Promise<OcrTextResult> {
  throw new OcrUnavailableError();
}
