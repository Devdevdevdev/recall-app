import { getCountryName, isSupportedCountryCode } from '../../domain/countries.ts';

export type JurisdictionType = 'country' | 'global' | 'region';

export type CoverageSourceProjection = {
  id: string;
  authority: string;
  jurisdictionType: JurisdictionType;
  jurisdictionCode: string;
  sourceLanguageCode: string | null;
  isActive: boolean;
};

export type CoverageSource = {
  id: string;
  authority: string;
  jurisdiction: string;
  sourceLanguage: string;
  status: 'Active' | 'Inactive';
};

export type MonitoringStatusProjection = {
  monitoringEnabled: boolean;
  lastSuccessfulCheckAt: string | null;
  activeSourceCount: number;
};

export type MonitoringStatusPresentation = {
  isActive: boolean;
  statusLabel: string;
  lastCheckedLabel: string;
  activeSourcesLabel: string;
};

const authorityDisplayNames: Readonly<Record<string, string>> = {
  CPSC: 'U.S. Consumer Product Safety Commission',
  'U.S. Consumer Product Safety Commission (CPSC)': 'U.S. Consumer Product Safety Commission',
};

const regionDisplayNames: Readonly<Record<string, string>> = {
  EEA: 'European Economic Area',
  EU: 'European Union',
};

const languageDisplayNames: Readonly<Record<string, string>> = {
  en: 'English',
};

export function getAuthorityDisplayName(authority: string): string {
  return authorityDisplayNames[authority] ?? authority;
}

export function getJurisdictionDisplayName(
  jurisdictionType: JurisdictionType,
  jurisdictionCode: string,
): string {
  if (jurisdictionType === 'global') {
    return 'Global';
  }

  if (jurisdictionType === 'country') {
    return getCountryName(jurisdictionCode);
  }

  return regionDisplayNames[jurisdictionCode] ?? jurisdictionCode;
}

export function inferJurisdictionType(jurisdictionCode: string): JurisdictionType {
  if (jurisdictionCode === 'GLOBAL') return 'global';
  if (isSupportedCountryCode(jurisdictionCode)) return 'country';
  return 'region';
}

export function getSourceLanguageDisplayName(sourceLanguageCode: string | null): string {
  if (!sourceLanguageCode) return 'Not specified';
  return languageDisplayNames[sourceLanguageCode] ?? sourceLanguageCode;
}

export function toCoverageSource(source: CoverageSourceProjection): CoverageSource {
  return {
    id: source.id,
    authority: getAuthorityDisplayName(source.authority),
    jurisdiction: getJurisdictionDisplayName(source.jurisdictionType, source.jurisdictionCode),
    sourceLanguage: getSourceLanguageDisplayName(source.sourceLanguageCode),
    status: source.isActive ? 'Active' : 'Inactive',
  };
}

export function formatMonitoringStatus(
  status: MonitoringStatusProjection,
  options: { locale?: string; timeZone?: string } = {},
): MonitoringStatusPresentation {
  const lastSuccessfulCheck = status.lastSuccessfulCheckAt
    ? new Date(status.lastSuccessfulCheckAt)
    : null;
  const hasValidCheck = lastSuccessfulCheck && !Number.isNaN(lastSuccessfulCheck.getTime());
  const sourceLabel = status.activeSourceCount === 1 ? 'source' : 'sources';

  return {
    isActive: status.monitoringEnabled,
    statusLabel: status.monitoringEnabled
      ? 'Automatic monitoring active'
      : 'Automatic monitoring unavailable',
    lastCheckedLabel: hasValidCheck
      ? `Last checked ${new Intl.DateTimeFormat(options.locale, {
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          month: 'short',
          timeZone: options.timeZone,
          year: 'numeric',
        }).format(lastSuccessfulCheck)}`
      : 'No successful check recorded yet',
    activeSourcesLabel: `${status.activeSourceCount} active official ${sourceLabel}`,
  };
}
