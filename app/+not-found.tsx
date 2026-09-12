import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/src/components/ui/Screen';
import { colors, spacing, typography } from '@/src/design/tokens';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen contentContainerStyle={styles.container}>
        <View style={styles.message}>
          <Text style={styles.eyebrow}>RECALL</Text>
          <Text style={styles.title}>This screen does not exist.</Text>
          <Text style={styles.body}>Return home to keep checking the products that matter.</Text>
        </View>
        <Link href="/" style={styles.link}>
          Go to Home
        </Link>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  message: {
    gap: spacing.sm,
  },
  eyebrow: {
    color: colors.brand.primary,
    fontSize: typography.size.caption,
    fontWeight: typography.weight.bold,
    letterSpacing: 1.6,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.title,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.title,
  },
  body: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  link: {
    color: colors.brand.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.semibold,
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
  },
});
