# Phase 17.3-S — Canonical GTIN equivalence — Vérification production

Statut : **CLOSED — installée et vérifiée en production le 2026-10-05**.
Commit installé : `8924ca90b52ec6efafd718fa065b5e4daf3da7ab` (« Fix canonical GTIN equivalence
across Recall matching »), égal à `origin/main`.
Plan suivi : `docs/phase-17-3-s-production-install-plan.md`. Enregistrement machine :
`releases/phase-17-3-s/post-install-verification.json`.

| Constat                          | Statut final                                               |
| -------------------------------- | ---------------------------------------------------------- |
| Défaut d'équivalence indépendant | **CONFIRMED — corrigé en production**                      |
| D1 — UPC-E réel rejeté           | **CONFIRMED** — câblage UPC-E de l'app reporté à **17.3a** |
| D2 — représentation iOS          | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**         |

D2 n'est utilisé comme preuve nulle part : 17.3-S est justifiée par le défaut d'équivalence
indépendant et par D1.

> **DO NOT ENABLE process-recall-matches-v2-cohort UNTIL ITS 17.3-S RUNTIME HAS BEEN STAGED,
> DEPLOYED AND VERIFIED.** La fonction est restée en v11 : désactivée, sans cron, sans appelant.

## 1. Chronologie (2026-10-05, UTC)

Chaque écriture production a été faite après un GO explicite et séparé, précédée d'un préflight
en lecture seule et suivie d'une vérification octet par octet.

| Heure    | Étape                                                                      | Résultat                                                              |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 06:27:42 | `GO 17.3S-PRODUCT-WORKER` : `process-owned-product-checks` v1 → **v2**     | arbre `1b02f970…` → `c68b141c…`, 4 fichiers changés, ezbr `6c924d42…` |
| 06:34:47 | `GO 17.3S-CHECK-OWNED-PRODUCT` : `check-owned-product` v1 → **v2**         | arbre `b029ef38…` → `673632da…`, 4 fichiers changés, ezbr `f0eeee9f…` |
| 06:56:22 | `GO 17.3S-PROCESS-RECALL-MATCHES` : `process-recall-matches` v23 → **v24** | arbre `81ff731c…` → `31e649e6…`, 5 fichiers changés, ezbr `4d68e4aa…` |
| 07:04:19 | `GO 17.3S-MIGRATION` : `20261004090000`                                    | 36 migrations, historique `e893f721…`                                 |
| ~07:30   | `GO 17.3S-REMOTE-VERIFY`, exécuté par l'opérateur                          | **64/64**, transaction annulée, zéro résidu                           |
| 12:17    | Premier run naturel complet (cron)                                         | `success`                                                             |
| 14:00    | `GO 17.3S-PRODUCTION-REGRESSION`                                           | **PASSED**                                                            |

Ordre retenu : Edge d'abord, migration ensuite. Avec le nouveau runtime et l'ancien SQL, le seul
risque est de manquer une paire. L'inverse aurait pu figer un faux « GTIN contradictoire ».

## 2. Edge Functions

Chaque bundle déployé a été construit à partir des **octets déjà déployés** (téléchargés via
`functions download --use-api`), avec seulement les fichiers 17.3-S du commit. Il a été relu
après le deploy et vérifié fichier par fichier. `verify_jwt=false` partout ; environnement,
auth, policy, prompts, budget IA et F-4 sont identiques octet pour octet.

| Fonction                       | Version | Arbre runtime                                                      | Fichiers | Changements                                                                          |
| ------------------------------ | ------- | ------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `process-owned-product-checks` | v2      | `c68b141c416b758a08a471438d9146f5f85e28103fc16d12800b2e705379d295` | 18       | `gtin.ts` ajouté ; `candidateRetrieval`, `criterionEvaluatorV2`, `evidence` modifiés |
| `check-owned-product`          | v2      | `673632dae91a7a729b482b1a6b8251fc12d0217a461ca69a5572bcfe5f20cd18` | 18       | idem                                                                                 |
| `process-recall-matches`       | v24     | `31e649e6f63660feb388d3f8a6fac3f13ebaef43585043bce308f8c4447072c7` | 40       | idem + `nemotronSafetyVerifier`                                                      |
| `run-recall-automation`        | v15     | `96875b00ba96b3721f43c48a98e1f9912fb41196f417e111f466d44de5455e57` | 6        | **aucun** (non redéployée)                                                           |

Pour `process-recall-matches`, les fichiers v2 plus anciens que le dépôt (`orchestratorV2.ts`,
`reviewedCriteriaV2.ts`) ont été conservés tels que déployés : aucune dérive du dépôt n'a été
livrée.

Avant le deploy, sur les mêmes entrées, seuls les cas équivalents changent :

- v1 : `rejected 0,98` devient `confirmed` ;
- v2 : `conflicting` devient `matched` ;
- vérificateur Nemotron : refus devient acceptation.

Le cas exact, un GTIN réellement différent et un GTIN invalide se comportent comme en v23.

**`process-recall-matches-v2-cohort` (v11) : AFFECTED BUT INTENTIONALLY DEFERRED.** Elle est
désactivée (`RECALL_V2_COHORT_ENABLED`), sans cron et sans appelant. **DO NOT ENABLE
process-recall-matches-v2-cohort UNTIL ITS 17.3-S RUNTIME HAS BEEN STAGED, DEPLOYED AND
VERIFIED** : son arbre cible préparé (octets déployés + 17.3-S) est `67d7074b…`. Le SQL étant
désormais élargi, l'activer sur v11 lui ferait juger contradictoires des paires équivalentes.

## 3. Migration `20261004090000`

- SHA-256 `d58d8438dcf2e0358bc62fd66d067bf05e32f92c86085acd2786bced3c4407e0`.
- Le dry-run ne prévoyait que cette migration. Appliquée de 07:04:15 à 07:04:19 UTC, exit 0.
- Après installation :

| Élément                               | Valeur                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                            | 36, dernière `20261004090000`, historique `e893f721bab6c56782dc84b510687d2f`                                                       |
| `private.canonical_gtin14(text)`      | `1f360d45c59400d5a49ee82636ff680c` ; `IMMUTABLE`, `STRICT`, invoker, `PARALLEL SAFE`, `search_path=""`                             |
| Droits sur `canonical_gtin14`         | EXECUTE pour `authenticated` et `service_role` seulement (index d'expression) ; aucun accès au schéma `private`                    |
| Index                                 | `owned_products_canonical_gtin14_idx`, `recall_scopes_canonical_gtin14_idx` ; empreinte globale `232db25670612c47a798803bb043e60f` |
| `get_recall_candidates`               | `695243ea58ac9b8b7cd61cfe9830555e` (signature et retour inchangés)                                                                 |
| `get_owned_product_recall_candidates` | `985de76d0dee90834b720c55d46d7e2e` (signature et retour inchangés)                                                                 |
| Inchangés                             | RLS et policies `owned_products`, droits sur les tables, autres fonctions privées, F-4                                             |

Aucune donnée réécrite, aucun backfill. Le planner choisit naturellement
`recall_scopes_canonical_gtin14_idx`. `owned_products_canonical_gtin14_idx` est utilisable,
mais le planner lui préfère légitimement un seq scan sur 2 lignes.

## 4. Remote verify

- Suite `phase-17-3-s-canonical-gtin.remote.sql`, SHA-256
  `9fa1945c2644a124adb28a3e777f6150b8a8fda77953067cf90ce4a397ded7cc`. Elle correspond à la suite
  du commit, moins la seule ligne `create extension`.
- Lancée par l'opérateur avec `npm run test:remote-pgtap`, `SUPABASE_DB_URL` sans mot de passe et
  `PGPASSWORD` saisi masqué.
- Résultat : **64/64**, `rolledBack: true`, pgTAP absent avant et après, 0 session
  `idle in transaction`, garde-fous et historique inchangés.
- **Zéro résidu** : 0 fixture `17350000-…` (utilisateurs, produits, notices, scopes,
  juridictions, matches, tâches, événements). Empreintes des extensions (`20bfc259…`) et des rôles
  (`1fd5bb1c…`) identiques. Comptes `auth.users`, sources et juridictions identiques (2, 2, 117).

Couverture, selon la décision de revue :

- A–F, J, K : validés par pgTAP en production ;
- G : couvert partiellement côté SQL ;
- G côté TypeScript, H et I : validés par les tests locaux du commit et par l'exécution du bundle
  exact déployé.

Les 64 assertions pgTAP **ne couvrent pas** à elles seules G, H et I : ces décisions sont prises
en TypeScript, hors de la base.

## 5. Régression production : run naturel de 12:17 UTC

Rien n'a été déclenché manuellement.

- **Cron** `recall-automation-every-6h` : `succeeded`.
- **Automation** (12:17:02 → 12:17:06) : `success`, trigger `cron`, sans erreur.
- **Ingestion** : 2 notices vues, `unchanged` ; CPSC et Health Canada en `success`, watermark
  `2026-10-05`.
- **Matching** : non invoqué, car 0 rappel affecté ni en attente. 0 paire, 0 IA, 0 alerte.
- **Product check** : `completed`, `attempted: true`, `claimed: 0`. Le worker 17.3-S (v2) a été
  appelé et a répondu **HTTP 200** en 1125 ms ; 0 retry, 0 échec. Ce résultat est attendu, car les
  2 tâches sont déjà `complete`.
- **Push** : HTTP 200, 0 envoi.
- **IA** : `aiCalls = 0`. 0 escalade côté matching ; l'automation refuse toute réponse du worker
  produit annonçant des appels IA.
- **Logs** : aucune erreur Postgres (`ERROR`, `FATAL`, `WARNING`), aucun `permission denied`,
  aucune erreur liée à `canonical_gtin14`, à un index ou au parsing GTIN depuis l'installation.

Compteurs avant (08:01) et après (14:00) : **identiques**.

| Élément                                         | Valeur                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Produits                                        | 2                                                                                                                             |
| Tâches                                          | 2 `complete`, aucune en erreur                                                                                                |
| Événements                                      | 8 (0 nouveau)                                                                                                                 |
| Matchs, évaluations v2, éligibilités, snapshots | 0                                                                                                                             |
| Alertes, file push, envois                      | 0                                                                                                                             |
| Notices / scopes                                | 117 / 130                                                                                                                     |
| Leases, rappels en attente                      | 0                                                                                                                             |
| Paires candidates                               | 37 (rang 1), empreinte `ae99b6b5741b41b8f19da95f32a6baca`, identique dans les deux sens et à la baseline d'avant installation |

F-4 : 5 triggers, définitions inchangées, inventaire de neutralisation 0, aucune alerte.
Configuration : `product_check_enabled = true`, `max_product_check_candidates = 25`.
Cron : `17 */6 * * *`, inchangé.

## 6. Historique et dettes

- **Aucun replay historique nécessaire.** Aucune paire produit × scope n'a de GTIN brut différent
  pour une clé canonique égale. Il n'existe aucun `rejected`, `conflicting`, empreinte figée ou
  alerte liés au défaut.
- **Dette documentée, non corrigée** : l'empreinte v1 n'inclut pas le code du matcher. Une paire
  déjà finalisée n'est pas réévaluée après un changement de matcher. Aucun impact aujourd'hui.

## 7. Portée et suites

17.3-S corrige en production l'équivalence 12/13/14 chiffres, la génération de candidats (SQL et
TS) et le matching v1, v2 et du vérificateur.

Elle **ne corrige pas** le scan UPC-E réel dans l'app (D1). Ce câblage (symbologie, expansion,
route, UI) relève de **17.3a**. La primitive `expandUpcE` est prête.

D2 reste **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**. Aucun scan physique n'a été requis
pour clore 17.3-S.

Rollback disponible, non utilisé : SQL d'abord (`20261004090100`, SHA `720f9723…`), puis Edge
(baselines `81ff731c…`, `b029ef38…`, `1b02f970…`).
