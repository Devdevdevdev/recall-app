import { useLocalSearchParams } from 'expo-router';

import { ProductDetailScreen } from '@/src/features/products/ProductScreens';

export default function ProductDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ProductDetailScreen id={id} />;
}
