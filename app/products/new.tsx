import { useLocalSearchParams } from 'expo-router';

import { NewProductScreen } from '@/src/features/products/ProductScreens';
import { type ProductCreationParams } from '@/src/features/products/productFormUtils';

export default function NewProductRoute() {
  const params = useLocalSearchParams<ProductCreationParams>();
  return <NewProductScreen creationParams={params} />;
}
