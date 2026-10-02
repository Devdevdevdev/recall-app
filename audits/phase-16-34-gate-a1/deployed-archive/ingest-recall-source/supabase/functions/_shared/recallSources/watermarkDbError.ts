type DatabaseError = { code?: string; message?: string } | null;

// The Phase 16.17 trigger uses SQLSTATE 23514. That code is shared by other
// constraints, so only its exact, versioned messages identify this guard.
export function classifySourceWatermarkDbError(
  error: DatabaseError,
): 'watermark_regression' | 'watermark_invalid' | null {
  if (error?.code !== '23514') return null;
  if (
    /^source watermark cannot move backward from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/u.test(
      error.message ?? '',
    )
  ) {
    return 'watermark_regression';
  }
  if (
    error.message === 'source watermark cursor is malformed or has an unexpected kind' ||
    error.message === 'source watermark existing cursor is malformed or has an unexpected kind'
  ) {
    return 'watermark_invalid';
  }
  return null;
}
