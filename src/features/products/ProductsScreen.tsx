import { EmptyState } from '@/src/components/ui/EmptyState';
import { Screen } from '@/src/components/ui/Screen';
import { ScreenHeader } from '@/src/components/ui/ScreenHeader';

export function ProductsScreen() {
  return (
    <Screen>
      <ScreenHeader
        title="My Products"
        description="Products you confirm will appear here with their identifying details and monitoring status."
      />
      <EmptyState
        description="Scan your first product to begin building a personal safety inventory."
        icon={{ ios: 'shippingbox.fill', android: 'inventory_2' }}
        title="No products yet"
      />
    </Screen>
  );
}
