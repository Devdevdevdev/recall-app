import { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  COUNTRY_CATALOG,
  getCountryName,
  searchCountries,
  type CountryCode,
} from '@/src/domain/countries';
import { colors, radius, spacing, typography } from '@/src/design/tokens';

type CountrySelectorProps = {
  label: string;
  onChange: (value: CountryCode | '') => void;
  value: CountryCode | '';
};

type CountryOption = (typeof COUNTRY_CATALOG)[number] | { code: ''; name: 'Not specified' };

const unspecifiedOption = { code: '', name: 'Not specified' } as const;

export function CountrySelector({ label, onChange, value }: CountrySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<TextInput>(null);
  const options = useMemo<readonly CountryOption[]>(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('en');
    if (!normalizedQuery) return [unspecifiedOption, ...COUNTRY_CATALOG];

    const countries = searchCountries(query);
    return unspecifiedOption.name.toLocaleLowerCase('en').includes(normalizedQuery)
      ? [unspecifiedOption, ...countries]
      : countries;
  }, [query]);

  function close() {
    setIsOpen(false);
    setQuery('');
  }

  function select(code: CountryCode | '') {
    onChange(code);
    close();
  }

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityHint="Opens a searchable list of countries"
        accessibilityLabel={`${label}, ${getCountryName(value || null)}`}
        accessibilityRole="button"
        onPress={() => setIsOpen(true)}
        style={({ pressed }) => [styles.trigger, pressed && styles.pressed]}>
        <Text style={[styles.triggerText, !value && styles.placeholder]}>
          {getCountryName(value || null)}
        </Text>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.chevron}>
          ▾
        </Text>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={close}
        onShow={() => searchInputRef.current?.focus()}
        presentationStyle="pageSheet"
        visible={isOpen}>
        <SafeAreaView accessibilityViewIsModal style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitleBlock}>
              <Text accessibilityRole="header" style={styles.modalTitle}>
                {label}
              </Text>
              <Text style={styles.modalDescription}>Search by English country name.</Text>
            </View>
            <Pressable
              accessibilityLabel="Close country selector"
              accessibilityRole="button"
              onPress={close}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
              <Text style={styles.closeLabel}>Close</Text>
            </Pressable>
          </View>

          <TextInput
            ref={searchInputRef}
            accessibilityLabel="Search countries"
            autoCapitalize="words"
            autoCorrect={false}
            clearButtonMode="while-editing"
            onChangeText={setQuery}
            placeholder="Search countries"
            placeholderTextColor={colors.text.muted}
            returnKeyType="search"
            style={styles.searchInput}
            value={query}
          />

          <FlatList
            data={options}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) => item.code || 'not-specified'}
            ListEmptyComponent={
              <Text accessibilityLiveRegion="polite" style={styles.emptyText}>
                No countries match that search.
              </Text>
            }
            renderItem={({ item }) => {
              const selected = item.code === value;
              return (
                <Pressable
                  accessibilityLabel={item.name}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => select(item.code)}
                  style={({ pressed }) => [
                    styles.option,
                    selected && styles.optionSelected,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={styles.optionName}>{item.name}</Text>
                  {selected ? (
                    <Text accessibilityElementsHidden style={styles.checkmark}>
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
            style={styles.list}
          />
        </SafeAreaView>
      </Modal>
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
  trigger: {
    alignItems: 'center',
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.strong,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  triggerText: {
    color: colors.text.primary,
    flex: 1,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  placeholder: { color: colors.text.muted },
  chevron: { color: colors.text.secondary, fontSize: 18 },
  pressed: { opacity: 0.7 },
  modalSafeArea: { backgroundColor: colors.surface.background, flex: 1 },
  modalHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  modalTitleBlock: { flex: 1, gap: spacing.xxs },
  modalTitle: {
    color: colors.text.primary,
    fontSize: typography.size.subtitle,
    fontWeight: typography.weight.bold,
    lineHeight: typography.lineHeight.subtitle,
  },
  modalDescription: {
    color: colors.text.secondary,
    fontSize: typography.size.label,
    lineHeight: typography.lineHeight.label,
  },
  closeButton: { justifyContent: 'center', minHeight: 44, paddingHorizontal: spacing.xs },
  closeLabel: {
    color: colors.brand.primary,
    fontSize: typography.size.label,
    fontWeight: typography.weight.bold,
  },
  searchInput: {
    backgroundColor: colors.surface.raised,
    borderColor: colors.border.strong,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text.primary,
    fontSize: typography.size.body,
    margin: spacing.lg,
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  list: { flex: 1, paddingHorizontal: spacing.lg },
  option: {
    alignItems: 'center',
    borderBottomColor: colors.border.subtle,
    borderBottomWidth: 1,
    flexDirection: 'row',
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  optionSelected: { backgroundColor: colors.brand.soft },
  optionName: {
    color: colors.text.primary,
    flex: 1,
    fontSize: typography.size.body,
    lineHeight: typography.lineHeight.body,
  },
  checkmark: {
    color: colors.brand.primary,
    fontSize: typography.size.body,
    fontWeight: typography.weight.bold,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
});
