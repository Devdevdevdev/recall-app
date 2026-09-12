import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Link } from 'expo-router';

import { useAuth } from '@/src/providers/AuthProvider';
import { colors, spacing, typography } from '@/src/design/tokens';

import { AuthButton } from '../components/AuthButton';
import { AuthScreenFrame } from '../components/AuthScreenFrame';
import { AuthTextField } from '../components/AuthTextField';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const trimmedEmail = email.trim();
  const isEmailValid = emailPattern.test(trimmedEmail);
  const canSubmit = isEmailValid && password.length > 0;

  async function handleSignIn() {
    if (isSubmitting) {
      return;
    }

    if (!isEmailValid) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const result = await signIn(trimmedEmail, password);
      if (result.status === 'error') {
        setError(result.message);
      }
    } catch {
      setError('Unable to sign in. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthScreenFrame
      description="Sign in to keep your product safety information private and protected."
      title="Welcome back">
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
          autoComplete="current-password"
          label="Password"
          onChangeText={(value) => {
            setPassword(value);
            setError(null);
          }}
          secureTextEntry
          value={password}
        />
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.formError}>
            {error}
          </Text>
        ) : null}
        <AuthButton
          disabled={!canSubmit}
          label="Sign in"
          loading={isSubmitting}
          onPress={() => void handleSignIn()}
        />
      </View>
      <View style={styles.footer}>
        <Text style={styles.footerText}>New to Recall?</Text>
        <Link accessibilityRole="link" href="./sign-up" style={styles.link}>
          Create an account
        </Link>
      </View>
    </AuthScreenFrame>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md, marginTop: spacing.xl },
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
});
