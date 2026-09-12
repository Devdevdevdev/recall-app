import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/src/design/tokens';

type AuthTextFieldProps = {
  autoComplete: 'email' | 'current-password' | 'new-password';
  error?: string;
  label: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  value: string;
};

export function AuthTextField({
  autoComplete,
  error,
  label,
  onChangeText,
  secureTextEntry = false,
  value,
}: AuthTextFieldProps) {
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const isEmail = autoComplete === 'email';

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputContainer, error && styles.inputContainerError]}>
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoComplete={autoComplete}
          autoCorrect={false}
          keyboardType={isEmail ? 'email-address' : 'default'}
          onChangeText={onChangeText}
          placeholder={isEmail ? 'you@example.com' : '••••••••'}
          placeholderTextColor={colors.text.muted}
          secureTextEntry={secureTextEntry && !isPasswordVisible}
          style={styles.input}
          textContentType={
            isEmail ? 'emailAddress' : autoComplete === 'new-password' ? 'newPassword' : 'password'
          }
          value={value}
        />
        {secureTextEntry ? (
          <Pressable
            accessibilityLabel={isPasswordVisible ? 'Hide password' : 'Show password'}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setIsPasswordVisible((visible) => !visible)}
            style={styles.visibilityButton}>
            <Text style={styles.visibilityLabel}>{isPasswordVisible ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  label: {
    color: colors.text.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
    lineHeight: typography.lineHeight.label,
  },
  inputContainer: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.strong,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 52,
  },
  inputContainerError: { borderColor: colors.semantic.danger },
  input: {
    color: colors.text.primary,
    flex: 1,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  visibilityButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  visibilityLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.semibold,
  },
  error: {
    color: colors.semantic.danger,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
  },
});
