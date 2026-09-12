import type { Theme } from 'expo-router';

import { colors } from './tokens';

export const navigationTheme: Theme = {
  dark: false,
  colors: {
    primary: colors.brand.primary,
    background: colors.surface.background,
    card: colors.surface.raised,
    text: colors.text.primary,
    border: colors.border.subtle,
    notification: colors.semantic.danger,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '700' },
  },
};
