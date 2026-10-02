import { validateGtin } from '../../domain/barcode.ts';
import { isSupportedCountryCode } from '../../domain/countries.ts';
import type {
  OwnedProduct,
  OwnedProductInput,
  ProductSafetyAttributes,
} from '../../domain/types.ts';

import {
  isFuturePurchaseDate,
  isValidDateOnly,
  purchaseDateOrNull,
  todayDateOnly,
} from './purchaseDate.ts';

export type ProductFormValues = {
  brand: string;
  category: string;
  gtin: string;
  lotNumber: string;
  modelNumber: string;
  productName: string;
  purchaseCountryCode: string;
  purchaseDate: string;
  scanDate: string;
  serialNumber: string;
  variant: string;
  color: string;
  size: string;
  capacity: string;
  batteryModel: string;
  chargingPortType: string;
  screwState: string;
  dateCode: string;
  manufactureDate: string;
  productionDate: string;
};

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>;

export type ProductCreationMethod = 'barcode_scan' | 'ocr_assisted';

export type ProductCreationParams = {
  gtin?: string | string[];
  lotNumber?: string | string[];
  modelNumber?: string | string[];
  serialNumber?: string | string[];
  variant?: string | string[];
  color?: string | string[];
  size?: string | string[];
  capacity?: string | string[];
  batteryModel?: string | string[];
  chargingPortType?: string | string[];
  screwState?: string | string[];
  dateCode?: string | string[];
  manufactureDate?: string | string[];
  productionDate?: string | string[];
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
  purchaseCountryCode: 2,
  purchaseDate: 10,
  scanDate: 10,
  variant: 120,
  color: 120,
  size: 120,
  capacity: 120,
  batteryModel: 120,
  chargingPortType: 120,
  screwState: 120,
  dateCode: 120,
  manufactureDate: 10,
  productionDate: 10,
};

export function emptyProductFormValues(now = new Date()): ProductFormValues {
  return {
    productName: '',
    brand: '',
    category: '',
    gtin: '',
    modelNumber: '',
    serialNumber: '',
    lotNumber: '',
    scanDate: todayDateOnly(now),
    purchaseCountryCode: '',
    purchaseDate: '',
    variant: '',
    color: '',
    size: '',
    capacity: '',
    batteryModel: '',
    chargingPortType: '',
    screwState: '',
    dateCode: '',
    manufactureDate: '',
    productionDate: '',
  };
}

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
  defaultPurchaseCountryCode?: string | null,
): ProductCreationPrefill {
  const source = typeof params.source === 'string' ? params.source : null;
  const purchaseCountryCode = isSupportedCountryCode(defaultPurchaseCountryCode)
    ? defaultPurchaseCountryCode
    : '';
  const baseValues = { ...emptyProductFormValues(), purchaseCountryCode };

  if (source === 'barcode_scan' && typeof params.gtin === 'string') {
    const gtin = validateGtin(params.gtin);
    if (gtin.isValid && gtin.normalizedValue) {
      return {
        identificationMethod: 'barcode_scan',
        values: { ...baseValues, gtin: gtin.normalizedValue },
      };
    }
  }

  if (source === 'ocr_assisted') {
    const values = {
      ...baseValues,
      lotNumber: validatedIdentifierParam(params.lotNumber),
      modelNumber: validatedIdentifierParam(params.modelNumber),
      serialNumber: validatedIdentifierParam(params.serialNumber),
      variant: validatedIdentifierParam(params.variant),
      color: validatedIdentifierParam(params.color),
      size: validatedIdentifierParam(params.size),
      capacity: validatedIdentifierParam(params.capacity),
      batteryModel: validatedIdentifierParam(params.batteryModel),
      chargingPortType: validatedIdentifierParam(params.chargingPortType),
      screwState: validatedIdentifierParam(params.screwState),
      dateCode: validatedIdentifierParam(params.dateCode),
      manufactureDate: validatedIdentifierParam(params.manufactureDate),
      productionDate: validatedIdentifierParam(params.productionDate),
    };
    const hasIdentifier = Boolean(values.lotNumber || values.modelNumber || values.serialNumber);

    return {
      identificationMethod: hasIdentifier ? 'ocr_assisted' : null,
      values,
    };
  }

  return { identificationMethod: null, values: baseValues };
}

export function mergeOptionalDefaultCountry(
  values: ProductFormValues,
  defaultPurchaseCountryCode: string | null,
  countryWasEdited: boolean,
): ProductFormValues {
  if (
    countryWasEdited ||
    values.purchaseCountryCode ||
    !isSupportedCountryCode(defaultPurchaseCountryCode)
  ) {
    return values;
  }

  return { ...values, purchaseCountryCode: defaultPurchaseCountryCode };
}

export function productFormValuesFromProduct(product: OwnedProduct): ProductFormValues {
  const safetyAttributes = product.safetyAttributes ?? {};
  return {
    productName: product.productName ?? '',
    brand: product.brand ?? '',
    category: product.category ?? '',
    gtin: product.gtin ?? '',
    modelNumber: product.modelNumber ?? '',
    serialNumber: product.serialNumber ?? '',
    lotNumber: product.lotNumber ?? '',
    scanDate: product.scanDate,
    purchaseCountryCode: product.purchaseCountryCode ?? '',
    purchaseDate: product.purchaseDate ?? '',
    variant: safetyAttributes.variant ?? '',
    color: safetyAttributes.color ?? '',
    size: safetyAttributes.size ?? '',
    capacity: safetyAttributes.capacity ?? '',
    batteryModel: safetyAttributes.battery_model ?? '',
    chargingPortType: safetyAttributes.charging_port_type ?? '',
    screwState: safetyAttributes.screw_state ?? '',
    dateCode: safetyAttributes.date_code ?? '',
    manufactureDate: safetyAttributes.manufacture_date ?? '',
    productionDate: safetyAttributes.production_date ?? '',
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

  const scanDate = values.scanDate.trim();
  if (!isValidDateOnly(scanDate)) {
    errors.scanDate = 'Use a real scan date in YYYY-MM-DD format.';
  } else if (isFuturePurchaseDate(scanDate)) {
    errors.scanDate = 'Scan date cannot be in the future.';
  }

  const purchaseCountryCode = nullableTrimmed(values.purchaseCountryCode);
  if (purchaseCountryCode !== null && !isSupportedCountryCode(purchaseCountryCode)) {
    errors.purchaseCountryCode = 'Choose a valid country.';
  }
  const validPurchaseCountryCode = isSupportedCountryCode(purchaseCountryCode)
    ? purchaseCountryCode
    : null;

  for (const field of ['manufactureDate', 'productionDate'] as const) {
    const value = nullableTrimmed(values[field]);
    if (value && !isValidDateOnly(value)) {
      errors[field] = 'Use a real date in YYYY-MM-DD format.';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors, input: null };
  }

  const safetyAttributes: ProductSafetyAttributes = {};
  const safetyValues = {
    variant: values.variant,
    color: values.color,
    size: values.size,
    capacity: values.capacity,
    battery_model: values.batteryModel,
    charging_port_type: values.chargingPortType,
    screw_state: values.screwState,
    date_code: values.dateCode,
    manufacture_date: values.manufactureDate,
    production_date: values.productionDate,
  } as const;
  for (const [key, value] of Object.entries(safetyValues)) {
    const normalized = nullableTrimmed(value);
    if (normalized) safetyAttributes[key as keyof ProductSafetyAttributes] = normalized;
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
      scanDate,
      purchaseDate,
      purchaseCountryCode: validPurchaseCountryCode,
      ...(Object.keys(safetyAttributes).length ? { safetyAttributes } : {}),
    },
  };
}
