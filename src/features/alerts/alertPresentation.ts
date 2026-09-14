import type { RecallMatchStatus } from '@/src/domain';

export type AlertMatchPresentation = {
  isConfirmed: boolean;
  listLabel: string;
  statusLabel: string;
};

export function getAlertMatchPresentation(status: RecallMatchStatus): AlertMatchPresentation {
  if (status === 'confirmed') {
    return {
      isConfirmed: true,
      listLabel: 'RECALL MATCH',
      statusLabel: 'Confirmed match',
    };
  }

  return {
    isConfirmed: false,
    listLabel: 'EVALUATION CHANGED',
    statusLabel: 'Currently unconfirmed — evaluation changed',
  };
}

export function getMatchMethodLabel(method: string): string {
  if (method === 'deterministic_v1') {
    return 'Deterministic identifier match';
  }

  if (method === 'hybrid_guarded_v1') {
    return 'Guarded AI-assisted review';
  }

  return 'Recall matching review';
}

export function toOfficialRecallUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function formatRecallDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) {
    return value;
  }

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(year, month - 1, day),
  );
}
