import { useLocalSearchParams } from 'expo-router';

import { EditProductScreen } from '@/src/features/products/ProductScreens';

export default function EditProductRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <EditProductScreen id={id} />;
}
