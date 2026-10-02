import type { OwnedProductEvidenceV2 } from './typesV2.ts';
import type { OfficialRecallEvidenceV2_1 } from './typesV2_1.ts';

export function projectGuardedModelInputV2_1(input: {
  ownedProduct: OwnedProductEvidenceV2;
  officialRecall: OfficialRecallEvidenceV2_1;
}) {
  return {
    ownedProduct: {
      productName: input.ownedProduct.productName,
      brand: input.ownedProduct.brand,
      gtin: input.ownedProduct.gtin,
      modelNumber: input.ownedProduct.modelNumber,
      serialNumber: input.ownedProduct.serialNumber,
      lotNumber: input.ownedProduct.lotNumber,
      attributes: input.ownedProduct.attributes.map((attribute) => ({
        key: attribute.key,
        value: attribute.value,
        valueType: attribute.valueType,
        captureSource: attribute.captureSource,
      })),
    },
    officialRecall: {
      source: {
        authority: input.officialRecall.source.authority,
        externalId: input.officialRecall.source.externalId,
        officialUrl: input.officialRecall.source.officialUrl,
      },
      title: input.officialRecall.title,
      recallDate: input.officialRecall.recallDate,
      scopes: input.officialRecall.scopes.map((scope, scopeIndex) => ({
        scopeIndex,
        productName: scope.productName,
        brand: scope.brand ?? null,
        criteria: scope.criteria
          ? {
              semantics: scope.criteria.semantics,
              criteria: scope.criteria.criteria,
            }
          : null,
        associations: scope.associations ?? [],
      })),
    },
  };
}
