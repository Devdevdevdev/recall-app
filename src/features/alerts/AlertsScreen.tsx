import { EmptyState } from '@/src/components/ui/EmptyState';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';

export function AlertsScreen() {
  return (
    <Screen>
      <ScreenHeader
        title="Alerts"
        description="Verified matches will explain the affected product, risk, official source, and recommended action."
      />
      <EmptyState
        description="There are no recall alerts. Monitoring begins after you add a product."
        icon={{ ios: 'checkmark.shield.fill', android: 'verified_user' }}
        title="All clear"
      />
    </Screen>
  );
}
