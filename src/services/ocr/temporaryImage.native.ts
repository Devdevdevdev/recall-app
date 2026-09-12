import { File } from 'expo-file-system';

/** Best-effort deletion for the cache file returned by CameraView.takePictureAsync(). */
export async function deleteTemporaryImage(imageUri: string): Promise<void> {
  try {
    const image = new File(imageUri);
    if (image.exists) {
      image.delete();
    }
  } catch {
    // Cleanup must not replace the OCR result or error with a secondary filesystem failure.
  }
}
