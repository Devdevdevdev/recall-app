# Phase 17.7a-1 — Vérification immédiate d'un nouveau produit (implémentation locale)

**Statut :** implémenté et vérifié **localement uniquement**. **Pas prêt pour la production :**
la phase est bloquée par F-4 (voir §10).

**Ce qui n'a pas été fait :** aucune écriture production, aucune migration distante, aucun
deploy, aucun secret, aucun cron, aucun commit, aucun push. Lectures production : aucune pendant
cette passe.

**Contexte :** base `HEAD 4c3d19e`. Conception validée :
[phase-17-7a-existing-recall-check-design.md](phase-17-7a-existing-recall-check-design.md),
section « Safe confirmation contract ».

## 1. Flux implémenté

```text
INSERT / UPDATE (attribut de matching) owned_products        ─┐ même transaction
  └─ trigger → private.owned_product_recall_checks (job)      ─┘ (+ événement 'armed')
app → POST check-owned-product { ownedProductId }   (JWT utilisateur, non bloquant)
  └─ auth.getUser(jwt) → user id      (403/404 impossible à distinguer : 404 identique)
  └─ claim_owned_product_recall_check(product, user)   propriétaire vérifié en base
  └─ runOwnedProductCheck (aucune IA, aucun v1)
       get_owned_product_recall_candidates (parité get_recall_candidates, borné, keyset)
       pour chaque avis : get_recall_v2_scopes → validateLiveRuleSetEnvelopeV2 (inchangé)
         → garde retrieveRecallCandidates (inchangée)
         → assessAutomaticConfirmationEligibility (porte)
         → claim_recall_match_evaluation (bail de paire existant)
         → evaluateRuleSetsPairV2 (inchangé)
         → décision = porte eligible ? v2 : needs_review
         → finalize_recall_match_evaluation_v2 → create_recall_v2_alert si confirmed
  └─ complete_owned_product_recall_check → état de surveillance borné
```

La reprise passe par `process-owned-product-checks`, un worker administratif local. Il **n'est
pas** branché sur `run-recall-automation` ; ce branchement relève de 17.7a-2.

## 2. Base de données (une migration additive)

Fichier : `supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql`.

| Élément                                     | Choix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrôle                                    | **Pas de nouvelle table.** Deux colonnes sont ajoutées au singleton Phase 12 `private.recall_automation_control` : `product_check_enabled boolean default false` et `max_product_check_candidates integer default 25` (bornée de 1 à 100).                                                                                                                                                                                                                                                                 |
| `private.owned_product_recall_checks`       | **Une ligne par produit**, PK `owned_product_id` (FK `on delete cascade`), donc jamais deux tâches actives pour le même produit. La ligne sert à la fois de file durable et d'**état courant**. Colonnes : `user_id`, `matching_revision`, `status` (pending/running/complete/failed), `attempts`, `available_at`, `lease_token`/`lease_expires_at`, curseur, `last_error` (liste bornée), `armed_at`, `completed_revision`, `checked_at`, `created_at`, `updated_at`. Aucun attribut produit n'est copié. |
| `private.owned_product_recall_check_events` | Journal append-only : UPDATE et TRUNCATE refusés, suppression seulement en cascade avec le produit, donc pas de donnée orpheline. Il sert à l'audit et au quota par utilisateur.                                                                                                                                                                                                                                                                                                                           |
| RLS                                         | Activée sur les deux tables. `revoke all` pour public, anon, authenticated **et** service_role : seul l'accès par RPC `SECURITY DEFINER` (`search_path = ''`) est possible.                                                                                                                                                                                                                                                                                                                                |
| Index                                       | Tâches dues et `user_id` ; journal par utilisateur et par produit ; côté avis : FTS du titre, marque normalisée, plages serial et lot (index partiels).                                                                                                                                                                                                                                                                                                                                                    |

**Les 4 tables proposées dans le design initial sont réduites à 2.** La table de contrôle est
remplacée par le singleton existant. La table des reports a disparu avec R1.

**RPC :**

| RPC                                                                             | Accès         | Rôle                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_owned_product_recall_candidates(product, after_rank, after_recall, limit)` | service_role  | Pré-filtre ; ne confirme rien.                                                                                                                                                                     |
| `claim_owned_product_recall_check(product, user, lease)`                        | service_role  | Chemin utilisateur. `not_found` est identique pour un produit étranger ou inexistant. Statuts : `disabled`, `complete`, `busy`, `not_due`, `rate_limited` (60/h) ou `claimed`.                     |
| `claim_due_owned_product_recall_checks(limit ≤ 25, lease)`                      | service_role  | Worker : claim atomique `FOR UPDATE SKIP LOCKED`. Un bail expiré au-delà du budget passe en `failed`.                                                                                              |
| `complete_owned_product_recall_check(...)`                                      | service_role  | Accepté seulement pour le détenteur du bail. Issues : `complete`, `continue` (curseur), `retry` (backoff) ; `failed` à la 8e tentative ; `rearmed` si le produit a changé pendant la vérification. |
| `get_my_product_monitoring_states(ids[] ≤ 100)`                                 | authenticated | Lecture filtrée sur `auth.uid()`.                                                                                                                                                                  |

### Trigger : colonnes de réarmement

Une modification relance la vérification sur `gtin`, `model_number`, `serial_number`,
`lot_number`, `safety_attributes`, `purchase_country_code`, `product_name` et `brand`. Le trigger
utilise `WHEN … IS DISTINCT FROM`, donc réécrire une valeur identique ne relance rien.

**Pourquoi `product_name` et `brand` relancent :**

- ce sont des signaux du pré-filtre (FTS du nom, égalité de marque) et de la garde Jaccard : ils
  changent l'ensemble des avis candidats ;
- ils entrent aussi dans le fingerprint v2 (`productionFingerprintV2`).

**Ne relancent pas :** `category`, `purchase_date`, `scan_date`, `image_path`,
`identification_method`, `identification_confidence` et les horodatages. Aucun n'est lu par la
porte ni par v2 : la projection v2 met `purchaseDate` à null.

## 3. Pré-filtre des candidats

- **Côté produit**, la RPC reprend **exactement** le prédicat et les rangs de
  `get_recall_candidates` :
  - 4 : GTIN ;
  - 3 : plage serial ou lot (inclusion conservatrice, le SQL ne décide jamais l'ordre d'une
    plage) ;
  - 2 : modèle ;
  - 1 : marque, nom du scope, titre (token FTS d'au moins 3 caractères).
- **Avis retenus :** autoritatifs seulement.
- **Requête :** une branche indexable par critère, aucun produit cartésien, ordre déterministe
  (rang décroissant puis id), limite d'au plus 100, curseur keyset.
- **Parité prouvée en pgTAP.** Sur la matrice de fixtures, l'ensemble des triplets
  {(produit, avis, rang)} est identique dans les deux sens.
- `get_recall_candidates` n'est pas modifiée.

## 4. Porte de confirmation sûre

Fichier : `_shared/productCheck/gate.ts`, fonction `assessAutomaticConfirmationEligibility`. Elle
n'évalue aucun critère et ne décide pas du match.

| Ordre | Condition                                                                                                          | Résultat si non satisfaite                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1     | source officielle                                                                                                  | `unsupported_scope`                                                       |
| 2     | juridiction structurée compatible ; `GLOBAL` couvre un pays inconnu ; une région sans table d'appartenance → revue | `jurisdiction_mismatch` / `incomplete_evidence` / `human_review_required` |
| 3     | au moins un scope ; aucune enveloppe invalide                                                                      | `unsupported_scope` / `human_review_required`                             |
| 4     | chaque scope a des règles revues                                                                                   | `unsupported_scope`                                                       |
| 5     | aucune règle écartée par le validateur                                                                             | `human_review_required`                                                   |
| 6     | `coverageComplete === true` pour chaque scope                                                                      | `unsupported_scope`                                                       |
| 7     | `all_of` ; chaque critère `required` et de type supporté                                                           | `human_review_required` / `unsupported_scope`                             |

**Liaison à la révision et à la source officielle.** Elle est vérifiée par le validateur v2
existant, inchangé : origine ledger humain, empreinte de règle, URL officielle et autorité.

**Types supportés : `model_number` et `date_code`.** C'est le miroir de l'allowlist live v2,
**sans élargissement**. `gtin`, `lot_number` et `manufacture_date` donnent `unsupported_scope`.
Un test garantit que la porte n'est jamais plus large que l'allowlist.

**Décision persistée :**

| Situation                           | Décision persistée                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| porte `eligible`                    | celle de v2 (`confirmed`, `rejected` ou `needs_review`)                                                    |
| porte non `eligible`, signal fort   | `needs_review` (`confidence = 0`, raison dans le résumé) ; signal fort = GTIN, modèle, serial ou lot exact |
| porte non `eligible`, signal faible | ignoré, **rien n'est persisté** ; signal faible = nom ou marque seuls                                      |

Une alerte n'est créée **que** pour `confirmed`. Il n'y a jamais de fallback v1.

## 5. Orchestrateur et fonctions Edge

**Orchestrateur** (`_shared/productCheck/orchestrator.ts`) :

- un seul produit, budget de candidats issu du contrôle, délai borné (15 s côté utilisateur, 20 s
  par produit côté worker) ;
- **fail closed** : une paire `busy`, `stale` ou en erreur arrête la passe **avant** que le
  curseur ne la dépasse, et la tentative suivante reprend exactement là ;
- un produit modifié depuis le claim n'est pas évalué (`product_changed`) ; un produit supprimé
  termine sans aucune écriture.

**Fingerprint composite.** C'est l'empreinte v2 inchangée (qui lie déjà les révisions du produit
et de l'avis) plus les entrées de la porte : pays d'achat et juridictions triées. Un changement de
juridiction n'est donc jamais servi depuis un résultat périmé.

**`check-owned-product` :**

- POST seul ; Bearer JWT vérifié par le serveur d'auth (`auth.getUser`, rôle `authenticated`
  exigé) ;
- corps strictement `{ ownedProductId }` : pas de `user_id`, pas de liste, pas de borne ;
- réponse bornée à `{ state, checkedAt, possibleMatches, confirmedAlerts, retrying }` ;
- codes : 401 sans JWT valide, 404 identique pour un produit étranger ou inexistant, 400 pour un
  corps invalide, 429 au-delà du quota, 503 si la base est indisponible ;
- un échec de vérification répond `retrying` : le produit reste enregistré.

**`process-owned-product-checks`** (worker) :

- protégé par `x-recall-matching-key` (comparaison à temps constant) ;
- lot de 1 à 25 produits ;
- renvoie seulement des compteurs agrégés, dont `aiCalls: 0` ;
- local seulement.

`supabase/config.toml` déclare les deux fonctions avec `verify_jwt = false`. La vérification fait
autorité dans le handler, avec le même modèle que les autres fonctions du dépôt.

## 6. États de surveillance

Ils sont dérivés par `private.owned_product_monitoring_state` et ne sont jamais stockés deux fois.
Priorité :

`recall_detected` > `check_failed` > `checking` > `check_failed_retrying` > `pending_check` >
`possible_match_needs_verification` > `monitored_no_known_recall`.

- `recall_detected` : alerte v2 dont la dernière évaluation est `confirmed`, ou alerte v1 encore
  `confirmed`.
- `possible_match_needs_verification` : dernière évaluation v2 `needs_review` **postérieure au
  dernier armement**, donc jamais héritée d'une ancienne révision.
- `monitored_no_known_recall` signifie seulement : « Aucun rappel correspondant trouvé dans les
  sources actuellement surveillées avec les preuves disponibles. »

## 7. Mobile (minimal)

- `ProductMonitoringRepository` et son implémentation Supabase (`functions.invoke` et RPC), plus
  un mapper qui refuse un état inconnu.
- **Après création** : demande de vérification non bloquante, après l'enregistrement.
- **Après modification** : seulement si un attribut pertinent change. `hasMatchingAttributeChange`
  reprend les colonnes du trigger, et un test vérifie qu'elles correspondent.
- **Au focus de l'inventaire** : chargement des états, puis reprise d'au plus 3 produits
  `pending_check` ou `check_failed_retrying`.
- Libellés provisoires en anglais, comme le reste de l'app. Aucun libellé ne prétend que le
  produit n'a jamais été rappelé. L'UX complète relève de 17.5.
- Doc Expo v57 consultée pour `useFocusEffect` (enveloppé dans `useCallback`).

## 8. Tests et validation

| Suite                                                                                             | Résultat                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `npx supabase db reset --local --no-seed`                                                         | OK (33 migrations, dont celle de 17.7a-1)    |
| `npm run check:all`                                                                               | **PASS** (exit 0)                            |
| Node (`test:node`)                                                                                | **487/487** (411 existants + 76 nouveaux)    |
| Deno                                                                                              | **18/18** (6 existants + 12 nouveaux)        |
| Typecheck Edge (`deno check`, 10 fonctions)                                                       | OK                                           |
| `tsc`, ESLint, Prettier, benchmarks figés                                                         | OK                                           |
| pgTAP (`test:database`, 24 fichiers)                                                              | **2472 PASS** (2383 existants + 89 nouveaux) |
| HTTP réel local (`npm run test:phase-17-7a-1:http`, `supabase functions serve`, vrais JWT GoTrue) | **16/16**                                    |

**Nouveaux fichiers de test :**

- `tests/phase-17-7a-safe-confirmation.test.mjs` (R1, 35) et
  `tests/finding-f1-ai-budget-fingerprint-freeze.test.mjs` (R1, 1) : conservés, verts ;
- `tests/phase-17-7a-1-product-check.test.mjs` (29) : porte, scénarios de matching sur les vraies
  enveloppes v2, fail closed, budget et curseur, parseurs, absence d'IA et de v1, empreintes
  SHA-256 des bibliothèques v1/v2 et du pipeline, politique v1 par défaut ;
- `tests/phase-17-7a-1-mobile-monitoring.test.mjs` (7) ;
- `tests/phase-17-7a-1-release-gate.test.mjs` (4) ;
- `tests/phase-17-7a-1-check-owned-product.test.ts` (Deno, 12) ;
- `supabase/tests/phase-17-7a-1-owned-product-recall-checks.sql` (pgTAP, 89).

**Couverture des cas demandés :**

| Domaine    | Cas couverts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB         | trigger INSERT ; rollback transactionnel ; UPDATE pertinent ; update cosmétique et réécriture identique ; ownership ; privilèges et RLS ; claim concurrent (`busy`, le worker ne vole pas un bail vivant) ; expiration du bail ; retry et backoff ; épuisement ; idempotence ; suppression pendant la vérification ; états ; isolation entre utilisateurs ; quota ; journal immuable ; aucun cron                                                                                                                                                    |
| Matching   | ancien avis trouvé ; GTIN sans règles → possible, sans alerte ; GTIN + règles supportées complètes → `confirmed` et une alerte ; mauvais `date_code` → `rejected` ; date code hors liste → `rejected` ; date absente → vérification ; règle lot ou date de fabrication hors allowlist → jamais confirmé ni rejeté ; couverture incomplète → possible ; juridiction incompatible ou inconnue → aucune alerte (`GLOBAL` → confirmé) ; deux utilisateurs avec le même GTIN ; deux produits du même utilisateur ; double exécution sans doublon d'alerte |
| Edge       | JWT absent ou malformé → 401 ; JWT rejeté → 401 ; JWT service-role ou anon → 401 (HTTP réel) ; produit étranger ou inexistant → 404 identique ; produit possédé → 200 ; corps invalide → 400 ; timeout → retry ; échec de complétion ; worker borné, `aiCalls: 0`                                                                                                                                                                                                                                                                                    |
| Régression | v1 et v2, `process-recall-matches`, `run-recall-automation`, `_shared/automation` et migrations existantes **identiques à HEAD** (`git diff` et empreintes SHA-256) ; aucune écriture `recall_matches`/`alerts` ; politique par défaut `phase_10_guarded_v1` ; D1/D2 verts                                                                                                                                                                                                                                                                           |

**Correspondance avec le contrat (honnêteté) :**

- « mauvais lot → rejected » et « date hors plage → rejected » ne sont possibles **qu'avec des
  types supportés** (`date_code`). Avec un critère `lot_number` ou `manufacture_date`, la règle
  est écartée par l'allowlist et le résultat est une vérification nécessaire, **sans alerte**.
  C'est voulu : l'allowlist n'est pas élargie.
- En pgTAP, `now()` est figé dans la transaction. L'expiration des baux et le décalage
  d'armement sont donc simulés en modifiant les horodatages.
- La concurrence réelle entre sessions est couverte par le verrou de ligne, `SKIP LOCKED` et le
  bail vivant (`busy`). Il n'y a pas de test à deux sessions simultanées.

**Hygiène :**

- scan de secrets sur tous les fichiers modifiés : **0 occurrence** ;
- la clé de matching locale du test HTTP a été générée dans le scratchpad, jamais dans le dépôt ;
- aucune modification n'est générée par les tests ;
- la base locale a été réinitialisée avant `check:all`.

## 9. Écarts par rapport au design R1

- **Pas de contrôle de `RECALL_MATCHING_POLICY` dans le chemin produit.** Ce chemin ne lit ni
  n'écrit la politique, et il reste gouverné par `product_check_enabled`. v2 global reste
  inactif : le test le vérifie.
- **Pré-filtre avec `product_name` et `brand`.** La parité exacte avec
  `get_recall_candidates` l'emporte sur la liste minimale. Les candidats faibles non éligibles
  sont ignorés sans persistance.
- **Compteurs non stockés.** `possibleMatches` et `confirmedAlerts` sont dérivés des tables v2
  existantes.

## 10. Limites connues et garde-fou de release

- **F-4 (bloquant).** Le pipeline v1 recall → produits confirme encore sur des GTIN
  recall-level, sans conditions ni juridiction
  ([fiche](findings/f-4-v1-unsafe-auto-confirmation.md)).
  - `docs/phase-17-7a-1-release-gate.json` déclare `productionReady: false` avec F-4 `open`.
  - `tests/phase-17-7a-1-release-gate.test.mjs` échoue si la phase est déclarée prête tant que
    F-4 n'est pas `resolved` ou `neutralized` avec une décision écrite.
  - Le test échoue aussi si une migration, une fonction ou un module active
    `product_check_enabled`.
- **F-1 (suivi séparé, non bloquant ici).** Le chemin produit n'utilise ni IA ni l'orchestrateur
  v1 ([fiche](findings/f-1-ai-budget-fingerprint-freeze.md)).
- **Allowlist v2.** Seuls `model_number` et `date_code` sont supportés : un produit identifié
  uniquement par GTIN ne peut jamais être confirmé automatiquement. Toute extension (GTIN, lot,
  date de fabrication) est une décision séparée.
- **Couverture complète en production : 0 avis sur 103** (lecture R1 du 2026-10-02 : 0 règle v2
  revue). Le chemin produit ne confirmerait donc rien automatiquement aujourd'hui. Il signalerait
  des correspondances possibles, comme le GTIN de l'avis 8877, sans alerte ni push.
- **Reprise serveur non planifiée.** Le worker existe mais n'est pas branché sur l'automation
  (17.7a-2). D'ici là, la reprise vient de l'app (au focus) ou d'un appel administratif manuel.

## 11. Prochaine étape recommandée

Traiter **F-4** dans une phase dédiée, avant toute installation, sous l'une de deux formes :

- une neutralisation v1 versionnée : pas de confirmation automatique sur un scope recall-level
  ni sur une juridiction incompatible ;
- une décision écrite de neutralisation opérationnelle.

Ensuite viendront 17.7a-2, le branchement du worker sur `run-recall-automation`, puis un plan
d'installation contrôlée avec un « GO » par étape.
