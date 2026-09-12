import { useLocalSearchParams } from 'expo-router';

import { NewProductScreen } from '@/src/features/products/ProductScreens';
import {
  productCreationPrefillFromParams,
  type ProductCreationParams,
} from '@/src/features/products/productFormUtils';

export default function NewProductRoute() {
  const params = useLocalSearchParams<ProductCreationParams>();
  const prefill = productCreationPrefillFromParams(params);

  return (
    <NewProductScreen
      identificationMethod={prefill.identificationMethod}
      initialValues={prefill.values}
    />
  );
}
