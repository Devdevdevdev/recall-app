export type OcrTextFrame = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type OcrTextElement = {
  frame: OcrTextFrame;
  text: string;
};

export type OcrTextLine = {
  elements: OcrTextElement[];
  frame: OcrTextFrame;
  text: string;
};

export type OcrTextBlock = {
  frame: OcrTextFrame;
  lines: OcrTextLine[];
  text: string;
};

/** Framework-independent OCR output retained in memory only. */
export type OcrTextResult = {
  blocks: OcrTextBlock[];
  text: string;
};

export class OcrUnavailableError extends Error {
  constructor() {
    super('Product label OCR is available in the Android and iOS app.');
    this.name = 'OcrUnavailableError';
  }
}
