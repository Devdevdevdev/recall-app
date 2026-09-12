import { validateGtin, type OwnedProduct, type OwnedProductInput } from '@/src/domain';

export type ProductFormValues = {
  brand: string;
  category: string;
  gtin: string;
  lotNumber: string;
  modelNumber: string;
  productName: string;
  purchaseDate: string;
  serialNumber: string;
};

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>;

const maximumLengths: Record<keyof ProductFormValues, number> = {
  productName: 200,
  brand: 120,
  category: 120,
  gtin: 14,
  modelNumber: 120,
  serialNumber: 120,
  lotNumber: 120,
  purchaseDate: 10,
};

export const emptyProductFormValues: ProductFormValues = {
  productName: '',
  brand: '',
  category: '',
  gtin: '',
  modelNumber: '',
  serialNumber: '',
  lotNumber: '',
  purchaseDate: '',
};

function nullableTrimmed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function productFormValuesFromProduct(product: OwnedProduct): ProductFormValues {
  return {
    productName: product.productName ?? '',
    brand: product.brand ?? '',
    category: product.category ?? '',
    gtin: product.gtin ?? '',
    modelNumber: product.modelNumber ?? '',
    serialNumber: product.serialNumber ?? '',
    lotNumber: product.lotNumber ?? '',
    purchaseDate: product.purchaseDate ?? '',
  };
}

export function validateProductForm(values: ProductFormValues): {
  errors: ProductFormErrors;
  input: OwnedProductInput | null;
} {
  const errors: ProductFormErrors = {};

  for (const field of Object.keys(maximumLengths) as (keyof ProductFormValues)[]) {
    if (values[field].trim().length > maximumLengths[field]) {
      errors[field] = `Use ${maximumLengths[field]} characters or fewer.`;
    }
  }

  const productName = values.productName.trim();
  if (productName.length === 0) {
    errors.productName = 'Enter a product name.';
  }

  const rawGtin = nullableTrimmed(values.gtin);
  const gtinValidation = rawGtin ? validateGtin(rawGtin) : null;
  if (gtinValidation && !gtinValidation.isSyntaxValid) {
    errors.gtin = 'Use an 8, 12, 13, or 14 digit GTIN.';
  } else if (gtinValidation && !gtinValidation.isValid) {
    errors.gtin = 'This GTIN check digit is not valid.';
  }

  const purchaseDate = nullableTrimmed(values.purchaseDate);
  if (purchaseDate && !isValidDate(purchaseDate)) {
    errors.purchaseDate = 'Use a real date in YYYY-MM-DD format.';
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }

  return {
    errors,
    input: {
      productName,
      brand: nullableTrimmed(values.brand),
      category: nullableTrimmed(values.category),
      gtin: gtinValidation?.normalizedValue ?? null,
      modelNumber: nullableTrimmed(values.modelNumber),
      serialNumber: nullableTrimmed(values.serialNumber),
      lotNumber: nullableTrimmed(values.lotNumber),
      purchaseDate,
    },
  };
}
