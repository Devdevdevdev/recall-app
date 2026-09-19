const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}

/** Converts a local calendar date to PostgreSQL's date-only representation without UTC conversion. */
export function dateToDateOnly(value: Date): string {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}`;
}

/**
 * Parses a PostgreSQL date-only value as a local calendar date. Date-only values must never pass
 * through `new Date('YYYY-MM-DD')`, which interprets them as UTC and can shift the displayed day.
 */
export function dateOnlyToLocalDate(value: string): Date | null {
  const match = dateOnlyPattern.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localDate = new Date(year, month - 1, day);

  return localDate.getFullYear() === year &&
    localDate.getMonth() === month - 1 &&
    localDate.getDate() === day
    ? localDate
    : null;
}

export function isValidDateOnly(value: string): boolean {
  return dateOnlyToLocalDate(value) !== null;
}

export function purchaseDateOrNull(value: string): string | null {
  const dateOnly = value.trim();
  return dateOnly.length === 0 ? null : dateOnly;
}

export function todayDateOnly(now = new Date()): string {
  return dateToDateOnly(now);
}

export function isFuturePurchaseDate(value: string, today = todayDateOnly()): boolean {
  return value > today;
}

export function formatPurchaseDate(value: string): string {
  const date = dateOnlyToLocalDate(value);

  if (!date) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** Stable English display for Recall's primary, user-facing scan date. */
export function formatScanDate(value: string): string {
  const date = dateOnlyToLocalDate(value);

  if (!date) {
    return value;
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ] as const;
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
