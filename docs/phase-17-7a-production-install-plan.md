# Phase 17.7a-1 + 17.7a-2 — Plan d'installation production contrôlée

**Statut :** plan préparé. **Aucune écriture production** dans cette passe :

- aucune migration, aucun deploy, aucune activation ;
- aucun cron manuel, aucun changement de secret, aucun push.

**Lectures production effectuées (lecture seule, 2026-10-03, après le run de 12:17 UTC) :**

- `list_edge_functions` ;
- `get_edge_function run-recall-automation` (passe 17.7a-2) ;
- des `SELECT` d'agrégats et de catalogue : **aucune donnée personnelle** lue ni affichée (comptes,
  empreintes de définitions, métadonnées de schéma, données officielles publiques agrégées).

**Base :** `main` = `origin/main` = `6bab7d340ab6c42bdb6dd41fe14e929a7801b31c`, arbre propre.

**Règle d'exécution (inchangée depuis F-4) :**

- chaque écriture production exige un **GO explicite et séparé** ;
- après chaque GO : exécution, puis toutes les vérifications en lecture seule, puis arrêt ;
- si l'auto-mode refuse une commande (`supabase functions deploy`, `test:remote-pgtap`), la
  commande exacte est remise à l'opérateur, jamais contournée.

**Invariant de tout le plan :** `product_check_enabled = false` jusqu'au GO séparé
`GO 17.7A-ACTIVATE`. Aucune étape avant ce GO ne peut lancer une vérification de produit (§8).

**Fichiers créés par cette passe** (locaux, non commités) :

- ce document ;
- `scripts/stage-17-7a-edge-bundles.mjs` (staging et vérification des bundles) ;
- `supabase/gated-migrations/20261004000000_phase_17_7a_2_rollback.sql` ;
- `supabase/gated-migrations/20261004000100_phase_17_7a_1_rollback.sql` ;
- `audits/phase-17-7a-install/p1-post-17-7a-1.sql`, `p2-post-17-7a-2.sql`,
  `p4-flag-false-natural-run.sql`, `p5-user-test.sql` (requêtes en lecture seule).

## Vue d'ensemble

| #   | Étape                                                    | Écriture production    | GO                             |
| --- | -------------------------------------------------------- | ---------------------- | ------------------------------ |
| 0   | Préflight relancé juste avant                            | non                    | —                              |
| 1   | Migration 17.7a-1 seule                                  | **oui**                | `GO 17.7A1-MIGRATION`          |
| 2   | Vérification P1                                          | non                    | —                              |
| 3   | Migration 17.7a-2 seule                                  | **oui**                | `GO 17.7A2-MIGRATION`          |
| 4   | Vérification P2                                          | non                    | —                              |
| 5   | Deploy `check-owned-product`                             | **oui**                | `GO 17.7A-CHECK-OWNED-PRODUCT` |
| 6   | Deploy `process-owned-product-checks`                    | **oui**                | `GO 17.7A-PRODUCT-WORKER`      |
| 7   | Deploy `run-recall-automation` 17.7a-2                   | **oui**                | `GO 17.7A-AUTOMATION`          |
| 8   | Vérification distante (bundles, P2, suite pgTAP annulée) | **oui** (transitoire)  | `GO 17.7A-REMOTE-VERIFY`       |
| 9   | Premier run naturel, flag `false` (P4)                   | non                    | —                              |
| 10  | Test utilisateur T1, flag `false` (P5, puis P4)          | données du compte test | accord opérateur               |
| 11  | Activation                                               | **oui**                | `GO 17.7A-ACTIVATE` (séparé)   |

**Avant activation : 5 écritures persistantes** (2 migrations, 3 deploys), **1 transitoire**
(suite distante annulée), plus les données que le compte de test crée lui-même dans l'app.

## 1. Préflight production (lecture seule)

| Contrôle            | Production                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations          | **33**, dernière `20261002110000` (F-4)                                                                                                              |
| Historique          | `md5(string_agg(version‖name))` = `4385e5f958b5c5f4a4a7699773de46ed`, **identique** aux 33 premiers fichiers du dépôt                                |
| F-4                 | 5 triggers actifs, 10 fonctions `private` ; les **14 md5** de définitions sont identiques au plan F-4 ; inventaire de neutralisation **0**           |
| Objets 17.7a        | **absents** : tables, colonnes `product_check_enabled` / `max_product_check_candidates`, 11 fonctions, trigger d'armement, 4 index                   |
| `owned_products`    | `user_id` NOT NULL ; 3 triggers existants (`protect_created_at`, `protect_owner`, `set_updated_at`), propriétaire `postgres`                         |
| Données métier      | 0 produit, 0 match, 0 alerte, 0 file push, 0 livraison, 0 évaluation / éligibilité / snapshot / evidence v2, 0 bail de matching, 0 recall en attente |
| Référentiel         | 103 avis (41 CPSC, 62 Health Canada), 116 scopes, 103 juridictions ; 2 appareils push ; 2 comptes auth                                               |
| Contrôle automation | `enabled`, `ai_enabled`, `push_enabled` à `true` ; plafonds 100 / 500 / 5 / 25                                                                       |
| Cron                | **un seul** : job 2 `recall-automation-every-6h`, `17 */6 * * *`, actif, md5 de commande `aae24c40…6651`                                             |
| Bail automation     | vide (aucun run en cours)                                                                                                                            |
| Derniers runs       | 4 × `partial_success` / `source_partial_failure` (CPSC 502 connu), dernier à 12:17 UTC                                                               |
| Extensions          | `pg_cron`, `pg_net`, `pgcrypto` ; **pgTAP absent**                                                                                                   |

**Edge Functions (inchangées depuis le plan 17.7a-2) :**

| Fonction                           | Version | `ezbr_sha256` | `verify_jwt` |
| ---------------------------------- | ------- | ------------- | ------------ |
| `run-recall-automation`            | **14**  | `42d8a0dc…`   | false        |
| `process-recall-matches`           | **23**  | `7370fe79…`   | false        |
| `send-recall-notifications`        | 16      | `58b6945b…`   | false        |
| `ingest-cpsc-recalls`              | 26      | `2b0774c5…`   | false        |
| `ingest-recall-source`             | 15      | `ba394992…`   | false        |
| `ingest-recall-sources`            | 12      | `c41cb92e…`   | false        |
| `process-recall-matches-v2-cohort` | 11      | `682308bd…`   | false        |
| `process-cpsc-page-evidence`       | 12      | `c15d6623…`   | true         |

`check-owned-product` et `process-owned-product-checks` **n'existent pas**.

**Préflight à relancer juste avant `GO 17.7A1-MIGRATION`.** On rejoue les deux requêtes du
préflight. Elles doivent redonner exactement les valeurs ci-dessus et un bail automation vide.

**Fenêtre :** hors de `:10`–`:30` (cron à `:17`), pour toutes les étapes 1 à 8.

## 2. Migrations : ordre et contenu

| Ordre | Fichier                                                          | SHA-256                                                            |
| ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1     | `20261002120000_phase_17_7a_1_owned_product_recall_checks.sql`   | `61639ab4445cf42897217ecd5b31f7b66fd88ef2f3cc63537f51c3848ec219be` |
| 2     | `20261003090000_phase_17_7a_2_automation_product_check_plan.sql` | `2b2a3b35b7c93ccbce928db563b7250430eea1257ac79f73abfbb11873dab890` |

**Dépendances :**

- 17.7a-1 dépend des tables Phase 12 (`recall_automation_control`), 10/13 (`owned_products`,
  `recall_notices`, `recall_scopes`), 16 (évaluations v2) et 14 (`recall_notice_jurisdictions`) ;
- 17.7a-2 dépend de `recall_automation_lease` (Phase 12) et de la colonne `product_check_enabled`
  (17.7a-1).

Les deux versions sont postérieures à F-4 : **aucune migration hors ordre**, pas de
`--include-all`.

### 17.7a-1 : surface exacte

| Type              | Objets                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colonnes          | `private.recall_automation_control` : `product_check_enabled boolean not null default false`, `max_product_check_candidates integer not null default 25` (1..100). **La ligne singleton prend `false`.**                                                                                                                                                                                                                                                                  |
| Tables            | `private.owned_product_recall_checks` (PK produit, FK `on delete cascade`), `private.owned_product_recall_check_events` (append-only) ; RLS activée ; `revoke all` à public, anon, authenticated **et** service_role ; 4 index                                                                                                                                                                                                                                            |
| Triggers          | `owned_products_arm_recall_check_insert` (AFTER INSERT) et `owned_products_arm_recall_check_update` (AFTER UPDATE OF 8 colonnes, `WHEN … IS DISTINCT FROM`) sur `public.owned_products` ; `…_events_no_update` / `…_no_truncate` sur le journal                                                                                                                                                                                                                           |
| Fonctions         | publiques service_role : `get_owned_product_recall_candidates`, `claim_owned_product_recall_check`, `claim_due_owned_product_recall_checks`, `complete_owned_product_recall_check` ; publique authenticated : `get_my_product_monitoring_states` ; privées sans aucun rôle API : `owned_product_monitoring_state`, `owned_product_check_backoff`, `claim_owned_product_recall_check_row`, `arm_owned_product_recall_check`, `owned_product_recall_check_events_immutable` |
| Index référentiel | `recall_notices_title_fts_idx` (GIN), `recall_scopes_normalized_brand_idx`, `…_serial_range_idx`, `…_lot_range_idx` (116 / 103 lignes : verrou bref)                                                                                                                                                                                                                                                                                                                      |
| Données           | un `insert … select` d'une tâche par produit existant : **0 ligne en production**                                                                                                                                                                                                                                                                                                                                                                                         |
| Non touché        | **aucun `create or replace`** d'une fonction existante : F-4, matching v1/v2, automation et push sont intacts                                                                                                                                                                                                                                                                                                                                                             |

### 17.7a-2 : surface exacte

C'est une seule fonction, `public.get_recall_automation_product_check_plan(uuid, uuid)` :

- `stable`, `SECURITY DEFINER`, `search_path = ''` ;
- liée au bail vivant du run ;
- elle renvoie seulement le flag ;
- `revoke` à public, anon, authenticated ; `grant execute` à service_role ;
- aucune écriture, aucune table, aucun réglage, aucun cron.

### Arbres de staging

Un `db push` depuis le dépôt appliquerait **les deux** migrations. On pousse donc depuis deux
arbres construits depuis le commit revu :

```bash
SCR=<scratchpad>; REV=6bab7d340ab6c42bdb6dd41fe14e929a7801b31c
mkdir -p "${SCR:?}/a1-db-stage" "${SCR:?}/a2-db-stage"
git archive "$REV" supabase/migrations supabase/config.toml | tar -x -C "${SCR:?}/a1-db-stage"
git archive "$REV" supabase/migrations supabase/config.toml | tar -x -C "${SCR:?}/a2-db-stage"
mkdir -p "${SCR:?}/a1-db-stage/supabase/gated-migrations"
mv "${SCR:?}/a1-db-stage/supabase/migrations/20261003090000_phase_17_7a_2_automation_product_check_plan.sql" \
   "${SCR:?}/a1-db-stage/supabase/gated-migrations/"
for d in a1 a2; do mkdir -p "${SCR:?}/$d-db-stage/supabase/.temp" && \
  cp supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version} "${SCR:?}/$d-db-stage/supabase/.temp/"; done
```

### `GO 17.7A1-MIGRATION`

```bash
shasum -a 256 "${SCR:?}"/a1-db-stage/supabase/migrations/20261002120000_*.sql   # = 61639ab4…
npx supabase db push --linked --workdir "${SCR:?}/a1-db-stage" --dry-run           # UNIQUEMENT 20261002120000
npx supabase db push --linked --workdir "${SCR:?}/a1-db-stage"
```

Puis lancer P1 (§3). **STOP.**

### `GO 17.7A2-MIGRATION` (seulement après P1 entièrement vert)

```bash
shasum -a 256 "${SCR:?}"/a2-db-stage/supabase/migrations/20261003090000_*.sql   # = 2b2a3b35…
npx supabase db push --linked --workdir "${SCR:?}/a2-db-stage" --dry-run           # UNIQUEMENT 20261003090000
npx supabase db push --linked --workdir "${SCR:?}/a2-db-stage"
```

Puis lancer P2 (§4). **STOP.**

Le dry-run distant fait partie de l'étape couverte par le GO : la CLI peut créer un rôle de
connexion temporaire. Il n'a donc pas été exécuté dans cette passe.

### Répétition locale (faite)

1. Base locale ramenée à `20261002110000` : 33 migrations, l'état exact de la production.
2. Dry-run A1 : **uniquement** `20261002120000`. Push, puis P1.
3. Historique après A1 : `20e252d0…`, égal au calcul depuis le dépôt.
4. Dry-run A2 : **uniquement** `20261003090000`. Push, puis P2.
5. `test:database` sur cet état : **26 fichiers, 2655 tests, PASS**.
6. Suite distante (`test:remote-pgtap`) contre cette base : **90/90**, rollback, pgTAP absent
   après.
7. Rollbacks 17.7a-2 puis 17.7a-1 répétés (§13).

**Risque principal :** le trigger d'armement s'exécute **dans la transaction de création du
produit**. Une erreur dans le trigger bloquerait donc la création. Ce risque est couvert :

- `user_id` est NOT NULL en production ;
- la fonction est `SECURITY DEFINER` (propriétaire `postgres`) ;
- les pgTAP 17.7a-1 couvrent l'insertion et le rollback transactionnel ;
- le test T1 (§10) l'observe sur la vraie production.

## 3. État attendu après 17.7a-1 (P1)

**Requête :** `audits/phase-17-7a-install/p1-post-17-7a-1.sql`. C'est un seul `SELECT` : il
n'appelle aucune fonction qui écrit et ne renvoie aucune donnée personnelle.

**Attendu : les 25 `checks` à `true`.**

| Check                                                                                                                                                                         | Sens                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `migrations_34_last_17_7a_1`, `history_matches_repo_6bab7d3`                                                                                                                  | 34 migrations, historique `20e252d007d03dfc374df898d4c6ac17`                    |
| `p17_7a_2_not_installed`                                                                                                                                                      | la fonction 17.7a-2 est absente                                                 |
| `tables_present_with_rls`, `no_api_role_table_privilege`                                                                                                                      | 2 tables, RLS activée, aucun privilège pour anon / authenticated / service_role |
| `owned_products_arm_triggers_enabled`, `existing_owned_products_triggers_kept`, `journal_immutability_triggers`                                                               | triggers d'armement et triggers existants actifs                                |
| **`flag_false`**, `flag_column_default_false`, `max_candidates_25`                                                                                                            | **flag `false`**, valeur par défaut `false`, budget 25                          |
| `automation_control_unchanged`                                                                                                                                                | `enabled` / IA / push et plafonds inchangés                                     |
| `service_rpcs_not_for_clients`, `service_rpcs_for_service_role`, `monitoring_read_authenticated_only`, `private_helpers_not_for_api_roles`, `definers_with_empty_search_path` | droits exacts                                                                   |
| `candidate_indexes_present`                                                                                                                                                   | les 4 index sont présents                                                       |
| `one_job_per_existing_product`, `no_check_event_beyond_arming`                                                                                                                | **0 tâche, 0 événement** (0 produit)                                            |
| `p17_7a_1_definitions_as_rehearsed`                                                                                                                                           | les 10 md5 de définitions sont égaux à la répétition locale                     |
| `f4_triggers_enabled`, **`f4_definitions_unchanged`**                                                                                                                         | les 5 triggers F-4 sont présents et les 14 définitions F-4 identiques           |
| `single_recall_cron_unchanged`, `no_automation_run_in_progress`                                                                                                               | un seul cron, inchangé ; aucun run en cours                                     |

**`observed` :** les mêmes compteurs métier qu'au préflight (0 partout, 103 avis).

En local, `automation_control_unchanged` et `single_recall_cron_unchanged` sont `false` par
construction : le contrôle est désactivé et il n'y a pas de cron. Les 23 autres checks sont
`true`.

## 4. État attendu après 17.7a-2 (P2)

**Requête :** `audits/phase-17-7a-install/p2-post-17-7a-2.sql`. Ce sont les checks de P1, avec :

- `migrations_35_last_17_7a_2` ;
- `history_matches_repo_6bab7d3` = `a07eb32d7999326a89ec7a9d8c0454c3` ;
- `plan_rpc_present_stable_definer` ;
- `plan_rpc_service_role_only` : ni anon, ni authenticated, ni public ;
- `plan_rpc_lease_bound_and_read_only` : prédicat de bail présent, aucun
  `insert` / `update` / `delete` ;
- `plan_rpc_as_rehearsed` : md5 `c13587657a7c62196ba3ce1e0b8aed83`.

Le reste est **inchangé** : flag `false`, 0 tâche, 0 événement, aucun worker (il n'est pas
encore déployé), aucune activation.

**Attendu : 28 `checks` à `true`** (en local : 26/28, avec les mêmes 2 écarts propres au local).

## 5. `check-owned-product` (`GO 17.7A-CHECK-OWNED-PRODUCT`)

### `verify_jwt` : décision vérifiée

**Ce que fait le code** (`_shared/productCheck/handler.ts` et `server.ts`) :

- il exige `Authorization: Bearer <JWT>` ;
- il fait vérifier ce jeton par le serveur Auth (`auth.getUser(token)`) ;
- il exige `role === 'authenticated'` ;
- il refuse 401 sinon ;
- l'identifiant utilisateur vient du jeton vérifié, jamais du corps ;
- l'appartenance du produit est vérifiée en base.

Le test HTTP réel 17.7a-1 (16/16) a prouvé ce comportement avec `verify_jwt = false` : un JWT
anon ou service-role reçoit 401 du handler.

**Configuration du dépôt :** `supabase/config.toml` déclare `[functions.check-owned-product]
verify_jwt = false`.

**Doc Supabase (consultée) :**

- la vérification de la passerelle valide les JWT HS256 et les clés de signature asymétriques ;
- elle convient aux fonctions appelées seulement avec un JWT utilisateur ;
- elle ne remplace pas une vérification de rôle, puisqu'un JWT anon la passe aussi.

**Décision : déployer avec `verify_jwt = false`**, exactement la configuration testée. La
validation dans le handler fait autorité et suffit. La passerelle serait un doublon : elle
n'enlèverait pas le contrôle de rôle et changerait la configuration testée. L'activer plus tard
(`verify_jwt = true`) est un durcissement possible, compatible avec l'app (`functions.invoke`
envoie le JWT de session), mais il demande un nouveau passage du test HTTP. Ce n'est pas une
étape de ce plan.

### Bundle exact

| Élément              | Valeur                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Source               | commit `6bab7d3`, jamais l'arbre de travail                                                       |
| Fichiers runtime     | **17**                                                                                            |
| Arbre runtime        | **`b029ef383cd4717d81fa3d2ca778f9039e5a93f796adbf7195f9508fe5f99ca0`**                            |
| Fichiers type-only   | 11 : sources envoyées par la CLI mais **effacées au bundle**                                      |
| Arbre source complet | `9bedf9d0ee9b3bb111df97d86fffa405de6c16e36210e5f89e4c5899515659ca` (28 fichiers)                  |
| Imports externes     | `npm:@supabase/supabase-js@2` seulement                                                           |
| Imports dynamiques   | aucun                                                                                             |
| `fetch` direct       | aucun                                                                                             |
| Variables lues       | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY` (fournies par la plateforme) |
| Nouveau secret       | **aucun**                                                                                         |
| `deno check`         | OK sur l'arbre isolé                                                                              |

**Fichiers runtime :**

- `_shared/productCheck/{gate,handler,orchestrator,server,supabaseStore}.ts` ;
- `_shared/matching/{candidateRetrieval,criterionEvaluatorV2,deterministicMatcherV2,deterministicRuleSetsV2,evidence,normalization,typesV2}.ts` ;
- `_shared/recallMatching/{productionPolicyV2,projection,reviewedCriteriaV2,ruleSetsV2}.ts` ;
- `check-owned-product/index.ts`.

**Les 11 modules type-only** sont `matching/{guardedNemotron*,nemotron*,types}.ts`,
`nebius/{errors,types}.ts` et `recallMatching/{orchestratorV2,types}.ts`. Ils sont atteints
**uniquement** par des imports de type : aucun code IA n'est exécutable.

La même méthode de fermeture retrouve exactement l'arbre `96875b00…` de l'automation.

### Commandes

```bash
node scripts/stage-17-7a-edge-bundles.mjs stage check-owned-product "${SCR:?}/edge-check-owned-product"   # runtimeTreeSha256 = b029ef38…
mkdir -p "${SCR:?}/edge-check-owned-product/supabase/.temp" && cp supabase/.temp/project-ref "${SCR:?}/edge-check-owned-product/supabase/.temp/"
npx -y deno@2 check "${SCR:?}/edge-check-owned-product/supabase/functions/check-owned-product/index.ts"
npx supabase functions deploy check-owned-product --project-ref cnftnulgtsraurtusnpb \
  --no-verify-jwt --workdir "${SCR:?}/edge-check-owned-product"
```

**Vérification après deploy (lecture seule) :**

1. sauvegarder le JSON de `get_edge_function check-owned-product` ;
2. lancer `node scripts/stage-17-7a-edge-bundles.mjs verify check-owned-product <json>` ;
3. attendre `ok: true`, avec `verify_jwt` false, chaque fichier runtime identique octet pour
   octet et tout fichier supplémentaire seulement type-only et identique ;
4. contrôler que `list_edge_functions` montre les 8 autres fonctions inchangées.

**Effet avec le flag `false` :** `200 { state: "pending_check", … }`, sans claim et sans écriture
(§8).

## 6. `process-owned-product-checks` (`GO 17.7A-PRODUCT-WORKER`)

| Élément          | Valeur                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bundle           | même fermeture que §5, avec `process-owned-product-checks/index.ts` : **17 runtime + 11 type-only**                                                          |
| Arbre runtime    | **`1b02f9706eb638804b354810a4b70922db452476be63d575c742794ba2eb1a78`**                                                                                       |
| Arbre source     | `bd8ad80427ec05acb7a2995f3faf107a176e06a5edbd937868584468010d3ebd`                                                                                           |
| Authentification | `x-recall-matching-key` comparée à temps constant à `RECALL_MATCHING_KEY`                                                                                    |
| Clé matching     | secret Edge existant, déjà requis par l'automation v14 ; lue seulement par ce worker, l'automation et `process-recall-matches` ; jamais par `app/` ni `src/` |
| Clé service-role | utilisée **seulement dans le processus** (client Supabase), jamais transmise en HTTP                                                                         |
| `verify_jwt`     | **doit** être `false` : l'automation l'appelle sans en-tête `Authorization`                                                                                  |
| Budget           | `maxProducts` de 1 à 25 (l'automation envoie 3) ; 20 s par produit ; bail 120 s ; candidats bornés par `max_product_check_candidates`                        |
| IA               | aucune ; la réponse déclare `aiCalls: 0`, ce que l'automation exige                                                                                          |
| Fail closed      | 401 sans clé ; 400 pour un corps invalide ; 500 en cas d'erreur ; flag `false` → `claim_due` ne renvoie rien → `{claimed: 0, …}`                             |

```bash
node scripts/stage-17-7a-edge-bundles.mjs stage process-owned-product-checks "${SCR:?}/edge-process-owned-product-checks"   # 1b02f970…
mkdir -p "${SCR:?}/edge-process-owned-product-checks/supabase/.temp" && cp supabase/.temp/project-ref "${SCR:?}/edge-process-owned-product-checks/supabase/.temp/"
npx -y deno@2 check "${SCR:?}/edge-process-owned-product-checks/supabase/functions/process-owned-product-checks/index.ts"
npx supabase functions deploy process-owned-product-checks --project-ref cnftnulgtsraurtusnpb \
  --no-verify-jwt --workdir "${SCR:?}/edge-process-owned-product-checks"
```

Vérification après deploy : comme au §5, avec `verify process-owned-product-checks`. **Aucun
appel au worker** n'est fait pour le « tester ».

## 7. `run-recall-automation` 17.7a-2 (`GO 17.7A-AUTOMATION`)

| Élément                  | Valeur                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Baseline                 | v14, ezbr `42d8a0dc…b659b5`, arbre `37a79b95bf01bb37d7af54d0c0337fc981c63ff2f5dd2adb74092196fafda515` |
| **Cible (hash complet)** | **`96875b00ba96b3721f43c48a98e1f9912fb41196f417e111f466d44de5455e57`**                                |
| Construction             | octets exacts v14 + 5 fichiers de `6bab7d3` ; `request.ts` copié de la production                     |
| Contenu                  | 6 runtime + `types.ts` (type-only)                                                                    |
| Imports                  | `npm:@supabase/supabase-js@2` et l'arbre automation seulement                                         |
| Exclusions               | **aucun** code `productCheck`, matching, IA, page worker, F-1 ou autre (le script refuse ces chemins) |
| Variables                | identiques à la v14 ; aucun nouveau secret                                                            |
| `verify_jwt`             | `false`, comme la v14                                                                                 |

```bash
# 1. relire la production juste avant : get_edge_function run-recall-automation -> "${SCR:?}/deployed-v14.json"
node scripts/stage-17-7a-2-automation-bundle.mjs "${SCR:?}/deployed-v14.json" "${SCR:?}/edge-run-recall-automation" \
  6bab7d340ab6c42bdb6dd41fe14e929a7801b31c       # refuse si ce n'est pas 37a79b95… ; doit afficher 96875b00…
mkdir -p "${SCR:?}/edge-run-recall-automation/supabase/.temp" && cp supabase/.temp/project-ref "${SCR:?}/edge-run-recall-automation/supabase/.temp/"
npx -y deno@2 check "${SCR:?}/edge-run-recall-automation/supabase/functions/run-recall-automation/index.ts"
npx supabase functions deploy run-recall-automation --project-ref cnftnulgtsraurtusnpb \
  --no-verify-jwt --workdir "${SCR:?}/edge-run-recall-automation"
```

**Vérification après deploy :** `verify run-recall-automation <json>` doit donner `ok: true` et
l'arbre `96875b00…`. Les 9 autres fonctions doivent être inchangées.

**Répété localement :** le staging depuis les octets v14 et `6bab7d3` donne `96875b00…`,
`deno check` passe sur l'arbre isolé, et `--as-deployed` redonne `37a79b95…`.

**Ordre imposé :** après `GO 17.7A2-MIGRATION`. Sinon chaque run ferait
`product_check_plan_unavailable` → `partial_success` : c'est fail closed, mais bruyant.

## 8. Flag `false` : sémantique exacte et test de non-activation

### Le flag bloque-t-il aussi le chemin immédiat de l'utilisateur ?

**Oui. `product_check_enabled = false` bloque les DEUX chemins de vérification.** Ce n'est pas
ambigu dans le code :

| Chemin                                           | Avec le flag `false`                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Immédiat** (app → `check-owned-product`)       | Le JWT et l'appartenance sont vérifiés (401 / 404 inchangés). Puis `claim_owned_product_recall_check` lit le flag **avant tout claim** et renvoie `disabled` : aucun bail, aucun `attempts`, aucun événement `claimed`. Le handler répond `200 { state, checkedAt, possibleMatches, confirmedAlerts, retrying }` **sans rien évaluer ni écrire**. |
| **Reprise** (cron → automation → worker)         | L'automation lit le flag par la RPC 17.7a-2 et **n'appelle pas** le worker (`productCheck.status = "disabled"`). Défense en profondeur : même appelé, `claim_due_owned_product_recall_checks` sort avant toute sélection et le worker renvoie `claimed: 0`.                                                                                       |
| **Armement** (trigger sur `owned_products`)      | **Reste actif** : la création ou la modification pertinente d'un produit crée ou réarme sa tâche (`pending`) et un événement `armed`. C'est voulu : la file est prête, rien n'est consommé. Il n'y a aucune lecture d'avis, aucune évaluation, aucune alerte.                                                                                     |
| **Lecture** (`get_my_product_monitoring_states`) | Active. Un produit reste en `pending_check`.                                                                                                                                                                                                                                                                                                      |

**Conséquence côté app** (constat, sans changement de code dans cette passe) :

- tant que le flag est `false`, un produit affiche « Saved — checking known recalls… » sans
  jamais progresser ;
- à chaque focus de l'inventaire, l'app redemande au plus 3 vérifications, qui reçoivent chacune
  `200 pending_check`. Cela ne fait aucune écriture : la branche `disabled` ne fait que verrouiller
  la ligne le temps de la lecture, et le quota de 60/h ne compte que les claims.

C'est **sûr** : aucune décision et aucune alerte. Le libellé serait en revanche **trompeur** pour
de vrais utilisateurs. C'est acceptable aujourd'hui parce que seuls des comptes de test existent
(2 comptes auth, 0 produit). La fenêtre « installé mais désactivé » ne doit pas durer si de vrais
utilisateurs arrivent ; sinon il faut un libellé dédié (Phase 17.5).

### Test de non-activation (lecture seule, sans tick manuel)

**Au premier run naturel après `GO 17.7A-AUTOMATION`**, lancer `p4-flag-false-natural-run.sql`
avec `since` = heure du deploy. **Attendu, tout à `true` :**

- un run naturel a eu lieu ;
- son erreur n'est pas `product_check` (`source_partial_failure` reste attendu tant que CPSC est
  en 502) ;
- la réponse est HTTP 200, avec `productCheck.status = "disabled"`, `attempted = false` et
  `claimed = 0` ;
- le flag est toujours `false` ;
- il n'existe aucun événement `worker` ni `claimed` ;
- toutes les tâches sont intactes ;
- un seul cron, inchangé.

**Logs Edge sur la fenêtre :**

- un `POST run-recall-automation` (nouvelle version) en 200 ;
- **aucune** requête vers `process-owned-product-checks` ;
- les enfants ingestion / matching / push comme avant.

**Puis, après T1 (§10)**, il existe une **vraie tâche `pending`**. Le run naturel suivant
redonne P4 tout à `true`, la tâche restant `pending` avec `attempts = 0`. C'est la preuve la plus
forte de non-activation sur des données réelles.

## 9. Vérification distante (`GO 17.7A-REMOTE-VERIFY`)

1. **Base :** P2, avec les 28 checks à `true` (lecture seule).
2. **Bundles :** `verify` des 3 fonctions → `b029ef38…`, `1b02f970…` et `96875b00…`, avec
   `verify_jwt` false. Les 8 autres fonctions doivent être inchangées (versions et ezbr du §1 ; la
   seule nouvelle version est celle de `run-recall-automation`).
3. **Suite pgTAP distante** (`npm run test:remote-pgtap`, `SUPABASE_DB_URL` fourni par
   l'opérateur et jamais affiché) :
   - une transaction **annulée**, pgTAP installé transitoirement puis absent ;
   - historique et gardes inchangés ;
   - **attendu 90/90**, répété localement sur la base à 35 migrations.

   C'est la seule écriture transitoire du plan.

4. **Aucune activation implicite :**
   - flag `false` ;
   - 0 tâche et 0 événement hors armement (P2) ;
   - 0 alerte, 0 file push, 0 livraison ;
   - inventaire F-4 = 0 ;
   - un seul cron.

**Résultat :** un enregistrement `releases/phase-17-7a-1/post-install-verification.json` (versions,
SHA des migrations, arbres, résultats), dans un commit local séparé. Le release gate 17.7a-1 n'est
pas modifié dans cette passe.

## 10. Test utilisateur contrôlé (préparé, non exécuté)

**Conditions :**

- compte de test de l'opérateur uniquement ;
- **aucun avis officiel fabriqué** ;
- aucune requête ne lit d'attribut produit : P5 ne renvoie que des agrégats.

### T1 : flag `false` (avant activation)

| Étape | Action                                                           | Attendu                                                                                                              |
| ----- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A     | Créer ou scanner **un** produit de test dans l'app               | la création réussit (le trigger ne bloque pas)                                                                       |
| B     | `p5-user-test.sql`                                               | T1 tout à `true` : 1 tâche `pending` / `attempts = 0`, 1 événement `armed/trigger`, état `pending_check`             |
| C     | L'app appelle `check-owned-product` (après création et au focus) | logs Edge : **premier appel réel**, 200, aucune erreur de boot ; en base, aucun événement `claimed` (le flag bloque) |
| D     | Run naturel suivant                                              | P4 tout à `true`, avec la tâche réelle restée `pending`                                                              |
| E     | `process-recall-matches` v23                                     | voir ci-dessous                                                                                                      |
| F     | Sécurité                                                         | 0 alerte, inventaire F-4 = 0                                                                                         |

**À propos de v23.** Le chemin produit n'appelle jamais `process-recall-matches`. La v23 n'est
invoquée par l'automation que pour des avis **en attente**, c'est-à-dire nouveaux ou mis à jour.
Une création de produit n'en crée pas. Le premier appel réel de v23 **sur une paire candidate**
exige donc :

- qu'un avis officiel nouveau ou modifié soit ingéré ;
- et qu'il soit candidat pour le produit de test.

C'est **opportuniste** : à observer passivement à chaque run, sans jamais le forcer.
`firstRealCandidateInvocationObserved` reste `false` tant que ce n'est pas arrivé.

### T2 : première vérification réelle, seulement après `GO 17.7A-ACTIVATE`

Un vrai contrôle ne peut **pas** avoir lieu avec le flag `false` (§8). T2 est donc la première
observation après activation :

- **Déclenchement :** l'app (focus de l'inventaire) ou la modification d'un attribut pertinent.
  Pas de tick manuel.
- **Données officielles disponibles** (lecture du 2026-10-03) : 13 scopes GTIN, regroupés dans
  **un seul** avis ; 0 numéro de modèle ; 0 règle revue ; 0 avis sur 103 à portée complète.
- **Résultat attendu :**
  - pour un produit dont le GTIN égale celui de cet avis (signal fort) : porte
    `unsupported_scope`, donc `needs_review` persistant → **`possible_match_needs_verification`**,
    **sans alerte** ;
  - pour un produit sans signal fort : `monitored_no_known_recall` (les candidats faibles sont
    ignorés).
- **Jamais `recall_detected` aujourd'hui.**
- **Contrôle :** `p5-user-test.sql`, avec T2 tout à `true` (0 alerte, 0 éligibilité / snapshot v2,
  0 push, 0 évaluation `confirmed`, inventaire F-4 = 0, aucune tâche `failed`).
- **Logs :**
  - un `POST check-owned-product` en 200 ;
  - au run naturel suivant, un appel au worker par l'automation (`productCheck.status =
"completed"`, `claimed` de 0 à 3 selon les tâches dues) ;
  - aucune erreur de boot.

## 11. Future démo de bout en bout (préparée, non exécutée)

C'est une étape séparée, après activation. Elle demande une **revue humaine** qui n'a pas été
faite :

1. Choisir un **vrai** avis officiel (probablement CPSC) dont la portée se réduit à
   `model_number` + `date_code` : c'est l'allowlist v2, qui n'est pas élargie.
2. **Revue humaine complète** dans le flux existant : preuve de page officielle, candidats, ledger
   de couverture et attestation (relecteur MFA). Le résultat doit être une enveloppe v2 validée
   avec `coverageComplete = true`, des règles `all_of`, des critères `required` et une
   juridiction structurée.
3. Produit du compte de test, avec le modèle et le code date exacts, et un pays d'achat
   compatible.
4. Attendu :
   - porte `eligible` → v2 `confirmed` déterministe ;
   - `create_recall_v2_alert` → une alerte ;
   - push, si `push_enabled` et `RECALL_PUSH_DELIVERY_ENABLED` ;
   - détail officiel dans l'app ;
   - inventaire F-4 = 0.

**Prérequis non remplis aujourd'hui :** 0 règle revue et 0 numéro de modèle en base. Le worker de
page reste inactif.

## 12. Activation (`GO 17.7A-ACTIVATE`, séparé)

**Préconditions :**

- étapes 1 à 9 vertes ;
- T1 vert ;
- au moins un run naturel conforme avec une tâche réelle `pending` ;
- workers observés sans erreur de boot ;
- aucune régression ingestion / matching / push ;
- inventaire F-4 = 0.

**Écriture, une ligne, exécutée par l'opérateur :**

```sql
update private.recall_automation_control set product_check_enabled = true, updated_at = now() where singleton;
```

**Juste après :** T2 (§10), puis le run naturel suivant.

**Désactivation instantanée** (`GO 17.7A-DEACTIVATE`) : la même ligne avec `false`. Les deux
chemins s'arrêtent immédiatement, sans deploy.

## 13. Rollback

**Principe :** d'abord **désactiver**, ensuite seulement **retirer**.

| Étape | GO                             | Action                                                                                                                                                | Réversible ?                                    |
| ----- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| R0    | `GO 17.7A-DEACTIVATE`          | flag → `false`                                                                                                                                        | oui, instantané ; c'est le rollback fonctionnel |
| R1    | `GO 17.7A-AUTOMATION-ROLLBACK` | redeploy de la v14 **exacte** : `stage-17-7a-2-automation-bundle.mjs <json> <dir> --as-deployed` → `37a79b95…` (répété)                               | oui                                             |
| R2    | `GO 17.7A-EDGE-ROLLBACK`       | `supabase functions delete check-owned-product` et `process-owned-product-checks`. L'app prend alors 404, déjà ignoré (`catch`)                       | oui (redeploy)                                  |
| R3    | `GO 17.7A2-ROLLBACK`           | `supabase/gated-migrations/20261004000000_phase_17_7a_2_rollback.sql` : supprime la fonction de plan. **Après R1.**                                   | oui (réinstallation par une nouvelle version)   |
| R4    | `GO 17.7A1-ROLLBACK`           | `…/20261004000100_phase_17_7a_1_rollback.sql` : triggers, 10 fonctions, 4 index, 2 tables, 2 colonnes. **Refuse de s'exécuter si R3 n'est pas fait.** | schéma oui ; journal non                        |

Les rollbacks DB sont appliqués comme migrations avant, depuis un arbre de staging. La ligne
d'historique 17.7a reste : c'est du forward-only.

**Répété localement**, sur une base 35 avec un produit de test armé :

- R4 avant R3 est refusé (`roll back Phase 17.7a-2 first`) ;
- R3 puis R4 sont appliqués ;
- le **produit est conservé** ;
- les tables, fonctions, colonnes et index 17.7a ont disparu ;
- les 3 triggers d'origine de `owned_products` sont présents ;
- les **5 triggers F-4 sont présents** et l'empreinte composite des 14 définitions F-4 vaut
  `627cbc06…`, **égale à la production** ;
- une création de produit fonctionne après le rollback.

**Ce qui ne s'annule pas, et c'est voulu :**

- **produits** utilisateurs : jamais supprimés ;
- **alertes** : jamais supprimées ;
- **évaluations v2** écrites par le chemin produit (`needs_review` / `rejected` / `confirmed`) :
  append-only, conservées telles quelles ;
- **aucune re-promotion :** aucune requête de rollback ne repasse une évaluation en `confirmed` ;
- **F-4 :** aucun objet F-4 n'est touché, dans aucun sens ;
- **seule perte :** R4 supprime la file `owned_product_recall_checks` et son journal d'événements,
  qui sont un état opérationnel dérivé. Avant R4, relever leurs agrégats (P5 `observed`).

## 14. Séquence de GO recommandée

| #   | Action                                                                        | Type                     |
| --- | ----------------------------------------------------------------------------- | ------------------------ |
| 0   | Préflight relancé (§1), hors `:10`–`:30`                                      | lecture                  |
| 1   | **`GO 17.7A1-MIGRATION`**                                                     | écriture                 |
| 2   | P1 : 25/25                                                                    | lecture                  |
| 3   | **`GO 17.7A2-MIGRATION`**                                                     | écriture                 |
| 4   | P2 : 28/28                                                                    | lecture                  |
| 5   | **`GO 17.7A-CHECK-OWNED-PRODUCT`**, puis `verify`                             | écriture + lecture       |
| 6   | **`GO 17.7A-PRODUCT-WORKER`**, puis `verify`                                  | écriture + lecture       |
| 7   | **`GO 17.7A-AUTOMATION`**, puis `verify`                                      | écriture + lecture       |
| 8   | **`GO 17.7A-REMOTE-VERIFY`** (P2 + 3 bundles + pgTAP 90/90 annulé)            | transitoire              |
| 9   | Run naturel `:17` → P4                                                        | lecture                  |
| 10  | Test utilisateur T1 (flag `false`) → P5 T1, puis run naturel suivant → P4     | compte de test + lecture |
| 11  | Enregistrement de vérification post-installation                              | commit local (GO commit) |
| 12  | **`GO 17.7A-ACTIVATE`** (décision séparée), puis T2 → P5 T2, puis run naturel | écriture                 |

Les étapes 5 et 6 peuvent s'enchaîner dans la même fenêtre, avec un GO chacune. L'étape 7 n'a
lieu qu'après 3.

**Premier GO requis :** `GO 17.7A1-MIGRATION`, précédé du préflight relancé.
