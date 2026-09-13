import { validateGtin, type OwnedProduct, type OwnedProductInput } from '@/src/domain';

import { isFuturePurchaseDate, isValidDateOnly, purchaseDateOrNull } from './purchaseDate';

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

export type ProductCreationMethod = 'barcode_scan' | 'ocr_assisted';

export type ProductCreationParams = {
  gtin?: string | string[];
  lotNumber?: string | string[];
  modelNumber?: string | string[];
  serialNumber?: string | string[];
  source?: string | string[];
};

export type ProductCreationPrefill = {
  identificationMethod: ProductCreationMethod | null;
  values: ProductFormValues;
};

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

function validatedIdentifierParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    return '';
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= maximumLengths.modelNumber ? normalized : '';
}

/** Revalidates all untrusted product-creation route parameters before they reach ProductForm. */
export function productCreationPrefillFromParams(
  params: ProductCreationParams,
): ProductCreationPrefill {
  const source = typeof params.source === 'string' ? params.source : null;

  if (source === 'barcode_scan' && typeof params.gtin === 'string') {
    const gtin = validateGtin(params.gtin);
    if (gtin.isValid && gtin.normalizedValue) {
      return {
        identificationMethod: 'barcode_scan',
        values: { ...emptyProductFormValues, gtin: gtin.normalizedValue },
      };
    }
  }

  if (source === 'ocr_assisted') {
    const values = {
      ...emptyProductFormValues,
      lotNumber: validatedIdentifierParam(params.lotNumber),
      modelNumber: validatedIdentifierParam(params.modelNumber),
      serialNumber: validatedIdentifierParam(params.serialNumber),
    };
    const hasIdentifier = Boolean(values.lotNumber || values.modelNumber || values.serialNumber);

    return {
      identificationMethod: hasIdentifier ? 'ocr_assisted' : null,
      values,
    };
  }

  return { identificationMethod: null, values: emptyProductFormValues };
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

  const purchaseDate = purchaseDateOrNull(values.purchaseDate);
  if (purchaseDate && !isValidDateOnly(purchaseDate)) {
    errors.purchaseDate = 'Use a real date in YYYY-MM-DD format.';
  } else if (purchaseDate && isFuturePurchaseDate(purchaseDate)) {
    errors.purchaseDate = 'Purchase date cannot be in the future.';
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
