# F-4 — Confirmation automatique v1 non sûre

**Statut :** corrigé **localement**, revue en attente. Rien n'est commité, rien n'est installé en
production. Le correctif est décrit dans [phase-17-7a-f4-safety-fix.md](../phase-17-7a-f4-safety-fix.md).
F-4 reste le bloqueur de Phase 17.7a-1 dans `docs/phase-17-7a-1-release-gate.json`, avec le statut
`fixed_locally_pending_review`.

**Découvert :** Phase 17.7a-R1, le 2026-10-02.

**Gravité :** élevée pour les fausses alertes. Exposition réalisée nulle : la production compte 0
produit, 0 match et 0 alerte.

## Défaut

Le pipeline de production recall → produits (`phase_10_guarded_v1`) pouvait créer une alerte
automatique dès qu'une paire était `confirmed` par `deterministic_v1` ou par
`hybrid_guarded_v1` (Nemotron) :

- sur un GTIN seul, alors que l'avis officiel impose d'autres conditions ;
- quand le lot exigé manquait ;
- quand la date de fabrication manquait ;
- même quand la date était prouvée hors de la fenêtre ;
- sans tenir compte de `purchase_country_code`.

**Exemple réel :** l'avis CPSC 8877 (Thule). Ses 13 scopes GTIN sont recall-level, alors que
l'avis exige une fabrication entre mai 2018 et septembre 2019 et l'absence de l'autocollant
QC2020.

## Reproduction

- `tests/phase-17-7a-safe-confirmation.test.mjs` épingle les **décisions du matcher** v1, qui sont
  inchangées par le correctif : cas D1-B, D1-E, D1-F, forme de l'avis 8877, et D2.
- `supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql` montre qu'après le correctif ces
  décisions ne créent plus d'alerte. Toutes deviennent `needs_review`, avec une raison.

## Correctif local (résumé)

La frontière de sécurité est placée en base, au dernier point commun avant toute alerte
automatique.

- **Preuve recalculée en base.** `private.automatic_alert_eligibility(produit, avis)` dérive la
  preuve de sûreté des seules données serveur.
- **Rétrogradation par les deux finaliseurs.** Un `confirmed` non prouvé est enregistré en
  `needs_review`.
- **Gardes sur les écritures.** Des triggers sur `alerts`, `recall_alert_eligibility_v2` et
  `recall_alert_snapshots_v2` refusent toute écriture sans preuve.
- **Données historiques.** Une neutralisation à la main de l'opérateur est prévue pour les
  données antérieures à F-4. Elle n'est pas exécutée par la migration.

## Fermeture

F-4 ne pourra passer en `resolved` dans le release gate qu'après quatre étapes :

1. revue du correctif ;
2. commit ;
3. installation contrôlée en production (« GO » par étape) ;
4. vérification post-installation, avec inventaire de neutralisation en lecture seule.
