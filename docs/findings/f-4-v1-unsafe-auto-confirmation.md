# F-4 — Confirmation automatique v1 non sûre

**Statut :** **résolu**, fermé le 2026-10-03 après installation et vérification en production. La
preuve est dans
[releases/phase-17-7a-f4/post-install-verification.json](../../releases/phase-17-7a-f4/post-install-verification.json).
Le correctif est décrit dans [phase-17-7a-f4-safety-fix.md](../phase-17-7a-f4-safety-fix.md). Dans
`docs/phase-17-7a-1-release-gate.json`, F-4 a le statut `resolved`. Phase 17.7a-1 n'est **pas**
installée en production.

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

## Correctif (résumé)

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

Les quatre conditions de fermeture sont remplies :

1. **Revue et commit du correctif local** : commits `0f4b7b3`, `553173c` et `b71de49`. La
   migration a été renommée `20261002110000` pour passer avant 17.7a-1.
2. **Migration installée** en production : `20261002110000_phase_17_7a_f4_automatic_alert_safety.sql`
   (SHA-256 `622dc389…`). 33 migrations ; les 5 triggers de garde sont actifs.
3. **Edge déployée** : `process-recall-matches` v23 (`ezbr` `7370fe79…`), construite à partir des
   octets v22 avec seulement les 3 fichiers F-4 remplacés. Arbre runtime attendu `81ff731c…`.
4. **Vérification post-installation** :
   - suite distante 90/90, en une seule transaction annulée par ROLLBACK ; aucun reste de pgTAP,
     aucune session `idle in transaction`, aucun reste des fixtures ;
   - inventaire de neutralisation à **0** : aucune neutralisation n'a été nécessaire ;
   - run naturel du 2026-10-03 à 12:17 UTC sans régression : cron `succeeded`, automation HTTP 200,
     aucun 401 ni 500 dus à F-4, 0 alerte, 0 push et 0 éligibilité non sûrs.

**Limites, consignées telles quelles :**

- La v23 n'a pas encore traité de vraie paire : la production compte 0 produit et le run naturel ne
  l'a pas appelée (`firstRealCandidateInvocationObserved: false`). À surveiller au premier appel
  réel.
- La source CPSC renvoie des HTTP 502 : le run finit en `partial_success` avec
  `source_partial_failure`. C'est un incident de source préexistant, déjà présent au run de
  06:17 UTC, avant le déploiement Edge F-4. Ce n'est pas un échec de F-4.

**Date de fermeture :** 2026-10-03.
