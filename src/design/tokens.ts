import type { TextStyle } from 'react-native';

export const colors = {
  brand: {
    primary: '#075B4C',
    primaryPressed: '#04483C',
    soft: '#DDEFEA',
    ink: '#0C2E29',
  },
  semantic: {
    safe: '#147A60',
    safeSoft: '#E2F3ED',
    warning: '#A15C00',
    warningSoft: '#FFF1D6',
    danger: '#B42318',
    dangerSoft: '#FDE8E7',
  },
  surface: {
    background: '#F3F6F5',
    raised: '#FFFFFF',
    sunken: '#E8EEEC',
  },
  text: {
    primary: '#10231F',
    secondary: '#475D57',
    muted: '#71827D',
    inverse: '#FFFFFF',
  },
  border: {
    subtle: '#DCE4E1',
    strong: '#B9C8C3',
  },
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

export const typography = {
  size: {
    caption: 12,
    label: 14,
    body: 16,
    subtitle: 20,
    title: 30,
    display: 38,
  },
  lineHeight: {
    caption: 16,
    label: 20,
    body: 24,
    subtitle: 26,
    title: 36,
    display: 44,
  },
  weight: {
    regular: '400' as TextStyle['fontWeight'],
    medium: '500' as TextStyle['fontWeight'],
    semibold: '600' as TextStyle['fontWeight'],
    bold: '700' as TextStyle['fontWeight'],
  },
} as const;
