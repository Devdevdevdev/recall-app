import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '@/src/providers/AuthProvider';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

import { AuthButton } from '../components/AuthButton';
import { AuthScreenFrame } from '../components/AuthScreenFrame';
import { AuthTextField } from '../components/AuthTextField';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const minimumPasswordLength = 8;

export function SignUpScreen() {
  const { signUp } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [awaitingEmailConfirmation, setAwaitingEmailConfirmation] = useState(false);
  const trimmedEmail = email.trim();
  const isEmailValid = emailPattern.test(trimmedEmail);
  const canSubmit =
    isEmailValid && password.length >= minimumPasswordLength && password === confirmPassword;

  async function handleSignUp() {
    if (isSubmitting) {
      return;
    }

    if (!isEmailValid) {
      setError('Please enter a valid email address.');
      return;
    }

    if (password.length < minimumPasswordLength) {
      setError('Choose a password with at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const result = await signUp(trimmedEmail, password);
      if (result.status === 'error') {
        setError(result.message);
      } else if (result.requiresEmailConfirmation) {
        setAwaitingEmailConfirmation(true);
      }
    } catch {
      setError('Unable to create your account. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (awaitingEmailConfirmation) {
    return (
      <AuthScreenFrame
        description="Confirm your email address, then return here to sign in and start using Recall."
        title="Check your email">
        <View style={styles.confirmationCard}>
          <Text style={styles.confirmationTitle}>Your account is ready to confirm</Text>
          <Text style={styles.confirmationCopy}>
            We’ve received your request. Follow the confirmation link sent to your email address.
          </Text>
          <Link accessibilityRole="link" href="../sign-in" style={styles.confirmationLink}>
            Back to sign in
          </Link>
        </View>
      </AuthScreenFrame>
    );
  }

  return (
    <AuthScreenFrame
      description="Create a private account to keep your product safety information in one place."
      title="Create your account">
      <View style={styles.form}>
        <AuthTextField
          autoComplete="email"
          label="Email"
          onChangeText={(value) => {
            setEmail(value);
            setError(null);
          }}
          value={email}
        />
        <AuthTextField
          autoComplete="new-password"
          label="Password"
          onChangeText={(value) => {
            setPassword(value);
            setError(null);
          }}
          secureTextEntry
          value={password}
        />
        <AuthTextField
          autoComplete="new-password"
          label="Confirm password"
          onChangeText={(value) => {
            setConfirmPassword(value);
            setError(null);
          }}
          secureTextEntry
          value={confirmPassword}
        />
        <Text style={styles.passwordHelp}>Use at least 8 characters.</Text>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.formError}>
            {error}
          </Text>
        ) : null}
        <AuthButton
          disabled={!canSubmit}
          label="Create account"
          loading={isSubmitting}
          onPress={() => void handleSignUp()}
        />
      </View>
      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account?</Text>
        <Link accessibilityRole="link" href="../sign-in" style={styles.link}>
          Sign in
        </Link>
      </View>
    </AuthScreenFrame>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md, marginTop: spacing.xl },
  passwordHelp: {
    color: colors.text.muted,
    fontSize: typography.size.caption,
    lineHeight: typography.lineHeight.caption,
    marginTop: -spacing.xs,
  },
  formError: {
    color: colors.semantic.danger,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  footer: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  footerText: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  link: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.label,
  },
  confirmationCard: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.subtle,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    marginTop: spacing.xl,
    padding: spacing.lg,
  },
  confirmationTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  confirmationCopy: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  confirmationLink: {
    color: colors.brand.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.body,
  },
});
