# F-4 — v1 confirme sur des scopes recall-level sans conditions structurées

**Statut :** ouvert. **Non corrigé.** Il bloque la mise en production de Phase 17.7a-1
(voir `docs/phase-17-7a-1-release-gate.json`).
**Découvert :** Phase 17.7a-R1, le 2026-10-02.
**Gravité :** élevée pour les fausses alertes, même si l'exposition réalisée est nulle (production : 0 produit).

## Constat

Le pipeline de production recall → produits (`phase_10_guarded_v1`, `deterministic_v1`) confirme
une correspondance sur un GTIN exact, même quand l'avis officiel impose d'autres conditions
obligatoires que la structure ne porte pas. Il ignore aussi la juridiction d'achat.

- **Lot.** `evaluateRange` (`_shared/matching/evidence.ts`) ne produit aucun item quand le
  produit n'a pas de lot. Un GTIN exact confirme alors.
- **Fenêtre de fabrication.** `manufactured_from/to` n'est jamais comparé.
- **Juridiction.** `purchase_country_code` est hors projection et hors fingerprint v1.
- **Production (avis CPSC 8877, Thule).** 13 scopes contiennent un GTIN seul, alors que l'avis
  impose une fenêtre de fabrication (mai 2018 à septembre 2019) et l'absence de l'autocollant
  QC2020. Un produit Thule avec l'un de ces GTIN serait `confirmed` et recevrait une alerte et un
  push, y compris pour un produit fabriqué en 2017 ou acheté au Canada.

## Reproduction

`tests/phase-17-7a-safe-confirmation.test.mjs` épingle ce comportement :

- cas D1-B, D1-E et D1-F ;
- test « production notice 8877 shape » ;
- cas D2.

## Pourquoi c'est bloquant pour 17.7a-1

Le chemin produit de 17.7a-1 est sûr par construction : porte de complétude et de juridiction,
v2, aucun fallback v1. Activer en production des utilisateurs qui enregistrent des produits rend
cependant le défaut v1 **atteignable** : dès que l'avis 8877 sera réaffecté par une révision
source, le pipeline recall → produits v1 confirmera ces produits sur leur GTIN seul.

## Pistes (décision séparée, non mêlée à 17.7a-1)

1. **Neutraliser.** Au minimum, exclure de la confirmation automatique v1 les scopes
   recall-level (`additional_criteria.evidence_level = 'recall'`) et les avis dont la
   juridiction structurée est incompatible. Cela exige une politique versionnée et un nouveau
   fingerprint.
2. **Remplacer.** Faire passer le pipeline recall → produits par la même porte et par v2. Cela
   revient à une activation contrôlée de v2.
3. **Neutraliser explicitement, sans changement de code.** Tant que `product_check_enabled` reste
   `false` et que l'app ne propose pas l'ajout de produits en production, aucune paire n'est
   exposée. C'est fragile et cela doit faire l'objet d'une décision écrite.

Le blocage ne sera levé que lorsque `docs/phase-17-7a-1-release-gate.json` indiquera F-4 en
`resolved` ou en `neutralized`, avec la référence de la décision.
