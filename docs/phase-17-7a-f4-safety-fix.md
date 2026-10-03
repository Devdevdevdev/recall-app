# Phase 17.7a — F-4 : éligibilité sûre aux alertes automatiques (correctif local)

**Statut :** implémenté et vérifié **localement**. Revue en attente.

**Ce qui n'a pas été fait :** pas de commit, pas de push, pas de deploy, aucune écriture en
production.

**Accès production :** une seule lecture, en `SELECT` seul via MCP, pour mesurer l'effet attendu
(§7).

**Contexte :** base `75dbc56` (17.7a-1 commitée localement). Défaut décrit dans
[findings/f-4-v1-unsafe-auto-confirmation.md](findings/f-4-v1-unsafe-auto-confirmation.md).

**Principe retenu :**

```text
CANDIDATE  /  V1 CONFIRMED  /  AI CONFIRMED   ≠   AUTOMATIC ALERT ELIGIBLE
```

Une alerte automatique exige une preuve dérivée **par la base**, à partir des seules données
serveur, que la portée officielle est complète pour ce produit.

## 1. Audit du chemin exact de l'alerte

### v1 (production, `phase_10_guarded_v1`)

| Étape                          | Code                                                                                                                                                                    | Données                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Liste des avis                 | `processRecallMatches` → `store.listAuthoritativeRecalls` → RPC `get_recall_matching_batch`                                                                             | `recall_notices`, `recall_scopes` (sources `is_authoritative`)              |
| Candidats                      | `store.listRecallCandidateProducts` → RPC `get_recall_candidates`, puis garde TS `retrieveRecallCandidates`                                                             | `owned_products`                                                            |
| Fingerprint                    | `buildEvidenceFingerprint` : produit projeté, avis et scopes, hash du payload, versions de politique et `modelId`. Pays d'achat et révisions **absents**                | —                                                                           |
| Claim                          | RPC `claim_recall_match_evaluation` → `unchanged` / `busy` / `stale` / `missing` / `claimed`                                                                            | `private.recall_matching_leases`, `recall_matches.evidence_fingerprint`     |
| Décision                       | `evaluateDeterministicMatch` ; si `needs_review` et s'il reste du budget, `evaluateHybridGuardedMatch` (Nemotron)                                                       | —                                                                           |
| Finalisation                   | RPC `finalize_recall_match_evaluation` : bail, révisions sous `FOR SHARE`, upsert de `recall_matches`, puis `insert into public.alerts` **si `p_status = 'confirmed'`** | `recall_matches` (UNIQUE produit+avis), `alerts` (UNIQUE `recall_match_id`) |
| Effets de l'insertion d'alerte | triggers `alerts_ensure_owner` (propriétaire et source), `alerts_enqueue_confirmed_push` (file push si le match est confirmé), `alerts_capture_legacy_snapshot_v2`      | `private.push_alert_queue`, `private.recall_legacy_alert_snapshots_v2`      |

**Récupération en v1.** Il n'y en a **aucune** sur `unchanged` : le claim saute la paire.
L'unicité de l'alerte vient de `alerts_recall_match_id_key` et du chemin « existing » de
finalize.

### v2 (inactif globalement, utilisé par 17.7a-1 et par la cohorte v2)

| Étape        | Code                                                                                                       | Données                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Finalisation | RPC `finalize_recall_match_evaluation_v2` (wrapper), puis `…_phase163` (cœur)                              | `private.recall_match_evaluations_v2` (append-only), `private.recall_alert_eligibility_v2` |
| Alerte       | RPC `create_recall_v2_alert`, à partir de l'éligibilité                                                    | `private.recall_alert_snapshots_v2`                                                        |
| Récupération | **oui** : sur `unchanged` + `confirmed`, l'orchestrateur v2 et 17.7a-1 rappellent `create_recall_v2_alert` | —                                                                                          |

**Dernier point commun avant toute alerte automatique.** Il y a trois écritures :
`public.alerts` (v1), `private.recall_alert_eligibility_v2` et `private.recall_alert_snapshots_v2`
(v2). Aucune autre écriture d'alerte n'existe dans les migrations ; vérifié par une recherche
dans le dépôt.

## 2. Frontière de sécurité choisie

| Option                                                 | Évaluation                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Garde dans `legacyRun.ts` seulement                 | **Rejetée.** Une ancienne Edge Function, la cohorte v2, un appel direct à la RPC ou un orchestrateur futur la contournent.                                                                                             |
| B. Garde en base (finalisation et éligibilité)         | Nécessaire. Seule, elle exigerait de faire confiance à la décision transmise.                                                                                                                                          |
| **C. Combinaison, avec une preuve recalculée en base** | **Retenue.** L'orchestrateur ne transmet **aucun** drapeau de sûreté : la base dérive la preuve. Les finaliseurs rétrogradent, et des triggers refusent toute écriture d'alerte non prouvée, quel que soit l'appelant. |

**Preuve : `private.automatic_alert_eligibility(product, notice)`.** La fonction renvoie
`eligible` ou la raison du refus. Elle exige :

1. **source officielle** (`is_authoritative`) ;
2. **juridiction structurée compatible** (`recall_notice_jurisdictions` contre
   `purchase_country_code`) :
   - un pays inconnu n'est couvert que par `GLOBAL` ;
   - une région sans table d'appartenance mène à une revue ;
   - la règle est identique à la porte TS de 17.7a-1 (parité testée) ;
3. **chaque scope servi par l'enveloppe construite en base**
   (`private.cpsc_scope_rule_set_envelope`), qui garantit ledger humain, révision courante et
   liaison à la source officielle ;
4. **couverture complète** : `coverage.complete`, `sourceCoverage` `recorded`, `complete`,
   `independent`, `negativeEvidenceEligible` ; `unattributed = 0` ;
   `served = proposed = nombre de règles` ;
5. **règles `all_of`** d'origine `human_review_ledger` ;
6. **types supportés uniquement** : `model_number` et `date_code` avec `equals` ou `one_of`, sans
   élargissement de l'allowlist ;
7. **au moins une règle entièrement satisfaite** par le produit (`model_number`,
   `safety_attributes.date_code`).

**Révisions.** La preuve est évaluée dans la transaction de finalisation, après le verrou
`FOR SHARE` du produit et de l'avis et après le contrôle des révisions attendues. Les triggers la
réévaluent au moment exact de l'écriture.

**Normalisation SQL.** Elle reproduit `normalizeIdentifier` (NFKC, trim, espaces, majuscules),
mais seulement pour des valeurs ASCII imprimables après NFKC. Toute autre valeur ne correspond
jamais. La correspondance SQL est donc **un sous-ensemble** de la correspondance TS : elle peut
retenir une alerte, jamais l'élargir. Un test vérifie ce sous-ensemble.

## 3. Politique implémentée

| Décision du matcher                        | Preuve       | Enregistré                                                                            | Alerte ou éligibilité                       |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `deterministic_v1` `confirmed`             | absente      | `needs_review`, raison `Automatic alert withheld (<raison>)…`, identifiants conservés | **aucune**                                  |
| `hybrid_guarded_v1` (Nemotron) `confirmed` | absente      | `needs_review` (idem)                                                                 | **aucune**                                  |
| `deterministic_v2` `confirmed`             | absente      | `needs_review`, `confidence = 0`, raison                                              | **aucune** éligibilité                      |
| n'importe lequel `confirmed`               | **présente** | `confirmed`                                                                           | alerte (v1) ou éligibilité puis alerte (v2) |
| `rejected` / `needs_review`                | —            | inchangé                                                                              | aucune                                      |

- **Le candidat reste observable :** il apparaît comme `needs_review`, avec ses identifiants
  appariés et la raison du refus.
- **Inchangés :** les décisions du matcher, le fingerprint v1, `RECALL_MATCHING_POLICY`,
  l'allowlist v2 et le comportement IA (F-1 non traité).

**Changements TS minimaux :**

- `finalize_recall_match_evaluation` renvoie deux colonnes ajoutées en fin de résultat :
  `stored_status` et `safety_status`. Les lecteurs existants restent compatibles.
- `store.ts` les lit, et tolère leur absence sur une base pré-F-4.
- `orchestrator.ts` compte le statut **enregistré**, avec un nouveau compteur `safetyWithheld`.
- `legacyRun.ts` expose `safetyWithheld`.
- La cohérence des compteurs de l'automation 16.33 n'est pas affectée (vérifié).

## 4. Implémentation

**Migration locale additive :**
`supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql`.

- **Fonctions privées**, inaccessibles à anon, authenticated et service_role :
  `automatic_alert_identifier`, `automatic_alert_jurisdiction` et `automatic_alert_eligibility`.
- **Triggers :**
  - `alerts_require_safe_scope` (avant `INSERT` ou `UPDATE OF recall_match_id`) : le match doit
    être `confirmed` **et** la preuve doit tenir ;
  - `recall_alert_eligibility_v2_require_safe_scope` : à l'insertion, au réarmement d'une
    éligibilité révoquée et au changement d'évaluation ;
  - `recall_alert_snapshots_v2_require_safe_scope`.
- **`finalize_recall_match_evaluation` (v1) :** supprimé puis recréé avec la même signature et
  les mêmes droits (service_role seul). Il gagne la rétrogradation et deux colonnes de résultat.
- **`finalize_recall_match_evaluation_v2` (wrapper) :** même signature et même résultat, plus la
  rétrogradation avant le cœur 16.3.
- **`create_recall_v2_alert` :** renvoie `ineligible` si la preuve ne tient plus.
- **`private.neutralize_unsafe_automatic_alerts(p_apply boolean)` :** réservée à l'opérateur et
  **non exécutée** par la migration (§5).

## 5. Compatibilité historique

| Question                                                         | Réponse                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Une ancienne évaluation v1 `confirmed` reste-t-elle stockée ?    | Oui, tant qu'elle n'est ni réévaluée ni neutralisée. F-4 ne réécrit rien automatiquement.                                                                                                                                                              |
| Une alerte existante doit-elle être supprimée ?                  | **Non.** Une alerte est un historique déjà vu par l'utilisateur. Elle est conservée, et les read models affichent « no longer confirmed » dès que le match ou l'évaluation n'est plus `confirmed`.                                                     |
| Peut-elle être recréée par `unchanged` ?                         | **v1 :** non, `unchanged` saute la paire sans chemin d'alerte (testé). **v2 :** le chemin de récupération existe, mais `create_recall_v2_alert` renvoie désormais `ineligible` sans preuve, et le trigger sur les snapshots refuse l'écriture (testé). |
| Le code contient-il une récupération sur duplicate/unchanged ?   | Oui en v2 (orchestrateur v2 et 17.7a-1) ; non en v1.                                                                                                                                                                                                   |
| F-4 doit-il empêcher cette récupération ?                        | Oui, et c'est fait en base, pas dans l'orchestrateur.                                                                                                                                                                                                  |
| Une ancienne éligibilité incorrecte doit-elle être neutralisée ? | Oui, par la routine opérateur, avec un inventaire préalable.                                                                                                                                                                                           |

**Neutralisation** (testée localement, non exécutée) :

- `neutralize_unsafe_automatic_alerts(false)` est un inventaire en lecture seule : type, produit,
  avis, raison et présence d'une alerte.
- `neutralize_unsafe_automatic_alerts(true)` agit ainsi :
  - **v1 :** le match `confirmed` passe en `needs_review` (raison « F-4 neutralization »), et son
    fingerprint est effacé pour forcer une réévaluation sous le finaliseur F-4 ;
  - **v2 :** une évaluation `needs_review` append-only est enregistrée, et l'éligibilité active
    est révoquée par elle ;
  - **aucune alerte supprimée** ; idempotent.

**Stratégie de migration (production, plus tard, « GO » par étape) :**

1. Installer la migration F-4.
2. Déployer `process-recall-matches`, avec `store.ts` et l'orchestrateur F-4.
3. Exécuter l'inventaire en lecture seule. Au 2026-10-02 : 0 match confirmé, 0 alerte, 0
   éligibilité active, 0 snapshot v2, donc rien à neutraliser.
4. N'appliquer la neutralisation que si l'inventaire n'est pas vide, sur décision explicite.

**Ordre de déploiement :**

- **Migration avant la fonction :** l'ancienne fonction lit seulement les anciennes colonnes, et
  la base protège déjà.
- **Fonction avant la migration :** `store.ts` tolère l'absence des colonnes.

## 6. Tests de non-régression

Les tests sont dans `supabase/tests/phase-17-7a-f4-automatic-alert-safety.sql` (pgTAP, **91**),
`tests/phase-17-7a-f4-safety.test.mjs` (Node, **6**) et `tests/phase-17-7a-f4-store.test.ts`
(Deno, **3**).

**Le cas positif utilise le vrai chemin Phase 16, sans aucun stub :**

- proposition par le worker ;
- revue humaine avec session MFA aal2 ;
- matérialisation du conjonctif revu ;
- ledger de couverture complet ;
- attestation des sections hors recensement ;
- enveloppe finale `coverage.complete = true`.

| #   | Exigence                                                 | Résultat                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | portée complète sûre → confirmation automatique possible | **eligible**, alerte v1 créée et mise en file push une fois ; v2 : éligibilité puis alerte. La portée complète repose sur des critères revus `model_number` + `date_code` : une confirmation **sur GTIN seul** reste impossible tant qu'aucune classe GTIN revue n'est approuvée. |
| 2   | GTIN exact + lot obligatoire manquant                    | `unsupported_scope`, aucune alerte                                                                                                                                                                                                                                                |
| 3   | GTIN exact + mauvais lot                                 | `unsupported_scope`, aucune alerte                                                                                                                                                                                                                                                |
| 4   | GTIN exact + bon lot                                     | aucune alerte : `lot_number` est hors allowlist, donc jamais une règle complète supportée                                                                                                                                                                                         |
| 5   | date obligatoire absente                                 | `criteria_not_satisfied`, aucune alerte (v1 et v2)                                                                                                                                                                                                                                |
| 6   | date hors plage (date code hors liste revue)             | `criteria_not_satisfied`, aucune alerte ; une fenêtre de fabrication non revue → `unsupported_scope`                                                                                                                                                                              |
| 7   | date dans la plage                                       | alerte **uniquement** avec la preuve complète (cas 1)                                                                                                                                                                                                                             |
| 8   | juridiction incompatible                                 | `jurisdiction_mismatch`, aucune alerte                                                                                                                                                                                                                                            |
| 9   | juridiction inconnue                                     | `incomplete_evidence`, aucune alerte ; **eligible** avec `GLOBAL` explicite                                                                                                                                                                                                       |
| 10  | v1 `confirmed`, contrat en échec                         | stocké `needs_review`, `alert_outcome = none`                                                                                                                                                                                                                                     |
| 11  | Nemotron/hybride `confirmed`, contrat en échec           | idem, avec la provenance Nebius conservée                                                                                                                                                                                                                                         |
| 12  | retry `unchanged`                                        | v1 : la paire est sautée sans alerte ; v2 : `unchanged` puis `create_recall_v2_alert` → `ineligible`                                                                                                                                                                              |
| 13  | ancienne éligibilité non sûre                            | inventaire exact, application, idempotence ; réarmement refusé ; alertes conservées                                                                                                                                                                                               |
| 14  | idempotence                                              | reconfirmation → alerte `existing` ; une seule alerte au total ; neutralisation idempotente                                                                                                                                                                                       |
| 15  | candidat observable                                      | `needs_review` avec identifiants et raison dans `recall_matches` et `recall_match_evaluations_v2`                                                                                                                                                                                 |

**Autres preuves :**

- écritures directes refusées : une alerte sur un match `needs_review`, sur un match forcé à
  `confirmed`, ou un snapshot v2 sans preuve ;
- parité de juridiction TS/SQL sur 11 cas partagés : le test Node lit les lignes du fichier
  pgTAP ;
- normalisation SQL incluse dans la normalisation TS ;
- l'orchestrateur v1 compte le statut enregistré, la décision du matcher restant `confirmed` ;
- compatibilité avec une base pré-F-4 ;
- la migration n'exécute pas la neutralisation et ne touche ni à la politique, ni au fingerprint,
  ni à l'allowlist.

**Suites existantes adaptées (comportement changé par conception).** Les suites pgTAP 10, 16-33,
16-4, la section « états » de 17-7a-1, et la suite distante de compatibilité testent la
**mécanique** des alertes sur des fixtures non revues : baux, réutilisation, inversion,
snapshots, corrections, push.

- Elles reçoivent une **couture de test explicite et commentée** : dans leur transaction
  annulée, `private.automatic_alert_eligibility` renvoie `eligible`.
- **Revue finale (§12) :** la suite distante n'a **plus** de couture ; ses assertions suivent F-4.
- La suite 11 (push) remplace une insertion d'alerte sur un match `needs_review` par un
  `throws_ok`, car F-4 la refuse désormais. Le plan passe de 43 à 44.
- `tests/phase-17-7a-1-product-check.test.mjs` met à jour, avec justification, les empreintes de
  `orchestrator.ts`, `legacyRun.ts` et `store.ts`.

**Points résolus lors de la revue finale (§12) :**

- la suite distante de compatibilité est réécrite sans couture ;
- `scripts/verify-phase-16-33-v1-concurrency.mjs` est corrigé et exécuté en rehearsal.

## 7. Effet attendu en production (lecture seule, 2026-10-02)

| Mesure                                                                         | Valeur      |
| ------------------------------------------------------------------------------ | ----------- |
| Avis / scopes                                                                  | 103 / 116   |
| Scopes avec règles revues servies                                              | **0**       |
| Scopes à couverture complète                                                   | **0**       |
| **Avis capables de produire une alerte automatique**                           | **0 / 103** |
| Correspondances confirmées v1, alertes v1, éligibilités v2 actives, alertes v2 | 0, 0, 0, 0  |
| Produits                                                                       | 0           |

**Ce qui reste observable :** toute correspondance plausible reste un `needs_review` ou une
correspondance possible. C'est le cas de l'avis 8877 pour un GTIN Thule (aujourd'hui `confirmed`
par v1, désormais `needs_review`), et des avis Health Canada, déjà `needs_review` en v1 à cause de
leurs `additional_criteria`.

**C'est acceptable pour la sécurité, et la barre n'a pas été abaissée.** La couverture
automatique augmentera par la revue humaine des règles, pas par un assouplissement.

## 8. Stratégie pour une vraie preuve de bout en bout (non exécutée)

1. **Choisir** un avis CPSC officiel réel, actif, dont la portée s'exprime **entièrement** en
   classes supportées : modèle exact, et date code ou liste de date codes dans un tableau de page.
   Il ne doit avoir ni condition hors tableau (autocollant, couleur sans modèle…) ni UPC
   recall-level comme seul identifiant.
   - Candidats à évaluer parmi les avis à tableau déjà traités par le worker de page (16.23 à
     16.31).
   - **Ne jamais fabriquer un avis officiel.**
2. **Laisser le worker de page** produire la révision et les candidats, puis lever les
   éventuels holds d'identité.
3. **Revue humaine complète :**
   - relecteur autorisé, MFA aal2 ;
   - décision sur chaque candidat ;
   - matérialisation ;
   - ledger de couverture `complete` ;
   - attestation hors recensement ;
   - vérifier que l'enveloppe servie indique `coverage.complete = true`.
4. **Compte de test dédié :** un produit de test avec le modèle et le date code exacts, et le pays
   de la juridiction de l'avis. Il doit être étiqueté explicitement comme preuve de démonstration
   et non comme un achat réel.
5. **Exécuter :**
   - la vérification produit 17.7a-1 (`check-owned-product`) ;
   - le pipeline v1 recall → produits ;
   - vérifier une seule alerte, et que la juridiction ou un date code modifié la retient.
6. Chaque écriture de production dans ce parcours nécessite un « GO » explicite.

## 9. Validation

Les valeurs ci-dessous sont l'état final après la revue pré-commit du 2026-10-03.

| Contrôle                                                                      | Résultat                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npx supabase db reset --local --no-seed`                                     | OK (34 migrations)                                                                                  |
| `npm run check:all`                                                           | **PASS** (exit 0)                                                                                   |
| Node                                                                          | **501/501** (487 + 14 F-4)                                                                          |
| Deno                                                                          | **21/21** (18 + 3 F-4)                                                                              |
| Typecheck Edge (10 fonctions), `tsc`, `expo lint`, Prettier, benchmarks figés | OK                                                                                                  |
| pgTAP (25 fichiers)                                                           | **2634 PASS**, dont la suite F-4 (160) et la suite distante (90)                                    |
| Rehearsal `npm run test:phase-16-33:rehearsal` (hors `check:all`)             | **22/22**                                                                                           |
| HTTP réel 17.7a-1 (`supabase functions serve`, vrais JWT)                     | **16/16** avec F-4 (passe précédente ; chemin produit inchangé depuis, hors extraction de fonction) |
| `git diff --check`, scan de secrets                                           | OK ; 0 occurrence                                                                                   |
| Arbre après les tests                                                         | stable ; base locale réinitialisée                                                                  |

## 10. Release gate 17.7a

> **Mise à jour du 2026-10-03 :** F-4 est installé, vérifié en production et `resolved` (preuve :
> `releases/phase-17-7a-f4/post-install-verification.json`). 17.7a-1 n'est toujours pas
> installée : `productionReady` reste `false`. Le reste de cette section décrit l'état au moment
> de la revue.

Dans `docs/phase-17-7a-1-release-gate.json` :

- F-4 a le statut `fixed_locally_pending_review` (non commité, non installé) ;
- `productionReady: false` ;
- `installOrder` impose d'installer et de vérifier F-4 en production **avant** 17.7a-1.

**Depuis la revue finale, le test dérive l'état des artefacts réels** ; le JSON seul ne suffit
jamais (§12.10).

## 11. Prochaine étape recommandée

1. Revoir ce correctif, puis le commiter localement.
2. Préparer un plan d'installation contrôlée F-4 :
   - install-check en lecture seule ;
   - migration ;
   - deploy de `process-recall-matches` ;
   - inventaire de neutralisation en lecture seule ;
   - vérification post-installation (suite distante F-4, inventaire) ;
   - enregistrement `releases/phase-17-7a-f4/post-install-verification.json` ;
   - « GO » par étape.
3. Ensuite seulement : 17.7a-2, puis l'installation de 17.7a-1.

## 12. Revue finale pré-commit (2026-10-03)

### 12.1 Coutures de test — surface de contournement production : NONE

**Mécanisme de la couture.** Dans une suite pgTAP **locale**, juste après `begin;`, on exécute
`create or replace function private.automatic_alert_eligibility(uuid, uuid) … select 'eligible'`.
La fonction est remplacée **uniquement dans la transaction de test**, et le `rollback;` final
restaure la définition de la migration.

- C'est du SQL de fixture ; aucune fonction runtime n'a été modifiée pour la permettre.
- Aucun paramètre, header, variable d'environnement, RPC ou branche `if test` n'existe dans le
  runtime.

| Fichier (local uniquement)                                     | Objet de la couture                                         | Raison                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `supabase/tests/phase-10-recall-loop.sql`                      | `private.automatic_alert_eligibility` (dans la transaction) | mécanique bail / alerte / inversion v1 sur des fixtures GTIN non revues         |
| `supabase/tests/phase-11-push-notifications.sql`               | idem                                                        | mécanique de file push ; l'alerte non sûre est en plus testée comme **refusée** |
| `supabase/tests/phase-16-33-security-and-v1-correctness.sql`   | idem                                                        | concurrence v1                                                                  |
| `supabase/tests/phase-16-4-full-path.sql`                      | idem                                                        | chemin v2 historique (snapshots, corrections)                                   |
| `supabase/tests/phase-17-7a-1-owned-product-recall-checks.sql` | idem (section « états » seulement)                          | dérivation des états de surveillance                                            |

**Garde-fous vérifiés automatiquement** (`tests/phase-17-7a-f4-safety.test.mjs`) :

- la couture n'existe que dans ces 5 fichiers locaux ;
- chacun commence par `begin;` et finit par `rollback;`, sans `commit;` ;
- la suite distante ne contient aucune couture, aucun `disable trigger`, aucune écriture
  d'alerte ou d'éligibilité ;
- aucun code runtime (migrations, fonctions Edge, `src`, `app`) ne contient de motif
  `bypass/skip/force/disable_(safety|proof|gate)` ni de mode test ;
- `private.automatic_alert_eligibility` n'est définie que par la migration F-4.

Côté pgTAP F-4 :

- aucune fonction publique ou privée n'a de nom ou de corps de contournement ;
- la preuve est `SECURITY DEFINER` avec `search_path = ''` ;
- le classifieur est `IMMUTABLE`.

**Deux autres suites, sans couture :**

- `phase-13-global-product-model.sql` insère désormais son match v1 de fixture en
  `needs_review`. Son assertion d'isolation RLS ne dépend pas du statut.
- **`phase-16-product-safety-evidence.sql` est un artefact figé Phase 16 et reste octet pour
  octet intact.**
  - SHA `800ce8cd…`, identique au manifeste, lui-même inchangé.
  - Sa fixture écrit un match v1 `confirmed` directement, ce que F-4 refuse à tous les rôles.
    Le fichier n'est donc plus exécuté.
  - `scripts/run-local-pgtap.mjs` (le `test:database` de `check:all`) ne l'exclut que tant que
    ses octets égalent le SHA du manifeste et que son successeur existe.
  - **Successeur actif :** `supabase/tests/phase-17-7a-f4-product-safety-evidence.sql`. Il
    conserve toutes les assertions Phase 16, et la décision historique v1 passe par le vrai
    finaliseur. Il vérifie :
    - aucune exemption propriétaire : le rôle `postgres` est refusé lui aussi ;
    - `service_role` est refusé ;
    - la décision v1 est retenue en `needs_review`, avec méthode, identifiants et raisonnement
      conservés ;
    - 0 alerte et 0 push.
  - `tests/phase-17-7a-f4-frozen-successor.test.mjs` vérifie les octets historiques, l'exclusion
    et la reprise des assertions.

### 12.2 Suite distante de compatibilité (production, lecture seule)

`supabase/tests/remote/phase-16-production-compatibility.sql` :

- **Aucune preuve accordée.** La couture conditionnelle est supprimée.
- **Arrêt si F-4 absent.** Un bloc `do` lève une exception avant toute fixture si F-4 n'est pas
  installé : la suite ne peut jamais emprunter un chemin d'alerte non gardé.
- **Contrôles en lecture seule :** les 5 gardes existent, et aucun rôle de l'API ne peut appeler
  la preuve.
- **Fixtures inchangées dans leur principe** (transitoires, annulées). La règle revue est créée
  par le vrai chemin humain. Les produits n'ont ni date code ni pays : **aucune paire n'est
  jamais prouvée**, ce que vérifie une assertion.
- **Nouvelles assertions F-4 :**
  - confirmations stockées en `needs_review` avec la raison ;
  - **0 éligibilité, 0 alerte, 0 correction** ;
  - `create_recall_v2_alert` → `ineligible` ;
  - le fil v2 affiche `needs_review` (jamais « sûr ») ;
  - le chemin v2 n'écrit aucun match v1.
- **Supprimé :** la section qui insérait un match v1 `confirmed` et une alerte historiques.
- **Plan :** 90 (au lieu de 89). Le test 16.15 du wrapper est mis à jour en conséquence.
- **À noter :** avant l'installation de F-4, cette suite refuse de s'exécuter en production.
  C'est voulu : elle devient la vérification post-installation.

### 12.3 Script de concurrence 16.33 (option B)

`scripts/verify-phase-16-33-v1-concurrency.mjs` teste toujours son but : aucune perte silencieuse,
chaque paire légitime persistée exactement une fois ou explicitement en attente.

- **Ce qu'il vérifie désormais :** les paires GTIN non revues sont persistées une fois en
  `needs_review`, avec la raison F-4, sans alerte. `confirmed = 0`, `safetyWithheld = 2`, aucune
  alerte au total.
- **Option A non retenue :** elle aurait testé la revue humaine plutôt que la concurrence.
- **Le script était aussi obsolète sur un autre point :** son rejeu « Phase 12 » lisait
  `git show HEAD:` et n'utilisait donc plus l'orchestrateur d'avant 16.33. Il est désormais
  épinglé sur `PHASE12_REF = 'c6fc8d5'`, et la reproduction du défaut historique fonctionne de
  nouveau.
- **Statut :** rehearsal, **hors `check:all`**. Il commite des fixtures qui fausseraient les
  suites pgTAP, et dépend de l'historique git.
- **Exécution :** `npm run test:phase-16-33:rehearsal` réinitialise la base locale avant et après
  (node `--experimental-transform-types`).
- **Résultat : 22/22.**

### 12.4 Toutes les voies de création d'alerte ou d'éligibilité

| Voie                                                                                         | Contrôle F-4                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT` direct `public.alerts` (service_role a `INSERT`)                                    | trigger `alerts_require_safe_scope` : match `confirmed` **et** preuve                                                                       |
| `UPDATE public.alerts.recall_match_id`                                                       | même trigger (`UPDATE OF recall_match_id`)                                                                                                  |
| RPC v1 de création d'alerte                                                                  | il n'en existe pas ; seule `finalize_recall_match_evaluation` insère, après rétrogradation                                                  |
| `finalize_recall_match_evaluation` (v1, hybride)                                             | preuve sous verrou ; sinon `needs_review` ; trigger en appui                                                                                |
| `UPDATE` / `INSERT` direct `recall_matches.status = 'confirmed'` (service_role a les droits) | **nouveau** trigger `recall_matches_require_safe_confirmation`                                                                              |
| `finalize_recall_match_evaluation_v2` (wrapper)                                              | rétrogradation ; le cœur `…_phase163` n'est exécutable par aucun rôle de l'API                                                              |
| `INSERT` direct d'évaluation v2 `confirmed`                                                  | aucun droit de l'API sur `private` ; **nouveau** trigger `recall_match_evaluations_v2_require_safe_confirmation`                            |
| éligibilité v2 (insertion, réarmement, changement d'évaluation)                              | trigger `recall_alert_eligibility_v2_require_safe_scope` ; aucun droit de l'API                                                             |
| `create_recall_v2_alert`, y compris la récupération duplicate/unchanged                      | contrôle de preuve avant écriture (`ineligible`) ; trigger sur `recall_alert_snapshots_v2`                                                  |
| Notifications : `alerts_enqueue_confirmed_push`                                              | ne s'exécute qu'après une insertion d'alerte gardée                                                                                         |
| Notifications : `queue_recall_push_alerts` (service_role)                                    | **désormais** soumis à la preuve (une alerte historique non sûre n'est jamais mise en file)                                                 |
| `send-recall-notifications` / `claim_recall_push_deliveries`                                 | livrent seulement la file ; aucune création                                                                                                 |
| Scripts opérateur                                                                            | aucun n'insère d'alerte ; la neutralisation ne fait que **retirer** des confirmations                                                       |
| Anciennes fonctions                                                                          | l'ancien finaliseur v1 est supprimé et recréé ; le cœur v2 est réservé au propriétaire ; aucune autre écriture d'alerte dans les migrations |
| `postgres` / propriétaire                                                                    | peut administrer (désactiver un trigger) ; **aucun rôle runtime** (anon, authenticated, service_role) ne peut le faire                      |

Les tests pgTAP F-4 couvrent chaque voie applicative, en particulier service_role : appel de la
preuve et du classifieur refusé, insertion d'alerte refusée, `confirmed` direct refusé, accès à
l'éligibilité refusé, identifiants arbitraires passés au finaliseur sans confirmation possible.

### 12.5 Sémantique multi-scope (vrai chemin de revue)

| Cas                                                               | Résultat                                      |
| ----------------------------------------------------------------- | --------------------------------------------- |
| A. 2 scopes complets, produit = scope 1                           | `eligible`                                    |
| B. 2 scopes complets, produit = scope 2                           | `eligible`, puis confirmation avec une alerte |
| C. 2 scopes complets, aucun ne correspond                         | `criteria_not_satisfied`                      |
| C2. modèle du scope 1 + date code du scope 2                      | `criteria_not_satisfied` (jamais de mélange)  |
| D. scope 1 complet, scope 2 non servi                             | `unsupported_scope`, aucune confirmation      |
| E. règle servie, mais ligne non extraite (couverture non prouvée) | `unsupported_scope`                           |

Ces cas sont aussi couverts dans la parité TS/SQL (`multi_scope_*`) et pour un ensemble
`ambiguous`.

**« Chaque scope couvert » ≠ « chaque scope satisfait » :** la couverture est exigée pour tous
les scopes ; la satisfaction se fait par **une** règle (OU entre règles, ET à l'intérieur).

### 12.6 Révisions : une preuve n'est jamais mise en cache

La preuve est recalculée à chaque finalisation et à chaque écriture gardée.

| Changement                                                             | Résultat                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GTIN, lot ou avis modifié entre claim et finalisation                  | `stale`, aucune écriture                                            |
| date code, modèle ou pays modifié                                      | `needs_review` (`criteria_not_satisfied` / `jurisdiction_mismatch`) |
| nouvelle révision officielle de page                                   | `unsupported_scope`                                                 |
| révocation d'une décision de revue (`invalidate_cpsc_review_decision`) | `unsupported_scope`, aucune confirmation                            |
| nouveau ledger de couverture non complet                               | `unsupported_scope`                                                 |

Chaque cas est isolé par savepoint ; la base revient ensuite à l'état éligible.

_Note de test :_ `now()` est figé dans une transaction pgTAP. Les cas « entre claim et
finalisation » vieillissent donc d'abord les révisions d'une minute.

### 12.7 Alertes historiques (migration)

La migration :

- ne supprime aucune alerte (test) ;
- n'exécute pas la neutralisation (test) ;
- documente la procédure opérateur (§5).

La routine :

- est idempotente ;
- ne touche que les confirmations et éligibilités réellement non sûres ; les preuves valides sont
  intactes ;
- propose un inventaire `p_apply = false` avant toute écriture.

Production au 2026-10-02 : rien à neutraliser.

### 12.8 Audit de `automatic_alert_eligibility`

| Propriété                    | Valeur                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                         | `SECURITY DEFINER` : elle doit lire `private.*` (enveloppe de revue) depuis les triggers de rôles API ; owner `postgres`                                                                                                                        |
| `search_path`                | `''` (vérifié en pgTAP)                                                                                                                                                                                                                         |
| EXECUTE                      | révoqué pour `public`, `anon`, `authenticated` et `service_role` (vérifié, y compris par appel réel en `service_role`)                                                                                                                          |
| Entrées                      | deux identifiants seulement ; aucune donnée fournie par l'appelant                                                                                                                                                                              |
| Données lues                 | produit du propriétaire (preuve déclarée par l'utilisateur, qui n'affecte que **ses** alertes) ; avis, source, scopes et juridictions (aucun droit d'écriture pour un rôle de l'API) ; enveloppe construite par la base depuis le ledger humain |
| Déterminisme                 | classifieur pur `IMMUTABLE` ; le wrapper `STABLE` ne dépend que de l'état de la base (et de la validité temporelle de l'attestation, lue par l'enveloppe existante)                                                                             |
| Fail-closed                  | identifiants inconnus → `unsupported_scope` ; toute exception → `human_review_required` ; comparaisons JSON sans cast faillible                                                                                                                 |
| Fabrication par service_role | impossible : appel refusé, écritures directes refusées, finaliseur rétrogradé (testé)                                                                                                                                                           |

### 12.9 Parité TS/SQL

27 cas générés de façon déterministe (`scripts/generate-phase-17-7a-f4-parity-cases.mjs`) sont
embarqués tels quels dans la suite pgTAP. Le test Node vérifie que le JSON embarqué est identique
à la sortie du générateur, puis exécute chaque cas par la vraie fonction TS
`assessRecallForProduct`, utilisée par l'orchestrateur 17.7a-1.

**Couverture des cas :**

- source non officielle ;
- couverture incomplète ; negative evidence non éligible ;
- ensemble `ambiguous` seul, puis à côté d'un ensemble valide ;
- critère non supporté ; règle sans modèle ;
- revue périmée (non servie) ;
- modèle seul ; modèle + date code ; NFKC pleine largeur ;
- date code faux ; date code absent ; modèle faux ;
- juridiction incompatible ; pays inconnu ; `GLOBAL` + pays inconnu ;
- multi-scope (5 cas) ;
- enveloppe liée à un autre scope ; provenance non officielle ;
- règle dupliquée ; aucun scope.

**Résultat :** même classification TS et SQL pour les 27 cas, plus 11 cas de juridiction et 6
cas de normalisation déjà en place.

**Limite documentée :** SQL ne recalcule pas l'empreinte sémantique des règles, car il lit
l'enveloppe construite par la base elle-même. La TS la recalcule.

### 12.10 Release gate dérivé

`tests/phase-17-7a-1-release-gate.test.mjs` dérive l'état « prêt pour la production » des
artefacts réels :

- correctif F-4 **commité** : `git ls-files` et `git diff --quiet HEAD` sur la migration et les
  tests F-4. Sans git, l'état est « non commité » ;
- **installé** : `releases/phase-17-7a-f4/post-install-verification.json` et
  `releases/phase-17-7a-1/post-install-verification.json` doivent exister. Leur
  `migrationSha256` doit égaler l'empreinte du fichier de migration local, avec `remoteSuite:
"pass"`, un inventaire et une date ;
- blocage F-4 `resolved` ou `neutralized`, **avec une décision écrite**.

Le JSON ne peut jamais affirmer plus que les artefacts. Aujourd'hui : F-4 n'est pas installé,
donc `productionReady = false` (test).

### 12.11 Blocages restants

1. ~~Artefact figé Phase 16~~ : résolu. Octets et manifeste intacts, successeur actif.
2. **Commit F-4** (en attente du GO).
3. **Installation contrôlée en production** (« GO » par étape), puis :
   - suite distante F-4 ;
   - inventaire de neutralisation ;
   - enregistrement de vérification post-installation.
4. **17.7a-2**, puis l'installation de 17.7a-1, qui exigent l'étape 3.
