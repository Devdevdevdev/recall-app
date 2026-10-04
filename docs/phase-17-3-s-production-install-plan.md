# Phase 17.3-S — Canonical GTIN equivalence — Plan d'installation production

Statut : **revue de release terminée, rien exécuté**. Aucune production, migration distante,
deploy, push, secret, cron ni flag.
Base : `main` @ `07821592c280648be1a056b0dd27634894c5d8c4` (= `origin/main`), arbre de travail
non commité. Implémentation : `docs/phase-17-3-s-gtin-equivalence-implementation.md`.

**Règle d'exécution :** chaque écriture production exige un « GO » explicite et séparé. Les
lectures production sont faites sans GO, en lecture seule, sans donnée personnelle.

| Constat                          | Statut                                             |
| -------------------------------- | -------------------------------------------------- |
| D1 — UPC-E réel rejeté           | **CONFIRMED** — non corrigé dans l'app avant 17.3a |
| D2 — représentation iOS          | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE** |
| Défaut d'équivalence indépendant | **CONFIRMED** — corrigé par 17.3-S                 |

## 0. Vue d'ensemble

| #   | Étape                                                     | Écriture production   | GO                                           |
| --- | --------------------------------------------------------- | --------------------- | -------------------------------------------- |
| 0   | Commit local de l'arbre revu                              | non                   | `GO 17.3S-COMMIT`                            |
| 1   | Préflight (lecture seule) + snapshot des bundles déployés | non                   | —                                            |
| 2   | Edge `process-owned-product-checks` (v1 → v2)             | **oui**               | `GO 17.3S-EDGE-PROCESS-OWNED-PRODUCT-CHECKS` |
| 3   | Edge `check-owned-product` (v1 → v2)                      | **oui**               | `GO 17.3S-EDGE-CHECK-OWNED-PRODUCT`          |
| 4   | Edge `process-recall-matches` (v23 → v24)                 | **oui**               | `GO 17.3S-EDGE-PROCESS-RECALL-MATCHES`       |
| 5   | Migration `20261004090000`                                | **oui**               | `GO 17.3S-MIGRATION`                         |
| 6   | Suite pgTAP 17.3-S distante (transaction annulée)         | **oui** (transitoire) | `GO 17.3S-REMOTE-VERIFY`                     |
| 7   | Régression production (lecture seule, run naturel)        | non                   | `GO 17.3S-PRODUCTION-REGRESSION`             |
| 8   | Enregistrement de vérification + commit de fermeture      | non (local)           | GO commit local                              |
| R   | Rollback (seulement si nécessaire)                        | **oui**               | `GO 17.3S-ROLLBACK`                          |

**L'ordre Edge → migration est obligatoire (§6).**
`process-recall-matches-v2-cohort` n'est **pas** dans le set (§4.3).

## 1. Revue du diff

21 fichiers : les 19 de l’implémentation, plus 2 ajoutés par cette revue (le rollback gated et ce plan). Aucun fichier inattendu.

| Fichier                                                                          | Statut         | Classe             |
| -------------------------------------------------------------------------------- | -------------- | ------------------ |
| `supabase/functions/_shared/matching/gtin.ts`                                    | ajouté         | A                  |
| `supabase/functions/_shared/matching/candidateRetrieval.ts`                      | modifié        | A                  |
| `supabase/functions/_shared/matching/evidence.ts`                                | modifié        | A                  |
| `supabase/functions/_shared/matching/criterionEvaluatorV2.ts`                    | modifié        | A                  |
| `supabase/functions/_shared/matching/nemotronSafetyVerifier.ts`                  | modifié        | A                  |
| `supabase/migrations/20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql` | ajouté         | B                  |
| `supabase/gated-migrations/20261004090100_phase_17_3_s_rollback.sql`             | ajouté (revue) | B (rollback gated) |
| `supabase/tests/phase-17-3-s-canonical-gtin.sql`                                 | ajouté         | C                  |
| `tests/phase-17-3-s-gtin-equivalence.test.mjs`                                   | ajouté         | C                  |
| `tests/fixtures/phase-17-3-s-gtin-vectors.json`                                  | ajouté         | C                  |
| `tests/phase-17-7a-1-product-check.test.mjs` (empreintes `FROZEN`)               | modifié        | C / D              |
| `tests/phase-17-7a-2-automation.test.mjs` (gate de migration)                    | modifié        | C                  |
| `benchmarks/recall-matching/phase-9-1/holdout-manifest.json`                     | modifié        | D                  |
| `benchmarks/recall-matching/phase-15/freeze-manifest.json`                       | modifié        | D                  |
| `benchmarks/recall-matching/phase-16/freeze-manifest.json`                       | modifié        | D                  |
| `benchmarks/recall-matching/phase-17-3-s-refreeze.json`                          | ajouté         | D                  |
| `docs/phase-17-3-product-identity-design.md`                                     | ajouté         | E                  |
| `docs/phase-17-3-s-gtin-equivalence-investigation.md`                            | ajouté         | E                  |
| `docs/phase-17-3-s-gtin-equivalence-implementation.md`                           | ajouté         | E                  |
| `docs/phase-17-3-s-production-install-plan.md` (ce document)                     | ajouté         | E                  |
| `.prettierignore` (exclusion du fixture de vecteurs)                             | modifié        | F                  |

Classes : A runtime, B migration, C test, D manifest de gel / preuve de re-gel,
E documentation, F tooling.

Les diffs runtime ne touchent que les comparaisons GTIN et l'import de `gtin.ts`
(T1 : 1 prédicat ; T2 : 1 comparaison et 1 libellé conditionnel ; T3 : `equals` et `one_of`
via `sameValue` ; T4 : 1 comparaison).

## 2. Gate 17.7a-2

Ancienne assertion : `assert.equal(migrations.at(-1), '20261003090000_…automation_product_check_plan.sql')`.
Elle échouait mécaniquement dès qu'une migration, quelle qu'elle soit, était ajoutée.

Nouvelle logique :

1. la migration 17.7a-2 doit exister ;
2. la liste exacte des migrations qui la suivent doit être
   `['20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql']` (ni `>=`, ni préfixe) ;
3. chaque migration autorisée est liée à son SHA-256 revu (`d58d8438…`) ;
4. l'ordre 17.7a-1 < 17.7a-2 est conservé, ainsi que toutes les autres assertions de contenu.

Mutations vérifiées dans une copie isolée : baseline PASS ; migration inconnue ajoutée après
**FAIL** ; migration inconnue insérée entre 17.7a-2 et 17.3-S **FAIL** ; contenu 17.3-S altéré
**FAIL** ; 17.3-S renommée **FAIL** ; restauration PASS. Le gate est **plus strict** qu'avant :
`at(-1)` n'empêchait ni une insertion intermédiaire ni une substitution de contenu.

## 3. Sécurité et performance SQL

### 3.1 `private.canonical_gtin14(text)`

Catalogue local :

| Propriété    | Valeur                                                              |
| ------------ | ------------------------------------------------------------------- |
| volatilité   | `IMMUTABLE`                                                         |
| `STRICT`     | oui                                                                 |
| droits       | `SECURITY INVOKER` (pas de `SECURITY DEFINER`)                      |
| parallélisme | `PARALLEL SAFE`                                                     |
| langage      | `sql`                                                               |
| config       | `search_path=""`                                                    |
| signature    | `(p_value text) → text`                                             |
| owner        | `postgres`                                                          |
| ACL          | `postgres`, `authenticated`, `service_role` ; ni `PUBLIC` ni `anon` |

Le corps ne contient ni SQL dynamique, ni `EXECUTE`, ni `format`, ni lecture de table. Il ne
contient que des fonctions `pg_catalog` et `generate_series`.

**Pourquoi EXECUTE à `authenticated` et `service_role`.** Une expression d'index est évaluée
lors de chaque `INSERT` ou `UPDATE` de la ligne indexée, avec les droits du rôle qui écrit. Le
contrôle `EXECUTE` s'applique à ce rôle. L'app écrit `owned_products` en `authenticated` ;
l'ingestion et les workers écrivent en `service_role`. Sans ce grant, un insert de l'app
échoue : `permission denied for function canonical_gtin14`, reproduit localement avant le
correctif.

**Aucun accès induit.** Aucun rôle d'API n'a `USAGE` sur le schéma `private` (vérifié local et
production). Le grant ne donne accès à aucune table et ne permet même pas d'appeler la fonction
par son nom. Vérifié par pgTAP (64 assertions) :

- `authenticated` insère un produit avec un GTIN à 13 chiffres → `ok` ;
- valeur brute stockée telle quelle, index canonique `00091021037090` ;
- `authenticated` lit `private.owned_product_recall_checks` → `42501` ;
- `authenticated` lit `private.recall_automation_control` → `42501` ;
- `authenticated` appelle `private.canonical_gtin14` → `42501` ;
- `anon` appelle `private.canonical_gtin14` → `42501`.

### 3.2 Index et plans

| Index                                 | Table            | Expression                         | Prédicat                 |
| ------------------------------------- | ---------------- | ---------------------------------- | ------------------------ |
| `owned_products_canonical_gtin14_idx` | `owned_products` | `(private.canonical_gtin14(gtin))` | `WHERE gtin IS NOT NULL` |
| `recall_scopes_canonical_gtin14_idx`  | `recall_scopes`  | `(private.canonical_gtin14(gtin))` | `WHERE gtin IS NOT NULL` |

`EXPLAIN` local sur les corps exacts des RPC : 3 000 notices, 30 001 scopes et 20 001 produits,
`ANALYZE`, transaction annulée.

- **`get_owned_product_recall_candidates`** : la branche canonique utilise naturellement
  `Index Scan using recall_scopes_canonical_gtin14_idx`, avec
  `Index Cond: (private.canonical_gtin14(gtin) = product_1.gtin14_key)`. Le seul seq scan est
  la branche nom de produit (tsvector), préexistante.
- **`get_recall_candidates`** : SubPlan 1 (rang 4) fait
  `BitmapOr(recall_scopes_normalized_gtin_idx, recall_scopes_canonical_gtin14_idx)` sous
  `BitmapAnd` avec `recall_scopes_recall_notice_id_idx`. Le seq scan sur `owned_products` est
  structurel : produit × rappel par `join … on true`. Il est **identique au plan HEAD**, vérifié
  sur le même volume avec le corps d'origine.
- Aucun seq scan n'est causé par l'expression canonique. Le classement (`CASE … 4/3/2/1`) est
  inchangé. Le produit à 13 chiffres retrouve le scope à 12 chiffres au rang 4 dans les deux
  sens.

## 4. Edge Functions

### 4.1 Matrice (graphe `deno info`, local HEAD vs cible, et bundle déployé via `get_edge_function`)

| Fonction                           | Version prod | Fichiers 17.3-S dans le bundle déployé                                     | Fichiers 17.3-S dans la closure cible | `gtin.ts` | Arbre runtime change | Prod = HEAD                   |
| ---------------------------------- | ------------ | -------------------------------------------------------------------------- | ------------------------------------- | --------- | -------------------- | ----------------------------- |
| `check-owned-product`              | v1           | candidateRetrieval, criterionEvaluatorV2, evidence                         | idem + gtin                           | runtime   | **oui**              | oui                           |
| `process-owned-product-checks`     | v1           | candidateRetrieval, criterionEvaluatorV2, evidence                         | idem + gtin                           | runtime   | **oui**              | oui                           |
| `process-recall-matches`           | v23          | candidateRetrieval, criterionEvaluatorV2, evidence, nemotronSafetyVerifier | idem + gtin                           | runtime   | **oui**              | **non** (dérive préexistante) |
| `process-recall-matches-v2-cohort` | v11          | candidateRetrieval, criterionEvaluatorV2, evidence                         | idem + gtin                           | runtime   | oui (dormant)        | **non** (dérive préexistante) |
| `run-recall-automation`            | v15          | aucun                                                                      | aucun                                 | non       | non                  | —                             |
| `send-recall-notifications`        | v16          | aucun                                                                      | aucun                                 | non       | non                  | —                             |
| `ingest-cpsc-recalls`              | v26          | aucun                                                                      | aucun                                 | non       | non                  | —                             |
| `ingest-recall-source`             | v15          | aucun                                                                      | aucun                                 | non       | non                  | —                             |
| `ingest-recall-sources`            | v12          | aucun                                                                      | aucun                                 | non       | non                  | —                             |
| `process-cpsc-page-evidence`       | v12          | aucun                                                                      | aucun                                 | non       | non                  | —                             |

Les six fonctions sans impact ont été vérifiées des deux côtés : graphe local (HEAD et cible) et
liste des fichiers du bundle déployé.

**Dérive préexistante** (`process-recall-matches`, `-v2-cohort`) : les fichiers déployés
`orchestratorV2.ts` et `reviewedCriteriaV2.ts` (et `process-recall-matches/store.ts` pour le
cohort) diffèrent de HEAD. HEAD exige en plus `deterministicRuleSetsV2.ts` et `ruleSetsV2.ts`,
absents en production. C'est cohérent avec le précédent F-4 (v23 stagée depuis les octets
déployés). Ces fonctions **ne doivent jamais** être déployées depuis l'arbre du dépôt : cela
livrerait la dérive v2 en plus de 17.3-S.

### 4.2 Arbres cibles (octets déployés + 17.3-S uniquement)

Arbre = SHA-256 de la liste triée `sha256(fichier)  chemin` (même définition que
`scripts/stage-17-7a-edge-bundles.mjs`).

| Fonction                                     | Arbre déployé | Arbre cible | Fichiers | Changements vs déployé                                       | `deno check` (déployé / cible) |
| -------------------------------------------- | ------------- | ----------- | -------- | ------------------------------------------------------------ | ------------------------------ |
| `check-owned-product`                        | `b029ef38…`   | `673632da…` | 17 → 18  | candidateRetrieval, criterionEvaluatorV2, evidence + gtin.ts | PASS / PASS                    |
| `process-owned-product-checks`               | `1b02f970…`   | `c68b141c…` | 17 → 18  | idem                                                         | PASS / PASS                    |
| `process-recall-matches`                     | `81ff731c…`   | `31e649e6…` | 39 → 40  | idem + nemotronSafetyVerifier                                | PASS / PASS                    |
| `process-recall-matches-v2-cohort` (différé) | `62cbe427…`   | `67d7074b…` | 14 → 15  | candidateRetrieval, criterionEvaluatorV2, evidence + gtin.ts | PASS / PASS                    |

Préconditions vérifiées avant patch :

- chaque fichier remplacé a, en production, exactement les octets de HEAD ;
- `normalization.ts` (dépendance de `gtin.ts`) est identique à HEAD.

Les modules type-only absents des bundles ne sont ajoutés que pour `deno check`, depuis HEAD ; ils
sont effacés au bundling. Arbres cibles complets :

- `673632dae91a7a729b482b1a6b8251fc12d0217a461ca69a5572bcfe5f20cd18`
- `c68b141c416b758a08a471438d9146f5f85e28103fc16d12800b2e705379d295`
- `31e649e6f63660feb388d3f8a6fac3f13ebaef43585043bce308f8c4447072c7`
- différé : `67d7074beb938066475c21ba5f2c9222638edbd79314f52fd220d1f783e3d150`

### 4.3 Set minimal

**À déployer** (les trois sont actifs et voient leur arbre runtime changer) :

- `process-owned-product-checks` ;
- `check-owned-product` ;
- `process-recall-matches`.

**Ne pas déployer** :

- Les six fonctions sans changement.
- `process-recall-matches-v2-cohort`, bien que son arbre change. C'est un endpoint manuel,
  désactivé par défaut (`RECALL_V2_COHORT_ENABLED`), sans cron, sans appelant. Les 8 tables v2
  sont vides en production, et il ne crée jamais d'alerte consommateur. Le laisser sur v11
  conserve le comportement actuel (égalité brute, faux négatifs uniquement) et évite de toucher
  une fonction dérivée.
- **Condition** : avant toute activation future du cohort v2, le restager depuis ses octets
  déployés + 17.3-S (arbre `67d7074b…`).

## 5. Migration

| Élément              | Valeur                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fichier              | `supabase/migrations/20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql` (447 lignes)                                                                                                                                                            |
| SHA-256              | `d58d8438dcf2e0358bc62fd66d067bf05e32f92c86085acd2786bced3c4407e0`                                                                                                                                                                                       |
| Objets créés         | `private.canonical_gtin14(text)` ; index `owned_products_canonical_gtin14_idx`, `recall_scopes_canonical_gtin14_idx`                                                                                                                                     |
| Fonctions remplacées | `public.get_recall_candidates(uuid,integer,uuid,integer)`, `public.get_owned_product_recall_candidates(uuid,integer,uuid,integer)` (`create or replace` : signature, type de retour, owner, ACL `service_role` et `security definer` conservés, vérifié) |
| Grants / revokes     | `revoke all … from public, anon, authenticated, service_role` puis `grant execute … to authenticated, service_role` sur la seule nouvelle fonction                                                                                                       |
| Données              | aucune : pas de DML, pas de backfill, pas de réécriture de `owned_products` ni de `recall_scopes`, pas d'alerte, pas de flag, pas de cron (test : aucun `update`, `insert`, `delete`, `alter table`, `drop` dans le code SQL)                            |
| Verrous              | `CREATE INDEX` non concurrent dans la transaction : verrou `SHARE` le temps du build. 2 produits et 130 scopes en production, donc négligeable                                                                                                           |
| Dépendances          | base distante = `20261003090000` (dernière migration distante, vérifié). Corps distants identiques au local pré-17.3-S (md5 `9a5bfe1b…` / `0bcf8890…`, md5 de tous les index `cacd23eb…`)                                                                |
| Rollback             | `supabase/gated-migrations/20261004090100_phase_17_3_s_rollback.sql`, SHA-256 `720f9723930e43cfa8e9a4d842197d8cf3fd27da91c74e6dfe0d02a7f4953edd`                                                                                                         |

**Rollback vérifié localement :**

1. `reset --version 20261003090000` ;
2. signature de référence ;
3. application de la migration ;
4. un appel « ancien runtime » aux deux RPC fonctionne ;
5. rollback.

Résultat : md5 des deux fonctions, ACL, `security definer` et md5 de tous les index publics et
privés **identiques** à la référence, sans aucun objet canonique restant.

## 6. Ordre d'installation sûr : **Edge d'abord, migration ensuite**

- **Nouveau runtime + ancien SQL : compatible.**
  - Le nouveau runtime n'appelle aucun objet nouveau (aucune référence à `canonical_gtin14`
    hors commentaire, aucun `store` modifié, mêmes RPC et mêmes signatures).
  - Dans cette fenêtre, le SQL ne retrouve pas encore les paires équivalentes par GTIN :
    comportement actuel, faux négatifs seulement.
  - Une paire retrouvée par un autre signal est jugée correctement (pas de faux rejet).
- **Ancien runtime + nouveau SQL (migration d'abord) : à éviter.**
  - Le SQL renverrait des paires équivalentes que l'ancien TS jugerait « GTIN contradictoire »
    (`rejected` 0,98) et persisterait.
  - L'empreinte v1 n'incluant pas le code (§7), ces paires resteraient figées après le deploy.
  - Risque nul aujourd'hui (inventaire = 0), mais non nul si une paire équivalente arrive
    pendant la fenêtre.
- **Rollback dans l'ordre inverse** : migration de rollback d'abord, Edge ensuite.
- Entre les trois fonctions, l'ordre est indifférent (aucune dépendance entre elles). Ordre
  proposé : worker produit, check utilisateur, puis matcher v1.

## 7. Empreintes et réévaluation

**Empreinte v1** (`recallMatching/fingerprint.ts`) — elle hache :

- la projection du produit ;
- le rappel : source, titre, description, danger, remède, date, scopes triés ;
- `sha256(raw_payload)` ;
- les constantes de policy : méthodes, `MATCH_EVALUATION_SCHEMA_VERSION`, version du prompt
  guardé, `PRODUCTION_MATCHING_POLICY_VERSION`, `modelId`.

**Elle ne hache pas le code du matcher.** `claim_recall_match_evaluation` renvoie `unchanged`
si une ligne `recall_matches` porte la même empreinte. Une paire déjà finalisée **n'est donc pas**
retraitée après 17.3-S, tant que ni le produit ni le rappel ne changent.

Les paires jamais évaluées sont évaluées normalement. **Product check** : une vérification
`complete` n'est réarmée que si le produit change ; 17.3-S ne touche pas à `matching_revision`.

**Impact production : nul**, voir l'inventaire (§8). Dette documentée séparément : le code du
matcher n'est pas une entrée de l'empreinte. Pas de correction dans 17.3-S, car elle n'est pas
nécessaire à la correction GTIN.

## 8. Inventaire production (lecture seule, 2026-10-04)

| Mesure                                    | Valeur                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `recall_matches`                          | 0 (tous statuts)                                                                 |
| `recall_match_evaluations_v2`             | 0                                                                                |
| `recall_alert_eligibility_v2`             | 0 actives, 0 révoquées                                                           |
| `recall_alert_snapshots_v2`               | 0                                                                                |
| `alerts`                                  | 0                                                                                |
| `owned_products`                          | 2 (2 avec GTIN, 13 chiffres, valides, aucun ne commence par `0`, `barcode_scan`) |
| `recall_notices`                          | 117                                                                              |
| `recall_scopes`                           | 130 (13 avec GTIN, tous 12 chiffres, tous valides)                               |
| `owned_product_recall_checks`             | 2 `complete` (révision courante)                                                 |
| paires produit × scope, égalité legacy    | 0                                                                                |
| paires produit × scope, égalité canonique | 0                                                                                |
| paires brut différent / canonique égal    | **0**                                                                            |
| scopes équivalents de chaînes différentes | 0                                                                                |

Clé canonique calculée en ligne dans un CTE (même formule que la migration), sans créer d'objet.

**Inventaire = 0 → aucun replay production n'est nécessaire.** Aucun `rejected` v1, aucun
`conflicting` v2, aucune empreinte figée, aucune alerte liée au défaut.

## 9. Re-gel

- Fichiers gelés modifiés : `evidence.ts`, `criterionEvaluatorV2.ts`,
  `nemotronSafetyVerifier.ts` (et `candidateRetrieval.ts`, épinglé seulement dans `FROZEN`).
  Seules les lignes GTIN ont changé (§1). `normalization.ts` est inchangé.
- 5 empreintes recalculées dans 3 manifests :
  - 9.1 `frozenPolicyFiles` : `evidence.ts` `89989ca2…→311284dc…`, `nemotronSafetyVerifier.ts`
    `0db1dff8…→b63f863a…` ;
  - 15 `promptPolicyArtifacts` : `evidence.ts` ;
  - 15 `historicalArtifacts` : `phase-9-1/holdout-manifest.json` `0c7d860a…→5cb57452…`
    (cascade) ;
  - 16 `implementationArtifacts` : `criterionEvaluatorV2.ts` `32c6110d…→e0265430…`.
  - Plus 3 empreintes `FROZEN` dans `tests/phase-17-7a-1-product-check.test.mjs`.
- Record : `benchmarks/recall-matching/phase-17-3-s-refreeze.json`. Un test lie chaque entrée au
  manifest et au fichier, et vérifie que les rapports Phase 15 épinglent toujours `89989ca2…`.
- **Aucun autre fichier suivi de `benchmarks/` n'a changé** : datasets, résultats, rapports
  Phase 15 et résultats 9.1/16 sont identiques octet pour octet au commit (`git diff` vide).
  Aucun fichier de policy, d'empreinte ou de prompt n'est modifié (`recallMatching/*`,
  `guardedNemotronPrompt.ts`, `types*.ts`, `normalization.ts`).
- Benchmarks déterministes rejoués dans deux copies isolées : décisions et métriques
  identiques, entre elles et avec les résultats commités. Couverts : Phase 8, 9.1 holdout,
  Phase 15 ×4, Phase 16 v2, delta v1→v2, sonde v2.1.
- Seuls `generatedAt`, `sourceGitCommit` et les latences diffèrent. Ce sont des métadonnées
  d'exécution, pas une divergence fonctionnelle.

## 10. F-4

Inchangé. Tests locaux :

- TS : la gate rend `unsupported_scope` pour un critère GTIN, seul ou avec un modèle.
- Product check P1/P2/P3 identiques et **0 alerte** pour :
  - aucune règle revue ;
  - couverture incomplète ;
  - juridiction incompatible ;
  - pays inconnu ;
  - règle lot ;
  - date fausse ;
  - date manquante ;
  - modèle faux ;
  - **règle revue GTIN seule** ;
  - **règle GTIN + modèle**.
- pgTAP : `automatic_alert_eligibility = unsupported_scope` ×3, finaliseur v1 `confirmed` →
  `needs_review|unsupported_scope|none` ×3, 0 alerte.

Avec des règles modèle + date complètes, P2/P3 alertent exactement comme P1 : l'alerte vient
de ces règles, pas du GTIN.

## 11. Portée D1 / UPC-E

17.3-S en production corrigera :

- l'équivalence 12/13/14 ;
- la génération de candidats (SQL et TS) ;
- le matching v1, v2 et le vérificateur.

Elle **ne corrigera pas** le scan UPC-E réel dans l'app : un UPC-E scanné reste rejeté par
l'app. Le câblage UPC-E (symbologie, expansion, route, UI) appartient à **17.3a**. La primitive
`expandUpcE` est prête et testée.

D2 reste **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**.

## 12. Procédure par GO

### `GO 17.3S-COMMIT`

Commit local de l'arbre revu (fichiers du §1), sans push. Vérifier `git status` vide après commit.

### Étape 1 — Préflight (lecture seule, sans GO, juste avant le premier GO production)

- `list_migrations` : dernière version `20261003090000`.
- md5 des deux RPC = `9a5bfe1b…` / `0bcf8890…` ; md5 des index = `cacd23eb…` ; aucun objet
  canonique.
- `list_edge_functions` : `process-recall-matches` v23, `check-owned-product` v1,
  `process-owned-product-checks` v1.
- `get_edge_function` des trois : arbres déployés `81ff731c…`, `b029ef38…`, `1b02f970…`.
  Toute différence → **STOP**.
- Snapshot JSON exact des trois bundles conservé pour le rollback (§13), dans
  `releases/phase-17-3-s/`.
- Inventaire §8 rejoué : toujours 0 paire équivalente.

### `GO 17.3S-EDGE-PROCESS-OWNED-PRODUCT-CHECKS`, `GO 17.3S-EDGE-CHECK-OWNED-PRODUCT`, `GO 17.3S-EDGE-PROCESS-RECALL-MATCHES`

Pour chaque fonction, l'une après l'autre :

1. Stager l'arbre cible **depuis les octets déployés** du snapshot : remplacer les fichiers 17.3-S
   (précondition : octets déployés = HEAD), ajouter `gtin.ts`, ajouter `supabase/config.toml` avec
   `verify_jwt = false`. **Jamais** l'arbre du dépôt pour `process-recall-matches`.
2. Vérifier l'arbre staged = arbre cible du §4.2, puis `deno check` PASS.
3. Deploy depuis le répertoire de staging uniquement (`supabase functions deploy <fn>
--project-ref …`).
4. Relire avec `get_edge_function` : la version incrémente de 1, `verify_jwt=false`, l'arbre
   déployé = arbre cible. Sinon → rollback Edge de la fonction (§13).

### `GO 17.3S-MIGRATION`

- Seulement après les trois deploys vérifiés.
- Arbre de staging contenant uniquement la migration (SHA `d58d8438…`), dry-run, puis push.
- Vérification lecture seule :
  - fonction et ACL comme au §3.1 ;
  - 2 index ;
  - nouveaux md5 des RPC `695243ea…` / `985de76d…` (valeurs locales) ;
  - ACL des RPC inchangées ;
  - comptes du §8 inchangés.

### `GO 17.3S-REMOTE-VERIFY`

- Suite `supabase/tests/phase-17-3-s-canonical-gtin.sql` (64 assertions), dans une seule
  transaction **annulée**.
- pgTAP n'étant pas installé en production : `create extension pgtap` à portée de transaction,
  selon la procédure habituelle (approbation explicite).
- Attendu : 64/64, puis vérifier qu'aucun objet ni aucune ligne de test ne subsiste.

### `GO 17.3S-PRODUCTION-REGRESSION` (lecture seule)

- Prochain run naturel de `run-recall-automation`, sans déclenchement manuel : `success` ou
  `partial_success` pour une raison étrangère à 17.3-S.
- `alerts`, éligibilités et snapshots v2 inchangés (0).
- Product checks sans `check_failed`.
- Aucune ligne `recall_matches` nouvelle avec un conflit GTIN entre clés canoniques égales.

### Fermeture

- `releases/phase-17-3-s/post-install-verification.json` : SHA de la migration, arbres Edge
  déployés, résultat de la suite distante.
- Mise à jour de la documentation, commit local (GO commit).

## 13. Rollback (`GO 17.3S-ROLLBACK`)

1. **SQL d'abord.** Appliquer `20261004090100_phase_17_3_s_rollback.sql` comme migration avant
   (staging, version `20261004090100`). Il restaure les corps exacts des deux RPC et supprime les
   index et la fonction. Vérifier les md5 `9a5bfe1b…` / `0bcf8890…` et l'absence d'objet
   canonique.
2. **Edge ensuite.** Redéployer les trois fonctions depuis leurs snapshots exacts (arbres
   `81ff731c…`, `b029ef38…`, `1b02f970…`). L'ancien runtime est compatible avec le SQL
   pré-17.3-S.
3. Aucune donnée n'est supprimée ni réécrite, dans aucun sens. Les décisions prises sous 17.3-S
   restent telles quelles : elles ne sont jamais re-promues automatiquement.

## 14. Release ready

**Oui, pour commencer par `GO 17.3S-COMMIT`.**

- Toutes les vérifications locales passent (§15 de la réponse de revue).
- L'inventaire production est à 0.
- L'ordre sûr, le set minimal et le rollback sont établis.

Premier GO requis : `GO 17.3S-COMMIT`. Premier GO production : `GO 17.3S-EDGE-PROCESS-OWNED-PRODUCT-CHECKS`,
précédé du préflight de l'étape 1 relancé juste avant.
