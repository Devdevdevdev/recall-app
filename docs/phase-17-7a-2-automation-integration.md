# Phase 17.7a-2 — Intégration des vérifications produit dans l'automation (implémentation locale)

**Statut :** implémenté et vérifié **localement uniquement**. **Pas prêt pour la production.**

**Ce qui n'a pas été fait :** aucune écriture production, aucune migration distante, aucun
deploy, aucun secret, aucun cron, aucun commit, aucun push. **Lectures production (lecture
seule) :** `list_edge_functions` et `get_edge_function run-recall-automation`, le 2026-10-03,
pour établir la baseline du §1.

**Base :** `HEAD c254ccb809cfc4e4e9bcfde1eaea6f86d55a6975` (F-4 fermée en production, 17.7a-1
locale et non installée).

## 1. Audit de `run-recall-automation`

### Baseline production

| Élément                     | Valeur                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Version                     | **v14**, `verify_jwt = false`                                                                                               |
| `ezbr_sha256`               | `42d8a0dceaff3f2c09be2604c94a8f12d2108331af27189f2469653bffb659b5`                                                          |
| `updated_at`                | 2026-10-01 04:43:33.092 UTC : c'est le deploy Gate A3. Les versions 12 à 14 n'ont changé ni le bundle ni l'`ezbr` (Gate E). |
| Fichiers runtime            | 6 : `_shared/automation/{index,orchestrator,request}.ts`, `run-recall-automation/{index,children,store}.ts`                 |
| Fichier type-only           | `_shared/automation/types.ts` (effacé au bundle)                                                                            |
| Arbre runtime (méthode F-4) | **`37a79b95bf01bb37d7af54d0c0337fc981c63ff2f5dd2adb74092196fafda515`** (`sha256` de la liste triée `sha  path`)             |

### Divergence dépôt / production

**Aucune.** Les 6 fichiers runtime sont identiques octet pour octet dans trois sources :

- le contenu relu en production (`get_edge_function`, v14) ;
- l'archive post-deploy A3 (`audits/phase-16-34-gate-a3/post-deploy/run-recall-automation`) ;
- `releases/phase-16-34-gate-a` et `HEAD c254ccb`.

F-4 et 17.7a-1 n'ont touché aucun fichier de cet arbre.

### Dépendances réelles

L'arbre importe seulement `npm:@supabase/supabase-js@2` et ses propres modules. Il n'importe
ni matching, ni `productCheck`, ni IA. 17.7a-2 conserve cette propriété : le worker produit est
appelé **par HTTP**, sans import, et l'arbre cible passe `deno check` **isolé** (7 fichiers
seulement).

### Arbre de deploy contrôlé

Le futur deploy se construit avec `scripts/stage-17-7a-2-automation-bundle.mjs <deployed.json> <out>`.
Le script :

1. refuse le bundle s'il n'est pas exactement l'arbre v14 `37a79b95…` ;
2. remplace seulement les 5 fichiers runtime 17.7a-2 ;
3. garde `request.ts` à l'octet près, depuis la production ;
4. ajoute `types.ts` ;
5. refuse tout chemin `productCheck`, matching, `process-*`, `cpsc`, `push` ou `nebius`.

| Arbre                        | SHA-256 runtime                                                    |
| ---------------------------- | ------------------------------------------------------------------ |
| Production v14 (rollback)    | `37a79b95bf01bb37d7af54d0c0337fc981c63ff2f5dd2adb74092196fafda515` |
| **Cible 17.7a-2** (worktree) | `96875b00ba96b3721f43c48a98e1f9912fb41196f417e111f466d44de5455e57` |

Fichiers remplacés : `_shared/automation/index.ts` (`5901cec0…`), `orchestrator.ts`
(`dccbbd17…`), `run-recall-automation/children.ts` (`6470b2bc…`), `index.ts` (`392f2163…`) et
`store.ts` (`04f50c6d…`). Le mode `--as-deployed` reconstruit la v14 inchangée, ce qui sert de
source de rollback.

## 2. Point d'insertion

L'ordre retenu est celui demandé, **validé dans le code** :

```text
claim run (bail)
→ ingestion            (inchangée)
→ matching existant    (inchangé, v23 / F-4)
→ product checks       (17.7a-2, une seule fois par run)
→ notifications        (inchangées, seulement sur le chemin succès comme avant)
→ completeRun
```

**Pourquoi cet ordre :**

- **Avant les notifications.** Une alerte confirmée par le chemin produit (porte `eligible`
  seulement) est poussée dans le même run, et non 6 h plus tard.
- **Après l'ingestion et le matching.** Le stage lit seulement des avis déjà stockés. Il
  bénéficie donc des avis ingérés par ce run sans jamais les retarder.

**Le code réel impose un ajustement.** L'orchestrateur Phase 12/16.33 sort tôt (`return`) sur
cinq chemins partiels ou en échec :

- ingestion ;
- lecture des avis en attente ;
- matching incomplet ;
- matching en erreur ;
- source partiellement en panne (cas actuel de CPSC 502).

Un stage placé seulement « entre matching et push » serait sauté à chaque 502 CPSC, alors que
c'est précisément le filet de reprise durable. L'orchestrateur passe donc par un unique
`finish()` qui exécute le stage produit (mémoïsé, une fois) **avant chaque `completeRun`**.

- **Chemin succès :** product checks → push → complete.
- **Chemins partiels ou échec :** product checks → complete. Il n'y a pas de push, exactement
  comme avant.

Le stage tourne même si l'ingestion échoue : il ne dépend pas d'elle. Les runs non réclamés
(`skipped_disabled`, `already_running`) n'exécutent rien et ne lisent même pas le flag.

**Ce qui ne change pas :** tous les statuts, `errorStep` et `errorCode` existants, les arguments
de chaque enfant et le moment du push. Les suites Phase 12, 14 et 16.33 passent **sans
modification**.

## 3. Feature flag

Le flag est `private.recall_automation_control.product_check_enabled`, introduit par 17.7a-1
(défaut `false`). Il n'est **jamais** modifié par 17.7a-2.

**Lecture :**

- par la nouvelle RPC `get_recall_automation_product_check_plan(run_id, lease_token)` (§13) ;
- liée au bail du run, en lecture seule, accessible au seul `service_role` ;
- une valeur absente, non booléenne ou une erreur donne un stage `failed` /
  `product_check_plan_unavailable` : **le worker n'est pas appelé** (fail closed).

**Flag `false` (comportement de référence, testé) :**

- 0 appel au worker, 0 claim, 0 modification de tâche ;
- résumé `productCheck.status = "disabled"`, `enabled: false`, `attempted: false` ;
- statut, étapes, push et `completeRun` identiques à un run sans stage, sur les 6 chemins
  (succès, ingestion, pending, matching, source partielle, push).

**Seules différences observables :**

- une lecture RPC de plus ;
- un champ `productCheck` dans la réponse JSON et dans le log.

**Défense en profondeur :** même appelé, `claim_due_owned_product_recall_checks` ne réclame rien
quand le flag est `false` (17.7a-1).

## 4. Budgets

| Budget                | Valeur                                                                              | Source                                                         |
| --------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Produits par run      | **3**                                                                               | constante `PRODUCT_CHECK_MAX_PRODUCTS_PER_RUN` (orchestrateur) |
| Candidats par produit | `max_product_check_candidates` (défaut 25, borné 1..100)                            | contrôle 17.7a-1, réutilisé                                    |
| Temps par produit     | 20 s                                                                                | worker 17.7a-1 (`WORKER_PRODUCT_TIME_BUDGET_MS`)               |
| Timeout HTTP du stage | **75 s**                                                                            | `PRODUCT_CHECK_TIMEOUT_MS` (children)                          |
| Limite globale        | le stage **ne démarre pas** si le run a déjà consommé plus de **60 s** → `deferred` | `PRODUCT_CHECK_LATEST_START_MS`                                |
| Bail tâche / bail run | 120 s / 1800 s                                                                      | inchangés                                                      |

**Aucun nouveau réglage en base.** Le budget par run est une constante : le modifier demande
une revue et un deploy, ce qui est voulu pour un petit budget initial.

**Coût maximal ajouté à un run : 75 s.** Un run naturel dure environ 4,5 s (Gate B), donc le
cas `deferred` reste exceptionnel. Un report n'est pas une panne : les tâches restent dues.

**Débit :** 3 produits toutes les 6 h, soit 12 par jour. C'est un **filet** : la première
vérification vient de l'app, en immédiat, via `check-owned-product`.

## 5. Invocation du worker

| Option auditée                                      | Verdict                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `RECALL_AUTOMATION_KEY`                             | exclue (consigne ; clé d'appel de l'automation, retirée de Vault en 16.34)                                                            |
| Ticket DB 16.33                                     | à usage unique, consommateur figé `run-recall-automation` ; l'étendre demanderait une migration et un changement du worker            |
| Clé service-role en Bearer                          | exclue : elle ferait circuler sur HTTP un privilège plus large que nécessaire                                                         |
| Import en processus de `_shared/productCheck`       | exclu : il embarquerait les bibliothèques v2 dans l'arbre automation, qui ne serait plus minimal, et partagerait l'isolat et le temps |
| **`x-recall-matching-key` / `RECALL_MATCHING_KEY`** | **retenu**                                                                                                                            |

**Pourquoi la clé matching :**

- l'automation la détient **déjà** et l'envoie déjà à `process-recall-matches` ;
- le worker `process-owned-product-checks` l'exige **déjà** depuis 17.7a-1, avec une comparaison
  à temps constant ;
- même domaine de confiance (matching serveur → serveur) ;
- **aucune nouvelle clé, aucun nouveau secret** : les variables lues par `index.ts` sont
  exactement celles de la v14 (testé) ;
- aucune fonction n'est exposée à `authenticated` ;
- F-4 n'est pas touchée.

**Corps envoyé :** `{ "maxProducts": 3 }`. Le worker n'est **pas modifié** : ses empreintes sont
figées par le test.

## 6. Résultat structuré du stage

`AutomationRunResult.productCheck` contient seulement des compteurs, jamais un identifiant :

```text
status (disabled | deferred | completed | failed), enabled (bool | null si flag illisible),
attempted, maxProducts, claimed, completed, continued, rearmed, staleLeases,
possibleMatches, confirmedAlerts, retrying, failed (= exhausted), durationMs, errorCode
```

**Validation stricte de la réponse du worker.** Tout écart donne `invalid_child_response` :

- exactement ses 12 compteurs ;
- des entiers ≥ 0 ;
- `aiCalls === 0` ;
- `claimed ≤ maxProducts` ;
- `completed + continued + retrying + exhausted + rearmed + staleLeases === claimed` ;
- `alertsCreated ≤ confirmed`.

**Log `recall_automation_run_complete` :** il ajoute `matchingInvoked` et un sous-objet
`productCheck` (statut, compteurs, `durationMs`, `errorCode`). Il ne contient ni `runId` ni
aucun identifiant de produit, d'utilisateur ou d'avis (testé).

## 7. Isolation des pannes

| Situation                                | Stage                                      | Run                                                                  | Tâches                                                                                                       |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Flag `false`                             | `disabled`                                 | inchangé                                                             | intactes                                                                                                     |
| Flag illisible / erreur DB / bail perdu  | `failed`, `product_check_plan_unavailable` | `partial_success` si le run était `success`, sinon inchangé          | intactes (aucun appel)                                                                                       |
| Flag `true`, 0 tâche                     | `completed`, `claimed 0`                   | `success`                                                            | —                                                                                                            |
| Worker indisponible                      | `failed`, `child_unavailable`              | `partial_success` / `product_check`                                  | aucune réclamée, ou bail 120 s puis reprise                                                                  |
| Timeout (75 s)                           | `failed`, `child_timeout`                  | idem                                                                 | bail 120 s, puis reprise par `claim_due` ; 8e expiration → `failed`, retentée sous 24 h ; aucune suppression |
| HTTP 401 / 403 / 500 / 502               | `failed`, `child_http_<code>`              | idem ; aucun retry dans le run                                       | idem                                                                                                         |
| Réponse invalide, IA signalée, sur-claim | `failed`, `invalid_child_response`         | idem                                                                 | le worker a déjà complété ses tâches de façon durable                                                        |
| Tâches `retrying` / `exhausted`          | `completed`, compteurs visibles            | `success` (la reprise est durable)                                   | backoff 17.7a-1                                                                                              |
| Run trop long (> 60 s)                   | `deferred`                                 | inchangé                                                             | restent dues                                                                                                 |
| Panne produit + erreur antérieure        | `failed`                                   | **la première erreur est conservée** (`failed` ingestion, matching…) | —                                                                                                            |

**Règles garanties (tests E à J) :**

- le stage ne lève jamais d'exception, donc `completeRun` est toujours atteint ;
- il ne rend jamais un run `failed` ;
- il n'annule pas l'ingestion, déjà persistée avant lui ;
- il ne bloque pas le push ;
- il ne déclenche ni fallback v1, ni IA, ni alerte hors porte 17.7a-1.

`error_step = 'product_check'` est accepté par `complete_recall_automation_run` (texte libre, sans
contrainte). La panne est donc **durablement visible** dans `private.recall_automation_runs`.

## 8. Cron et cadence

- **Aucun nouveau cron** (testé côté migration, orchestrateur et pgTAP `cron.job`).
  `recall-automation-every-6h` (`17 */6 * * *`, tickets 16.33) reste l'unique scheduler Recall.
- L'app garde son chemin immédiat : création du produit, puis `check-owned-product`. Le cron
  n'est qu'un filet de reprise durable : l'utilisateur n'attend pas 6 h pour sa première
  vérification.

## 9. Première observation réelle v23 (préparée, non déclenchée)

`firstRealCandidateInvocationObserved` reste `false`. Aucune paire artificielle n'a été créée.

**Le chemin produit n'appelle pas `process-recall-matches`.** Il exécute le chemin déterministe
ciblé de `process-owned-product-checks`. La v23 n'est appelée que par l'étape matching du run,
quand des avis sont en attente.

**Pour un futur produit de test réel, l'observabilité suffit désormais, en lecture seule :**

- **Log automation :** `matchingInvoked` (v23 appelée ou non), `productCheck.status`,
  `attempted`, `claimed`, `possibleMatches`, `confirmedAlerts`, `errorCode` (par exemple
  `child_http_500` pour un statut HTTP du worker).
- **Logs Edge (`function_edge_logs`) :** une ligne par appel de `process-recall-matches` et de
  `process-owned-product-checks`, avec version, statut HTTP et durée. Une erreur
  d'import ou de démarrage y apparaît comme un `5xx` au boot (et `child_http_5xx` côté
  automation).
- **Run en base :** `status`, `error_step = 'product_check'` le cas échéant.
- **Confirmations :** le chemin produit écrit seulement par les RPC v2 existantes
  (`finalize_recall_match_evaluation_v2`, puis `create_recall_v2_alert`). Une confirmation n'est
  possible que si la porte est `eligible`. L'inventaire F-4 reste la vérification de
  non-confirmation unsafe.

## 10. F-1

**Non traitée ici** (suivi séparé). Le stage n'utilise pas l'IA :

- `maxAiEscalations` du matching reste gouverné par le contrôle existant ;
- le worker doit déclarer `aiCalls: 0`, sinon sa réponse est refusée ;
- aucun import IA dans l'arbre automation.

## 11. Tests

| Fichier                                                                  | Contenu                                                                                                                                                                                                                                                                              | Résultat  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `tests/phase-17-7a-2-automation.test.mjs` (Node)                         | A à Q : référence `disabled` sur 6 chemins, budget et sur-claim, report, E/F/G/H, erreur DB, plan malformé, retrying/exhausted, I/J, ordre K, push inchangé, runs non réclamés, absence d'identifiants, M, clé, L, migration, N/P (empreintes), O, baseline v14, arbre cible, stager | **40/40** |
| `tests/phase-17-7a-2-automation-children.test.ts` (Deno)                 | frontière HTTP réelle (`fetch` simulé) : URL, en-tête matching seul, corps ; 401/403/500/502 ; indisponible ; timeout ; 11 réponses invalides (dont non-JSON) ; trop grande ; lecture du flag fail closed                                                                            | **7/7**   |
| `supabase/tests/phase-17-7a-2-automation-product-check-plan.sql` (pgTAP) | forme `SECURITY DEFINER` / `search_path` ; privilèges ; défaut `false` ; refus sans bail, mauvais jeton, mauvais run, bail expiré ; valeur ; **aucun effet de bord** (tâches, événements, runs, bail, contrôle) ; aucun cron ; aucune écriture                                       | **16/16** |

**Test 17.7a-1 mis à jour** (`phase-17-7a-1-product-check.test.mjs`) : les empreintes figées de
`orchestrator.ts`, `run-recall-automation/index.ts` et `children.ts` prennent les versions
17.7a-2, avec un commentaire, comme pour le précédent F-4. La baseline production reste figée
dans le test 17.7a-2.

**Limite :** il n'y a pas de test HTTP de bout en bout. Il faudrait servir l'automation avec ses
enfants d'ingestion, qui appellent les API officielles externes. La chaîne est couverte par
morceaux : orchestrateur, frontière HTTP, store, RPC pgTAP, et le worker par le test HTTP réel
17.7a-1.

## 12. Non-régression

| Validation                                              | Résultat                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `supabase db reset --local --no-seed`                   | OK, **35 migrations** (33 production + 17.7a-1 + 17.7a-2)                                     |
| `npm run check:all`                                     | **PASS** (exit 0)                                                                             |
| Node (`test:node`)                                      | **545/545**                                                                                   |
| Deno (`test:deno`)                                      | **28/28**                                                                                     |
| pgTAP (`test:database`)                                 | **26 fichiers, 2655 tests, PASS**                                                             |
| `npm run test:phase-16-33:rehearsal`                    | **22/22** (35 migrations)                                                                     |
| `deno check` des 10 fonctions et de l'arbre cible isolé | OK                                                                                            |
| `tsc`, ESLint, Prettier, benchmarks figés               | OK                                                                                            |
| Phase 12 / 14 / 16.33 automation                        | vertes **sans modification**                                                                  |
| F-4, 17.7a-R1, 17.7a-1                                  | vertes ; F-4, la porte, les deux workers et les migrations F-4/17.7a-1 inchangés (empreintes) |
| Artefacts figés Phase 16                                | intacts (`releases/`, `benchmarks/`, `supabase/tests/phase-16-*` non modifiés)                |
| `git diff --check`                                      | propre                                                                                        |
| Scan de secrets                                         | 0 occurrence ; les tests n'utilisent que des valeurs factices                                 |
| Les tests ne modifient pas l'arbre                      | vérifié (`git status` identique avant et après)                                               |

**Fichiers modifiés :**

- les 6 fichiers de l'arbre automation (dont `types.ts`) ;
- `package.json` (script `test:phase-17-7a-2`) ;
- `tsconfig.json` (exclusion du test Deno, comme les autres) ;
- le test 17.7a-1.

**Fichiers ajoutés :**

- la migration ;
- le pgTAP ;
- les 2 tests ;
- le script de staging ;
- ce document.

## 13. Migration

**Une migration est nécessaire** : `20261003090000_phase_17_7a_2_automation_product_check_plan.sql`.
Aucune RPC existante n'expose le flag à l'automation, et `private` n'est pas accessible par
l'API. Sans cette migration, la seule façon de connaître le flag serait d'appeler le worker, ce
que la règle « flag `false` → 0 appel » interdit.

**Propriétés :**

- additive ;
- postérieure à `20261002120000` ;
- **une seule fonction**, `stable`, `SECURITY DEFINER`, `search_path = ''` ;
- liée au bail vivant ;
- `service_role` seulement ;
- aucune table, aucune colonne, aucun réglage, aucun `UPDATE`, aucun cron ;
- elle ne touche pas au flag.

**Rollback :** inutile, la fonction est inerte. Si besoin, une migration avant `drop function`
la retire.

## 14. Stratégie de release (préparée, non exécutée)

Chaque étape demande un GO explicite. **Aucune activation implicite.**

1. **Installer 17.7a-1** (migration `20261002120000`), depuis un arbre de staging. `GO 17.7a-1-DB`.
2. **Installer 17.7a-2** (migration `20261003090000`), **avant** le deploy automation. Sinon la v14
   reste correcte, mais la future automation ferait `product_check_plan_unavailable` →
   `partial_success`. `GO 17.7a-2-DB`.
3. **Vérifier la base** en lecture seule :
   - 35 migrations ;
   - `product_check_enabled = false` ;
   - privilèges des RPC ;
   - inventaire F-4 = 0 ;
   - aucun cron ajouté ;
   - suite remote avec rollback.
4. **Deploy `check-owned-product` et `process-owned-product-checks`**, `verify_jwt = false`,
   sans nouveau secret (`RECALL_MATCHING_KEY` existe déjà). Avec le flag `false`, ils répondent
   `disabled` / 0 claim. `GO 17.7a-1-EDGE`.
5. **Deploy de l'automation 17.7a-2 depuis l'arbre minimal :**
   - relire le bundle (`get_edge_function`) et confirmer la v14 `37a79b95…` ;
   - `node scripts/stage-17-7a-2-automation-bundle.mjs <deployed-v14.json> "$SCR/a2-stage" <commit>`
     doit afficher `96875b00…` ;
   - `npx supabase functions deploy run-recall-automation --no-verify-jwt --workdir "$SCR/a2-stage"`.

   `GO 17.7a-2-EDGE`.

6. **`product_check_enabled` reste `false`.**
7. **Vérification distante** (lecture seule) :
   - fichier par fichier, arbre `96875b00…` ;
   - les autres fonctions inchangées ;
   - premier run naturel : `productCheck.status = "disabled"`, mêmes statut et étapes qu'avant,
     aucun appel à `process-owned-product-checks` dans les logs Edge.
8. **Test contrôlé utilisateur** (flag toujours `false`, app en mode surveillance).
9. **Seulement ensuite**, décision séparée d'activer le flag (`GO PRODUCT-CHECK-ENABLE`).

**Rollback Edge :** `--as-deployed` reconstruit la v14 `37a79b95…`.

**Rollback fonctionnel :** remettre `product_check_enabled = false`, ce qui coupe immédiatement le
stage et le chemin app.

## 15. Prochaine étape recommandée

Revue de ce diff local, puis commit. Ensuite, un plan d'installation contrôlée 17.7a-1 + 17.7a-2
(étapes 1 à 7 du §14) avec un GO par étape. Le flag reste `false` jusqu'à une décision séparée,
après le test utilisateur contrôlé.
