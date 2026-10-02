# Phase 17.7a — Design decision : vérification immédiate d'un nouveau produit

**Statut :** audit et conception uniquement. Aucun changement runtime, aucune migration, aucun
déploiement, aucun commit, aucun push, aucun accès production.

**Base auditée :** `HEAD 4c3d19e` (main, working tree clean), migrations jusqu'à
`20261001090000_phase_16_34_gate_f_retire_v1_key_installer.sql`, politique de production
`phase_10_guarded_v1`, v2 inactif.

> **Révision R1 (2026-10-02).** L'architecture générale reste validée : Option A, outbox, isolation
> par utilisateur, idempotence, retries bornés. En revanche, le **moteur d'évaluation** et la
> **persistance** du chemin produit sont remplacés par la section finale
> [Safe confirmation contract](#safe-confirmation-contract). En cas de contradiction, cette
> section l'emporte sur les §5 à §12 et §15 à §16. En particulier, le chemin produit
> **n'utilise plus** l'orchestrateur v1 et **ne renvoie plus** de `needs_review` au pipeline v1
> (`defer` vers `pending_recalls` est supprimé). La passe R1 a fait des lectures de production
> (`SELECT` seuls, via MCP), sans aucune écriture.

---

## 1. Current failure mode

Le matching v1 est **recall-first** de bout en bout :

```text
ingestion -> record_recall_automation_ingestion (pending_recalls += recalls affectés)
          -> get_recall_automation_pending_recalls
          -> process-recall-matches { recallNoticeIds }
          -> pour chaque recall : get_recall_candidates(recall) -> produits
```

Rien ne déclenche une évaluation quand un **produit** est créé ou modifié :

- `owned_products` n'a aucun trigger vers le matching. Seuls existent `set_updated_at`,
  `protect_owner` et `protect_created_at`.
- La file `private.recall_automation_pending_recalls` est indexée par **recall**. Elle n'est
  alimentée que par l'ingestion (inserted ou updated).
- Un recall `unchanged` à l'ingestion n'est jamais rejoué. Un recall ingéré hier n'est donc plus
  jamais confronté à un produit ajouté aujourd'hui, sauf si la source le révise.

Le même trou existe pour la **modification** d'un identifiant produit (GTIN corrigé, modèle
ajouté) : aucune réévaluation contre les recalls déjà connus.

Production au dernier relevé (16.33 §2) : 0 produit, 0 match, 0 alerte. Le défaut n'a donc encore
fait aucune victime, mais il touchera le premier utilisateur réel.

---

## 2. Existing matcher architecture (audit)

### Fichiers lus

| Couche                   | Fichier                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge, entrée             | `supabase/functions/process-recall-matches/index.ts` (sélecteur de politique ; v1 → `legacyRun.ts`)                                                                                                         |
| Edge, v1                 | `process-recall-matches/legacyRun.ts`, `store.ts`                                                                                                                                                           |
| Edge, v2 (inactif)       | `process-recall-matches/storeV2.ts`, `_shared/recallMatching/orchestratorV2.ts`                                                                                                                             |
| Orchestrateur v1         | `_shared/recallMatching/orchestrator.ts`, `fingerprint.ts`, `projection.ts`, `request.ts`, `types.ts`, `policySelector.ts`                                                                                  |
| Matcher pur              | `_shared/matching/deterministicMatcher.ts`, `evidence.ts`, `aggregation.ts`, `candidateRetrieval.ts`, `normalization.ts`, `hybridGuardedMatcher.ts`                                                         |
| Automation               | `run-recall-automation/children.ts`, `_shared/automation/orchestrator.ts`                                                                                                                                   |
| SQL : schéma             | `20260912000000_phase_2_foundation.sql` (tables, UNIQUE, RLS), phases 13, 14 et 16 (colonnes `owned_products`)                                                                                              |
| SQL : RPC de matching    | `20260914100000_phase_10_recall_matching.sql` (`get_recall_matching_batch`, `get_recall_candidates`, baux, index) et `20260914110000_…_fix_matching_rpc_ambiguity.sql` (claim/finalize, versions courantes) |
| SQL : file et automation | `20260916100000_phase_12_…` (pending, control, runs) et `20260930200000_phase_16_33_…` (outcomes, retries bornés, tickets)                                                                                  |
| SQL : push               | `20260915100000_phase_11_…` (`alerts_enqueue_confirmed_push`)                                                                                                                                               |
| Docs                     | `recall-matching.md`, `automatic-recall-loop.md`, `phase-16-33-security-and-v1-correctness-stop-report.md`                                                                                                  |
| Mobile                   | `src/data/SupabaseOwnedProductsRepository.ts` (insert direct sous RLS, aucun appel post-insert)                                                                                                             |

### A. Comment un recall devient candidat

1. L'ingestion upsert `recall_notices` et `recall_scopes`. Les ids inserted ou updated passent
   dans `record_recall_automation_ingestion`, qui fait l'upsert dans `pending_recalls` et avance le
   watermark dans **la même transaction**.
2. `get_recall_automation_pending_recalls` (16.33) liste les recalls pending. Les recalls épuisés
   passent en dernier, au plus une fois par 24 h.
3. `run-recall-automation` appelle `process-recall-matches` avec `recallNoticeIds`,
   `maxNebiusCalls = control.ai_enabled ? max_ai_escalations : 0` et `deliverPush = false`.
4. `get_recall_matching_batch` ne retourne que les notices dont la source a
   `is_authoritative = true`. Il projette les scopes sous forme canonique triée. `is_active` et la
   juridiction **ne sont pas** des filtres.

### B. Comment les produits sont sélectionnés

Deux étages successifs.

**1. Pré-filtre SQL `get_recall_candidates(recall)`** (`SECURITY DEFINER`, tous utilisateurs). Un
produit est retenu si au moins un scope du recall satisfait l'une de ces conditions :

- GTIN : chiffres normalisés égaux ;
- modèle : alphanumérique en minuscules égal ;
- produit avec serial **et** scope avec `serial_from/to` ;
- produit avec lot **et** scope avec `lot_from/to` ;
- FTS `simple` : le nom produit partage un token d'au moins 3 caractères avec le `product_name` du
  scope ;
- marque normalisée égale ;
- ou bien, au niveau du recall : FTS du nom produit contre le **titre** du recall.

Le résultat est trié par `exact_rank` (4 = GTIN, 3 = plage, 2 = modèle, 1 = reste), puis paginé
par curseur `(exact_rank, product_id)`.

**2. Garde TS `retrieveRecallCandidates(owned, [recall])`** (orchestrator.ts). Une paire sans
signal (GTIN valide exact, modèle, serial/lot exact ou inclus, Jaccard de nom ≥ 0,15, texte
fabricant) est ignorée avant tout claim. Elle **ne consomme pas** `maxCandidatePairs`.

### C. Où intervient le déterminisme

- **Projection.** `projectOwnedProduct` reprend : nom, marque, catégorie, GTIN, modèle, serial,
  lot, date d'achat, méthode d'identification. `projectAuthoritativeRecall` force
  `rawEvidence = null`.
- **Fingerprint.** `buildEvidenceFingerprint` calcule un SHA-256 sur du JSON canonique : produit
  projeté, recall stable avec scopes triés, SHA-256 du `raw_payload` et versions de politique
  (`deterministic_v1`, `hybrid_guarded_v1`, schéma, prompt, `phase_10_guarded_v1`, `modelId`). Les
  ids, timestamps et l'ordre d'insertion n'y entrent pas.
- **Décision.** `evaluateDeterministicMatch` est une fonction pure, sans I/O.

### D. Quand un match devient confirmed, rejected ou needs_review

`deterministic_v1`, par scope (`evidence.ts`), puis agrégation :

| Situation dans un scope                                                                                      | Décision            |
| ------------------------------------------------------------------------------------------------------------ | ------------------- |
| conflit fort, conflit de marque explicite, ou `additionalCriteria` complexes, **avec** un identifiant matché | `needs_review`      |
| GTIN exact valide                                                                                            | `confirmed` (1,0)   |
| serial/lot exact, ou inclus dans une plage numérique sûre                                                    | `confirmed` (0,96)  |
| modèle exact et Jaccard de nom ≥ 0,35                                                                        | `confirmed` (0,9)   |
| modèle exact seul, ou plage ambiguë                                                                          | `needs_review`      |
| conflit fort sans aucun match                                                                                | `rejected`          |
| nom ou marque seuls                                                                                          | `needs_review`      |
| aucune preuve comparable                                                                                     | scope non pertinent |

Agrégation (`aggregation.ts`) : un scope confirmé suffit à confirmer la notice. Sinon, un scope
plausible non résolu donne `needs_review`. `rejected` n'est retenu que si tous les scopes
pertinents se contredisent.

Escalade : `needs_review` passe par `hybrid_guarded_v1` (Nemotron), seulement si
`nebiusCalls < maxNebiusCalls`. Sinon, le résultat déterministe `needs_review` est **finalisé
tel quel**.

> **Limite v1 importante pour 17.7a (lecture de code, à épingler par un test de
> caractérisation).** Une absence d'information côté produit ne produit aucun item dans
> `evaluateRange`. Par ailleurs, `manufactured_from/to` n'est jamais comparé (la date d'achat
> n'est pas une date de fabrication). Conséquence : un GTIN exact confirme même si le scope déclare
> aussi une plage de lots ou une fenêtre de fabrication que le produit ne renseigne pas. La seule
> exception est un `additionalCriteria` complexe. La conjonction stricte « tous les critères
> requis » est précisément le contrat de **v2** (`all_of`), qui est inactif. Voir §11, décision
> D1.

### E. Quand une alerte est créée

Uniquement dans `finalize_recall_match_evaluation` (transaction unique) :

1. bail valide (même paire, même token, même fingerprint, non expiré) ;
2. revisions `updated_at` du produit et de la notice inchangées, prises en `FOR SHARE` ;
3. source toujours `is_authoritative` ;
4. upsert de `recall_matches` ;
5. si `confirmed` et aucune alerte n'existe : `insert alerts(user_id = owned_products.user_id)`.

Ensuite, `alerts_enqueue_confirmed_push` place l'alerte dans `private.push_alert_queue`. Une
confirmation inversée plus tard **conserve** l'alerte comme historique
(`confirmation_reversed`).

### F. Protections contre les doublons

| Niveau         | Mécanisme                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Paire          | `recall_matches_owned_product_notice_key UNIQUE (owned_product_id, recall_notice_id)`                                                   |
| Alerte         | `alerts.recall_match_id UNIQUE`, plus `on conflict … do nothing` dans finalize                                                          |
| Réévaluation   | claim → `unchanged` si un `recall_matches` porte déjà le même `evidence_fingerprint`                                                    |
| Concurrence    | `private.recall_matching_leases` (PK paire, bail de 30 à 300 s, réclamable après expiration) → `busy`                                   |
| Fraîcheur      | double vérification `updated_at` au claim, nouvelle vérification au finalize → `stale`                                                  |
| Recall (16.33) | retrait de `pending_recalls` seulement par recall résolu. Retries bornés à 8 cycles, puis `exhausted_at`, réarmé par du nouveau travail |
| Push           | `push_alert_queue (alert_id)` en `on conflict do nothing`                                                                               |

### G. Global ou propre à un utilisateur

- **Global (tous utilisateurs) :** `get_recall_matching_batch`, `get_recall_candidates`, l'Edge
  `process-recall-matches` et toute l'automation. Un appel traite un recall contre **tous** les
  produits de tous les utilisateurs.
- **Lié à un utilisateur :** l'alerte, dont `user_id` est dérivé du produit dans finalize et vérifié
  par `ensure_alert_owner`, ainsi que les lectures RLS (produits, matches, alertes) côté mobile.
- **Pur et partagé :** tout `_shared/matching/` et `_shared/recallMatching/` (sans client
  Supabase ni Deno).

### H. Ce qui exige service_role

- Exécution de `get_recall_matching_batch`, `get_recall_candidates`,
  `claim_recall_match_evaluation`, `finalize_recall_match_evaluation` et des RPC d'automation et de
  push : `service_role` seulement, `revoke` pour public, anon et authenticated.
- Tables `private.*` (baux, pending, control, runs, push) : inaccessibles **même** à service_role
  directement. Seules des RPC `SECURITY DEFINER` à `search_path = ''` y touchent.
- `process-recall-matches` : `verify_jwt = false` et clé `x-recall-matching-key` comparée en temps
  constant. Ce n'est jamais un endpoint mobile.
- Mobile : uniquement PostgREST sous RLS (`owned_products` CRUD propriétaire, lecture des
  matches et alertes de ses produits).

### Constats annexes (hors périmètre, à traiter séparément)

- **F-1. La retry « limit » de 16.33 est inopérante pour le budget IA.** Quand
  `nebiusCalls >= maxNebiusCalls`, l'orchestrateur finalise le `needs_review` déterministe **avec le
  fingerprint canonique**. Ce fingerprint contient déjà les versions hybrides et le `modelId`. Au
  cycle suivant, le claim répond `unchanged` et le recall est déclaré résolu : la paire ne reçoit
  jamais l'escalade hybride, sauf si ses preuves changent. Il est suivi séparément dans
  [docs/findings/f-1-ai-budget-fingerprint-freeze.md](findings/f-1-ai-budget-fingerprint-freeze.md),
  avec sa reproduction `tests/finding-f1-ai-budget-fingerprint-freeze.test.mjs`. Depuis R1, le
  chemin produit n'emprunte plus l'orchestrateur v1 et n'est donc pas concerné.
- **F-2. La juridiction n'est pas un critère v1.** `purchase_country_code` et les juridictions de
  notice sont hors projection et hors fingerprint (documenté depuis les phases 13 et 14). Un rappel
  CPSC confirmé par GTIN s'applique donc aussi à un produit acheté en France. Le cas de test 15 ne
  peut être garanti qu'au sens « source non autoritative → aucune alerte ».
- **F-3. Pas d'inversion sur des preuves qui ne sont plus candidates.** Si une correction
  d'identifiant fait sortir un recall du pré-filtre, l'ancien match `confirmed` n'est pas
  réévalué : la garde TS fait `continue` avant le claim. Le chemin recall-first a le même
  comportement.

---

## 3. Options considered

### A. Vérification ciblée par produit au moment de l'ajout

`product_id` → recalls plausibles pour CE produit → matcher v1 → finalize existant → alerte.

| Critère                   | Évaluation                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sécurité                  | Bonne si l'entrée authentifiée ne porte qu'un `product_id` vérifié contre le propriétaire et des bornes fixées côté serveur. Nouvelle surface : un Edge JWT. |
| Coût                      | O(recalls candidats d'un produit). Quelques lookups indexés, ≤ 100 notices, zéro IA.                                                                         |
| Scalabilité               | Linéaire en ajouts de produits. Indépendante du nombre d'utilisateurs.                                                                                       |
| Idempotence               | Hérite du fingerprint, des UNIQUE et des baux. Un job par produit, versionné par révision.                                                                   |
| RLS                       | Aucune table publique modifiée. Nouvelles tables `private`, RPC definer.                                                                                     |
| Impact matcher Phase 16   | Nul si l'orchestrateur est réutilisé tel quel via un store dédié (voir §4).                                                                                  |
| Migration                 | Oui (job, RPC, trigger, index).                                                                                                                              |
| Faux positifs             | Identiques au chemin recall-first : même matcher, même finalize.                                                                                             |
| Faux négatifs             | Risque de divergence du pré-filtre produit → recalls. Neutralisé par un test de parité (§9).                                                                 |
| Charge DB                 | Faible et localisée.                                                                                                                                         |
| Mobile                    | Un appel après l'insert, réponse synchrone.                                                                                                                  |
| Test local                | Complet (Node, pgTAP, `supabase functions serve`).                                                                                                           |
| Enrichissement GTIN futur | Naturel : une mise à jour du GTIN réarme le job.                                                                                                             |

### B. Remettre en file les recalls pertinents (`pending_recalls`)

| Critère                  | Évaluation                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sécurité                 | Un geste utilisateur écrit dans la file privée de l'automation : couplage du plan utilisateur au plan d'ingestion.                                           |
| Coût                     | **Amplification** : chaque recall remis en file est réévalué contre les produits de **tous** les utilisateurs.                                               |
| Scalabilité              | Mauvaise. La file partage le plafond de 100 recalls par run avec l'ingestion. Beaucoup d'ajouts peuvent affamer les nouveaux rappels (déni de service doux). |
| Latence                  | Jusqu'à 6 h (cron `17 */6`). Ce n'est **pas** une vérification immédiate.                                                                                    |
| Idempotence              | Bonne (mécanismes existants).                                                                                                                                |
| Impact Phase 16          | Touche le contrat 16.33 de la file (réarmement, épuisement, outcomes).                                                                                       |
| Migration                | Petite.                                                                                                                                                      |
| Faux positifs / négatifs | Identiques au v1, Nemotron inclus dans le budget.                                                                                                            |
| Mobile                   | Simple, mais aucun résultat à afficher avant le cycle suivant.                                                                                               |
| Test local               | Oui.                                                                                                                                                         |

**Rejetée comme mécanisme principal.** Une variante **ciblée et rare** reste utile pour un seul
cas : remettre au pipeline existant un `needs_review` déterministe, afin qu'il garde sa chance
d'escalade hybride (§5).

### C. Sweep périodique complet produits × recalls

| Critère        | Évaluation                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------- |
| Coût et charge | O(P × R) même avec pré-filtre. Croît avec chaque utilisateur et chaque rappel.               |
| Latence        | Celle de la période. Pas immédiat.                                                           |
| Infrastructure | Nouveau job cron, curseur global, plafonds, observabilité.                                   |
| Idempotence    | Bonne (fingerprint), mais claims et fingerprints recalculés massivement pour rien.           |
| Valeur         | Filet de réconciliation (dérive, bugs de pré-filtre). Ce n'est pas un mécanisme utilisateur. |

**Rejetée pour 17.7a.** À reconsidérer plus tard comme réconciliation basse fréquence, une fois
v2 actif.

---

## 4. Sélection de candidats sûre (pré-filtre)

**Principe.** Le pré-filtre ne confirme jamais rien. Il doit être un **sur-ensemble exact** de ce
que le chemin recall-first retiendrait pour la même paire. L'autorité reste, dans l'ordre :

1. la garde TS `retrieveRecallCandidates` ;
2. `evaluateDeterministicMatch` ;
3. `finalize_recall_match_evaluation`.

Ces trois étapes sont réutilisées **sans copie**.

| Critère officiel               | Rôle en pré-filtre             | Index (côté recall)                                   | Pourquoi                                                                                               |
| ------------------------------ | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GTIN                           | oui (exact normalisé)          | `recall_scopes_normalized_gtin_idx` (existant)        | Signal le plus fort. La garde TS revérifie la clé de contrôle GS1.                                     |
| model_number                   | oui (exact normalisé)          | `recall_scopes_normalized_model_idx` (existant)       | Peut confirmer avec le nom.                                                                            |
| plage serial / lot             | oui (présence des deux côtés)  | nouvel index partiel sur les scopes qui ont une plage | v1 peut confirmer un lot inclus ; le SQL ne décide jamais l'ordre des plages.                          |
| brand                          | oui (égalité normalisée)       | nouvel index d'expression normalisé                   | Parité avec Phase 10 (needs_review au plus).                                                           |
| nom produit vs scope           | oui (token FTS ≥ 3 caractères) | `recall_scopes_product_name_fts_idx` (existant)       | Parité. Requête OR des tokens du produit contre le tsvector du scope, ensemble identique par symétrie. |
| nom produit vs titre           | oui (token FTS ≥ 3 caractères) | nouvel index GIN `to_tsvector('simple', title)`       | Parité avec la branche titre de Phase 10.                                                              |
| safety_attributes              | **non**                        | —                                                     | Non lu par v1. Réservé à v2.                                                                           |
| purchase country / juridiction | **non**                        | —                                                     | Non lu par v1 (F-2). L'ajouter seulement côté produit créerait une applicabilité divergente.           |
| manufactured_from/to           | **non**                        | —                                                     | v1 ne compare pas la date d'achat à une fenêtre de fabrication.                                        |

**Pourquoi la parité plutôt qu'un pré-filtre plus étroit (GTIN et modèle seuls) :** v1 confirme
aussi sur un serial ou un lot exact, et sur un modèle accompagné du nom. Un filtre plus étroit
créerait des faux négatifs que le chemin recall-first ne crée pas. Le pré-filtre de parité reste
borné : il ne lit que les recalls autoritatifs, avec des index sur chaque branche.

**Garantie anti-divergence.** `get_recall_candidates` reste **intact** (installé, vérifié par les
install checks Phase 16). La nouvelle RPC produit → recalls reprend son prédicat. Un test pgTAP de
parité exige, sur une matrice de fixtures couvrant chaque branche et ses négatifs :

```text
{ R : P ∈ get_recall_candidates(R) } = { R : R ∈ get_owned_product_recall_batch(P) }
```

La refactorisation des deux RPC autour d'un prédicat privé unique est reportée. Elle toucherait
une RPC Phase 10 installée.

**Fail closed.** Si une étape ne peut pas évaluer complètement (erreur RPC, plafond atteint, bail
`busy` ou `stale`), aucune décision n'est écrite pour la paire concernée, le job reste
`retrying`, et l'état client ne dit jamais « aucun rappel ».

---

## 5. Recommended architecture

> **R1 :** les pièces 2 et 3 ci-dessous (orchestrateur v1, store produit, `defer`) sont
> **remplacées**. Voir [Safe confirmation contract](#safe-confirmation-contract), §SC-7. Les pièces
> 1, 4 et 5 restent valables.

**Option A, ciblée par produit, via une petite outbox durable en base**, traitée par un Edge
authentifié (chemin rapide) et rejouée côté serveur (chemin de reprise). Elle **réutilise
l'orchestrateur v1 byte-for-byte** grâce à un store « produit unique ».

### Les cinq pièces

1. **Outbox `private.owned_product_recall_checks`**, une ligne par produit. Un trigger `AFTER
INSERT` ou `AFTER UPDATE OF <colonnes de matching>` sur `owned_products` l'arme dans **la même
   transaction** que l'enregistrement. Le produit est donc sauvegardé même si le matcher est
   indisponible, et le travail ne peut pas se perdre.

2. **Edge `check-owned-product`** (JWT utilisateur, pas de clé administrative) :
   - vérifie le JWT et extrait `sub` ;
   - ne reçoit que `{ ownedProductId }` ;
   - réclame le job par une RPC `service_role` qui **vérifie que le produit appartient à `sub`** ;
   - exécute `processRecallMatches` **inchangé** avec :
     - `ProductScopedRecallMatchingStore` ;
     - `maxNebiusCalls = 0` ;
     - le même `modelId` épinglé que le chemin recall-first (donc des fingerprints identiques) ;
     - un `createNemotronEvaluator` qui lève une exception et ne doit jamais être appelé.

3. **`ProductScopedRecallMatchingStore`** implémente `RecallMatchingStore` :
   - `listAuthoritativeRecalls` → `get_owned_product_recall_batch(product, after, limit)`, même
     forme de lignes que `get_recall_matching_batch` ;
   - `listRecallCandidateProducts` → la seule ligne du produit
     (`get_owned_product_matching_row`), une fois par recall ;
   - `claimPair` → `claim_recall_match_evaluation` existant ;
   - `finalizePair` :
     - `confirmed` ou `rejected` → `finalize_recall_match_evaluation` existant (alerte atomique) ;
     - `needs_review` → **report** via `defer_recall_match_evaluation`. Cette RPC libère le bail
       sans écrire de `recall_matches`, enregistre le report, et fait l'upsert du recall dans
       `pending_recalls`. Le pipeline existant évalue alors la paire avec sa politique complète,
       hybride gardé compris, dans son budget.

4. **Reprise serveur** :
   - nouvel Edge administratif `process-owned-product-checks` (`x-recall-matching-key`), qui
     draine les jobs dus avec un backoff ;
   - appelé comme étape bornée de `run-recall-automation`, après le matching et avant le push.

   Aucun nouveau cron, aucun nouveau secret. Le client relance aussi les jobs dus de **ses**
   produits à l'ouverture de l'inventaire.

5. **Interrupteur dédié `private.owned_product_check_control`** (`enabled = false` par défaut).
   L'installation est inerte jusqu'à une activation explicite, comme pour toutes les phases 16.

### Pourquoi c'est la bonne option, et pas seulement la plus simple

- **Une seule implémentation de l'applicabilité.** Projection, garde TS, matcher, fingerprint,
  claim et finalize sont exactement ceux du chemin recall-first. Le seul code nouveau est un
  **adaptateur d'I/O** et un pré-filtre SQL dont la parité est testée.
- **Idempotence inter-chemins.** Les fingerprints sont identiques. Une paire évaluée par le
  produit puis par le recall (ou l'inverse) donne `unchanged`, sans alerte en double grâce aux
  UNIQUE existants.
- **Pas d'IA, sans gel.**
  - Les décisions sûres (`confirmed`, `rejected`) sont immédiates.
  - Les décisions ambiguës ne deviennent jamais une alerte sur ce chemin.
  - Elles ne sont **pas** non plus figées en `needs_review` avec le fingerprint canonique, ce qui
    reproduirait F-1 et retirerait l'escalade hybride. Sur le holdout Phase 9.1, cette escalade
    porte le rappel strict de 66,7 % à 100 %, avec 0 faux positif.
- **Fiabilité sans infrastructure lourde.** L'outbox est transactionnelle. Le chemin rapide est
  synchrone. La reprise réutilise le cycle, le ticket, le bail et le registre de l'automation déjà
  installés.
- **Isolation.** Une requête utilisateur ne peut toucher que **son** produit et ne déclenche
  jamais de rejeu global.

**Alternatives écartées :**

- persister le `needs_review` déterministe : il gèle le fingerprint (F-1) et cause des faux
  négatifs après escalade ;
- modifier l'orchestrateur avec une option « defer » : cela casserait l'invariant « orchestrateur
  v1 inchangé », alors que le store suffit ;
- trigger DB qui appelle l'Edge via pg_net : c'est la surface pg_net critiquée en 16.33 ;
- RPC SQL qui fait le matching : cela dupliquerait le matcher TS.

---

## 6. Exact data flow

```text
[mobile] INSERT owned_products (RLS)                                    ─┐ même transaction
   └─ trigger AFTER INSERT → private.owned_product_recall_checks         ─┘
        (revision = 1, status = pending, attempts = 0, next_attempt_at = now())
   ← 201 produit enregistré            [UI : "Produit enregistré — vérification en cours"]

[mobile] supabase.functions.invoke('check-owned-product', { ownedProductId })   (best-effort)
   └─ Edge : vérifie JWT → sub
        └─ policy = productionMatcherPolicy(env)
             ≠ phase_10_guarded_v1 → 503 policy_unavailable (job reste pending)
        └─ RPC claim_owned_product_recall_check(product, sub)                 [service_role]
             - produit absent ou propriétaire ≠ sub → not_found (aucune fuite d'existence)
             - control.enabled = false → disabled
             - job complete pour la révision courante → complete (aucun travail)
             - bail vivant → busy ; backoff non échu → not_due
             - quota utilisateur dépassé → rate_limited
             - sinon → claimed { lease_token, revision, cursor_recall_id }
        └─ processRecallMatches(
             { maxRecalls ≤ 100, maxCandidatePairs ≤ 100, maxNebiusCalls: 0,
               afterRecallId: cursor, recallNoticeIds: null },
             { store: ProductScopedRecallMatchingStore(product), modelId: PINNED_MODEL,
               createNemotronEvaluator: neverCalled })
             pour chaque recall R ∈ get_owned_product_recall_batch(product):
               garde TS retrieveRecallCandidates          (inchangée)
               buildEvidenceFingerprint                   (inchangée)
               claim_recall_match_evaluation              (inchangée)
                 unchanged → résolu | busy/stale → non résolu | missing → résolu
               evaluateDeterministicMatch                 (inchangée)
                 confirmed/rejected → finalize_recall_match_evaluation (inchangée)
                                      → recall_matches upsert (+ alerte atomique si confirmed)
                                      → alerts_enqueue_confirmed_push (inchangé)
                 needs_review       → defer_recall_match_evaluation (nouvelle)
                                      → bail libéré, report enregistré,
                                        pending_recalls upsert(R) → pipeline hybride existant
        └─ RPC complete_owned_product_recall_check(product, lease, revision, outcome)
             - révision changée entre-temps → reste pending (réarmé), sans erreur
             - recalls non résolus (busy/stale/failure/limit hors report) → retrying,
               attempts + 1, backoff, curseur conservé
             - 8e tentative non résolue → failed (épuisé, réarmable)
             - sinon → complete { completed_revision, completed_at }
        ← { monitoringState, alertsCreated, reviewPending }
   [UI : "Surveillé — aucun rappel correspondant trouvé dans les sources actuellement
          surveillées" | "Rappel détecté" | "Vérification complémentaire en cours"]

[serveur, chaque cycle run-recall-automation] (étape bornée, après matching, avant push)
   └─ process-owned-product-checks : list_due_owned_product_recall_checks(limit)
        → même claim / orchestrateur / complete, sans user_id (chemin administratif)
   └─ les recalls reportés dans pending_recalls sont traités par l'étape matching du même cycle
      ou du suivant (hybride gardé dans le budget de control)

[nouveau recall après création du produit]
   └─ pipeline recall-first inchangé : ingestion → pending → get_recall_candidates → …
```

Le **curseur** `cursor_recall_id` permet de dépasser 100 recalls candidats en plusieurs passes. Il
n'avance que jusqu'au plus grand id dont tous les prédécesseurs sont résolus. Les paires déjà
finalisées répondent `unchanged`, donc chaque passe progresse.

---

## 7. DB changes

Une seule migration, additive et forward-only :
`supabase/migrations/2026100Xxxxxxx_phase_17_7a_owned_product_recall_check.sql`. Aucun corps de
RPC ni aucune donnée existante n'est modifié.

### Tables (schéma `private`, RLS activé, `revoke all` de public, anon, authenticated et service_role)

```text
private.owned_product_check_control (singleton)
  enabled boolean not null default false
  max_recalls_per_check int not null default 100 check (1..100)
  max_pairs_per_check   int not null default 100 check (1..200)
  max_user_checks_per_hour int not null default 60 check (1..600)
  max_drain_products_per_run int not null default 25 check (1..100)
  updated_at timestamptz

private.owned_product_recall_checks
  owned_product_id uuid primary key references public.owned_products(id) on delete cascade
  user_id uuid not null            -- copie défensive, vérifiée égale au propriétaire au claim
  matching_revision bigint not null default 1 check (> 0)
  status text not null check (status in ('pending','running','complete','failed'))
  attempt_count int not null default 0 check (>= 0)          -- tentatives non résolues
  next_attempt_at timestamptz not null default now()
  lease_token uuid, lease_expires_at timestamptz             -- les deux null ou les deux non null
  cursor_recall_id uuid
  completed_revision bigint, completed_at timestamptz
  policy_version text                                        -- 'phase_10_guarded_v1' à la complétion
  last_error_code text check (in ('busy','stale','failure','limit','not_reached',
                                  'policy_unavailable','disabled'))
  exhausted_at timestamptz
  created_at, updated_at timestamptz
  check ((status = 'complete') = (completed_revision = matching_revision))  -- via trigger de garde

private.owned_product_recall_check_deferrals
  owned_product_id uuid references public.owned_products(id) on delete cascade
  recall_notice_id uuid references public.recall_notices(id) on delete cascade
  matching_revision bigint not null
  deferred_at timestamptz not null default now()
  primary key (owned_product_id, recall_notice_id)

private.owned_product_check_invocations   (journal en append-only pour le quota et l'audit)
  seq bigint identity pk, owned_product_id uuid, user_id uuid null, path text check in ('user','drain'),
  outcome text, recorded_at timestamptz default now()
  -- trigger append-only (même helper que 16.33), purge > 30 jours documentée
```

Un report est **résolu** quand un `recall_matches` existe pour la paire avec
`evaluated_at >= deferred_at`. C'est une règle dérivée : `finalize` n'est pas modifiée.

### Trigger sur `owned_products`

- `owned_products_arm_recall_check_insert` : `AFTER INSERT FOR EACH ROW`. Insère le job
  (`revision = 1`).
- `owned_products_arm_recall_check_update` : `AFTER UPDATE OF brand, product_name, category, gtin,
model_number, serial_number, lot_number, purchase_date, identification_method FOR EACH ROW WHEN
(old.* IS DISTINCT FROM new.* sur ces colonnes)`.
  - Fait `matching_revision + 1`, passe à `status = pending`, remet `attempt_count = 0`,
    `exhausted_at = null`, `cursor_recall_id = null` et `next_attempt_at = now()`.
  - Supprime les reports de l'ancienne révision.
  - Ces colonnes sont **exactement** celles de `projectOwnedProduct`, donc du fingerprint v1.
- Fonction `private.arm_owned_product_recall_check()` : `SECURITY DEFINER`, `search_path = ''`,
  une seule instruction d'upsert, aucune référence au matcher, `revoke all`.

Colonnes **non** déclenchantes : `purchase_country_code`, `scan_date`, `image_path`,
`identification_confidence`, `safety_attributes`. Aucune n'est lue par v1 (voir la note du cas 14).

### Index

- `recall_notices_title_fts_idx` : GIN `to_tsvector('simple', title)`.
- `recall_scopes_normalized_brand_idx` : expression de marque normalisée, partiel
  `where brand is not null`.
- `recall_scopes_has_range_idx` : `(recall_notice_id)` partiel `where serial_from is not null or
serial_to is not null or lot_from is not null or lot_to is not null`.
- `owned_product_recall_checks_due_idx` : `(status, next_attempt_at)` partiel
  `where status in ('pending','running')`.

### RPC (`SECURITY DEFINER`, `search_path = ''`, signature fixe)

| RPC                                                                                                                                                                                              | Grant                          | Rôle                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_owned_product_recall_batch(p_owned_product_id, p_after_recall_id, p_limit)`                                                                                                                 | service_role                   | Pré-filtre de parité. Même forme de retour que `get_recall_matching_batch`. Sources autoritatives seulement. Ordre par id, limite ≤ 100.                           |
| `get_owned_product_matching_row(p_owned_product_id)`                                                                                                                                             | service_role                   | Forme `get_recall_candidates` (colonnes, `owned_product_updated_at`, `exact_rank`).                                                                                |
| `claim_owned_product_recall_check(p_owned_product_id, p_user_id, p_lease_seconds)`                                                                                                               | service_role                   | `p_user_id` non null pour le chemin utilisateur (propriété vérifiée), null pour le drain. Contrôle, quota, backoff, bail.                                          |
| `defer_recall_match_evaluation(p_owned_product_id, p_recall_notice_id, p_evidence_fingerprint, p_lease_token, p_expected_product_updated_at, p_expected_recall_updated_at, p_check_lease_token)` | service_role                   | Valide le bail de paire **et** le bail du job, supprime le bail de paire, upsert le report et `pending_recalls`. N'écrit jamais dans `recall_matches` ni `alerts`. |
| `complete_owned_product_recall_check(p_owned_product_id, p_lease_token, p_revision, p_resolved uuid[], p_unresolved jsonb, p_deferred uuid[])`                                                   | service_role                   | Valide exclusivité et raisons (même discipline que `record_recall_automation_matching_outcome`). Transitions décrites en §6.                                       |
| `list_due_owned_product_recall_checks(p_limit)`                                                                                                                                                  | service_role                   | Jobs dus, épuisés au plus une fois par 24 h.                                                                                                                       |
| `get_my_product_monitoring_states(p_owned_product_ids uuid[] default null)`                                                                                                                      | authenticated                  | Filtre `owner = auth.uid()`. Renvoie l'état dérivé (§10), jamais de fingerprint, de bail ni d'autre utilisateur.                                                   |
| `private.owned_product_check_status(p_now)`                                                                                                                                                      | aucun (opérateur, comme 16.33) | Compteurs pending, retrying, failed, reports et outcomes sur 24 h.                                                                                                 |

### RLS et contraintes

- Aucune policy nouvelle sur une table publique. Les tables `private` ne sont accessibles que par
  les RPC.
- `alerts` : `user_id` reste dérivé dans finalize et vérifié par `ensure_alert_owner`.
- Backfill : un job `pending` pour chaque produit existant (production : 0 ligne).

---

## 8. Edge changes

| Fichier                                                                                                                         | Changement                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_shared/recallMatching/productCheck.ts` (nouveau)                                                                              | `runOwnedProductCheck(claim, deps)` : bornes issues du contrôle, appel de `processRecallMatches` inchangé, classement résolu, non résolu ou reporté, complétion. Pur et testable sous Node.                                                                                                                                                     |
| `_shared/recallMatching/productScopedStore.ts` (nouveau, interface pure) + `check-owned-product/store.ts` (adaptateur Supabase) | `ProductScopedRecallMatchingStore`. Délègue claim et finalize au `SupabaseRecallMatchingStore` existant. Intercepte **uniquement** `needs_review` vers `defer`.                                                                                                                                                                                 |
| `check-owned-product/index.ts` (nouveau)                                                                                        | POST seul. Vérifie `Authorization: Bearer` par `auth.getUser(jwt)`, qui fait autorité dans la fonction (le réglage `verify_jwt` de la passerelle sera fixé à l'implémentation selon la doc Supabase en vigueur). Accepte `{ ownedProductId }` (UUID) et rejette tout autre champ. Vérifie la politique. Réponse minimale. Pas de push immédiat. |
| `process-owned-product-checks/index.ts` (nouveau)                                                                               | Clé `x-recall-matching-key` en temps constant. Draine jusqu'à `max_drain_products_per_run`. Compteurs agrégés seulement.                                                                                                                                                                                                                        |
| `_shared/automation/orchestrator.ts`, `run-recall-automation/children.ts` et `store.ts`                                         | Nouvelle étape `productChecks` facultative, après le matching et avant le push. Son échec donne `partial_success`, `error_step = 'product_checks'`, et **n'affecte ni le watermark ni `pending_recalls`**.                                                                                                                                      |
| `supabase/config.toml`                                                                                                          | Déclaration des deux fonctions.                                                                                                                                                                                                                                                                                                                 |
| **Inchangés**                                                                                                                   | `process-recall-matches/*`, `orchestrator.ts`, `fingerprint.ts`, `projection.ts`, `_shared/matching/*`, v2.                                                                                                                                                                                                                                     |

**Pas de push depuis `check-owned-product`.** L'utilisateur voit le résultat dans l'app. La ligne
de `push_alert_queue` créée par le trigger existant part au prochain cycle. Supprimer ce push
redondant est une décision de 17.5 (D4).

---

## 9. Mobile changes (minimales, sans l'UX complète de 17.5)

- `src/data/ProductMonitoringRepository.ts` et `SupabaseProductMonitoringRepository.ts` :
  - `requestCheck(productId)` → `functions.invoke('check-owned-product')`, sans jamais lever vers
    le flux d'enregistrement ;
  - `getStates(productIds?)` → RPC `get_my_product_monitoring_states`.
- `src/domain/types.ts` : type `ProductMonitoringState`.
- Écran de création et d'édition : après un `create()` réussi, ou un `update()` qui change une
  colonne de matching, appel fire-and-forget de `requestCheck`. L'enregistrement est **déjà**
  confirmé à l'utilisateur.
- Liste produits : au focus, `getStates()`, puis `requestCheck` pour au plus 3 produits en
  `pending_check` ou `retrying` dus.
- Libellés provisoires (formulation prudente imposée) :
  - « Produit enregistré — vérification en cours »
  - « Surveillé — aucun rappel correspondant trouvé dans les sources actuellement surveillées »
  - « Rappel détecté »
  - « Vérification complémentaire en cours »
  - « Vérification en attente — nouvel essai automatique »
- Lire la doc Expo v57 versionnée avant d'écrire ce code (AGENTS.md).

---

## 10. Idempotency, retry and product monitoring states

### Idempotency strategy

| Niveau      | Garantie                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Paire       | fingerprint v1 identique entre les chemins → `unchanged`. UNIQUE `(product, notice)`.                                                          |
| Alerte      | UNIQUE `recall_match_id`. finalize réutilise l'alerte existante.                                                                               |
| Job         | une ligne par produit, versionnée par `matching_revision`. `complete` à la révision courante court-circuite tout appel suivant (zéro travail). |
| Concurrence | bail de job (un seul worker par produit) en plus des baux de paire existants (chemin produit contre chemin recall).                            |
| Complétion  | n'est acceptée que si `p_revision = matching_revision` et que le bail est valide. Sinon, le job reste pending pour la nouvelle révision.       |
| Report      | PK `(product, recall)`. L'upsert de `pending_recalls` réarme selon la règle 16.33 (`last_affected_at`).                                        |

### Retry strategy

- **Chemin rapide** : un appel juste après l'insert.
- **Client** : relance au focus pour les jobs dus de ses propres produits (au plus 3).
- **Serveur** : chaque cycle d'automation draine les jobs dus.
- **Backoff après tentative non résolue** : 1 min, 5 min, 30 min, 2 h, 6 h, puis 6 h. Le chemin
  utilisateur respecte `next_attempt_at` avec un plancher de 30 s.
- **Épuisement** : 8 tentatives non résolues donnent `failed` et `exhausted_at` (aligné sur 16.33).
  Le drain retente au plus une fois par 24 h. Toute modification d'une colonne de matching
  réarme le job. Ce n'est **jamais** une suppression.
- **Erreurs non transitoires** (`policy_unavailable`, `disabled`) : le job reste `pending` sans
  compter de tentative.

### Product monitoring states (dérivés par `get_my_product_monitoring_states`)

Ordre de priorité, du premier au dernier :

| État                        | Condition                                                                                                    | Sens pour l'utilisateur                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `recall_detected`           | il existe un `recall_matches` `confirmed` **actuel** avec alerte pour ce produit (quelle que soit l'origine) | « Rappel détecté »                                                              |
| `check_failed`              | job `failed` (épuisé)                                                                                        | vérification impossible pour l'instant, nouvel essai automatique quotidien      |
| `retrying`                  | job `pending` ou `running` avec `attempt_count > 0`                                                          | « nouvel essai automatique »                                                    |
| `pending_check`             | job `pending` ou `running` avec `attempt_count = 0`, y compris `disabled` et `policy_unavailable`            | « vérification en cours »                                                       |
| `review_pending`            | job `complete`, mais un report de la révision courante n'est pas encore résolu par le pipeline               | « vérification complémentaire en cours » (jamais « aucun rappel »)              |
| `monitored_no_known_recall` | job `complete` à la révision courante, sans confirmation actuelle ni report ouvert                           | « aucun rappel correspondant trouvé dans les sources actuellement surveillées » |

Champs annexes : `last_checked_at` et `unconfirmed_candidate_count` (paires `needs_review`
finalisées par le pipeline). 17.5 décidera comment les afficher. `monitored_no_known_recall`
n'affirme **jamais** l'absence de rappel dans le monde.

---

## 11. Security model

- **Authentification.** JWT utilisateur vérifié dans la fonction. Aucune clé de service ou
  administrative côté mobile.
- **Autorisation.** Le propriétaire est vérifié **en base**, dans le claim, à partir du `sub` du
  JWT vérifié. Un produit d'autrui et un produit inexistant donnent la même réponse
  (`not_found`).
- **Surface minimale.**
  - Le corps de requête ne contient qu'un UUID. Bornes, politique, budget IA (0) et plafonds
    viennent du serveur.
  - Il n'existe **aucune** entrée « rejouer tous les recalls » ni « tous les utilisateurs ».
  - L'Edge administratif garde la clé de matching existante et n'est jamais appelé par le mobile.
- **Isolation.** Une vérification ne lit que la ligne du produit demandé et des recalls
  autoritatifs publics. Les alertes ne vont qu'au propriétaire (finalize et `ensure_alert_owner`).
  La réponse ne contient que des compteurs du produit de l'appelant.
- **Abus.**
  - Un job `complete` court-circuite tout appel suivant.
  - Le backoff s'applique entre deux tentatives.
  - Le quota est de 60 vérifications par heure et par utilisateur (journal append-only).
  - Le coût par vérification est borné (≤ 100 recalls, zéro IA).
- **Kill switches.** `owned_product_check_control.enabled` (défaut `false`), `control.enabled` de
  l'automation pour le drain, et la politique `RECALL_MATCHING_POLICY` (le chemin produit ne
  s'exécute qu'en `phase_10_guarded_v1`).
- **Pas de pg_net.** Le chemin produit n'ajoute aucune requête dans la file `net` (16.33 §3).
- **Données.** Aucune nouvelle donnée personnelle. Les journaux ne contiennent que des compteurs.

### Décisions à trancher avant implémentation

- **D1. Conjonction des critères (cas 5 et 6).** Le chemin produit hérite de v1 **à l'identique** :
  un GTIN exact confirme même si le scope déclare une plage de lots ou une fenêtre de fabrication
  non renseignée (§2.D). Ajouter une garde plus stricte au seul chemin produit créerait deux
  applicabilités divergentes, ce qui est interdit. **Recommandation :** parité v1 dans 17.7a, plus
  un test de caractérisation qui épingle le comportement. La conjonction stricte arrivera avec
  l'activation de v2, puis un chemin produit v2 (phase ultérieure, le store étant déjà orienté
  politique). Si ce risque est jugé inacceptable, il faut le corriger **dans v1 pour les deux
  chemins**, par une phase dédiée qui versionne le fingerprint.
- **D2. Juridiction (cas 15).** Même logique : pas de filtre de juridiction propre au chemin
  produit (F-2).
- **D3. Deux produits identiques du même utilisateur (cas 10).** Recommandation : **une alerte par
  ligne `owned_products`** (chaque ligne est un objet physique), ce qui découle déjà de l'UNIQUE
  `(product, notice)`. Le regroupement visuel relève de 17.5.
- **D4. Push redondant** après une détection in-app. Le laisser partir (comportement Phase 11
  actuel) ou le marquer comme vu : à décider en 17.5.

---

## 12. Tests

### Unitaires (Node, `tests/phase-17-7a-product-check.test.mjs`, faux store en mémoire)

- `processRecallMatches` est appelé avec `maxNebiusCalls = 0`. `createNemotronEvaluator` n'est
  **jamais** invoqué.
- Un `needs_review` n'atteint **jamais** `finalize_recall_match_evaluation` et passe par `defer`.
- Le fingerprint calculé par le chemin produit est égal au fingerprint du chemin recall pour la
  même paire.
- Classement résolu, non résolu ou reporté. Avancement du curseur. Bornes issues du contrôle.
- Parseur de requête : un UUID seul, rejet des champs supplémentaires.
- Hash de contrôle des sources inchangées : `orchestrator.ts`, `fingerprint.ts`, `projection.ts`
  et `_shared/matching/*` sont identiques à `HEAD`.

### Deno (`tests/phase-17-7a-check-owned-product.test.ts`)

Vérification JWT (absent, invalide, expiré), 405, corps invalide, politique v2 → 503, réponse sans
données sensibles.

### pgTAP (`supabase/tests/phase-17-7a-owned-product-recall-check.sql`)

- Le trigger arme le job à l'insert et réarme seulement sur les colonnes de matching. Un échec de
  job ne bloque pas un insert valide.
- Privilèges : chaque RPC n'est exécutable que par les rôles prévus. Les tables `private` sont
  inaccessibles, y compris à service_role.
- `get_my_product_monitoring_states` : isolation entre utilisateurs. Positionner
  `request.jwt.claims` dans pgTAP et utiliser `auth.uid()`, jamais les GUC `request.jwt.claim.*`
  hérités.
- **Parité du pré-filtre** sur une matrice de fixtures (GTIN, modèle, plage serial, plage lot,
  marque, nom du scope, titre, et chaque négatif).
- Transitions claim et complete : révision, bail, backoff, quota, épuisement, réarmement.
- `defer` : aucun `recall_matches` ni `alerts` écrit, bail libéré, `pending_recalls` upserté et
  réarmé.
- Les tests Phase 10, 12 et 16.33 existants passent sans modification.

### Matrice des 18 cas critiques

| #   | Cas                                            | Niveau                     | Attendu                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GTIN exact rappelé                             | pgTAP + E2E local          | `confirmed`, 1 alerte, état `recall_detected`                                                                                                                                                                                                      |
| 2   | GTIN différent                                 | unitaire + pgTAP           | pas de candidat, ou `rejected` si un autre signal existe ; 0 alerte                                                                                                                                                                                |
| 3   | modèle exact et nom compatible                 | unitaire + pgTAP           | `confirmed`. Modèle seul : `needs_review` → reporté, 0 alerte                                                                                                                                                                                      |
| 4   | modèle incorrect                               | unitaire                   | aucun candidat par le modèle ; 0 alerte                                                                                                                                                                                                            |
| 5   | modèle + lot ou date requis                    | unitaire (caractérisation) | décision **égale** à celle du chemin recall. Lot hors plage : `rejected` ; lot ambigu : `needs_review`. Comportement v1 sur un lot manquant épinglé (D1)                                                                                           |
| 6   | critère officiel incomplet ou complexe         | unitaire                   | `additionalCriteria` complexes : `needs_review` → reporté, 0 alerte automatique                                                                                                                                                                    |
| 7   | produit sans GTIN                              | unitaire + pgTAP           | aucune alerte inventée ; seuls les autres identifiants peuvent jouer                                                                                                                                                                               |
| 8   | rappel déjà alerté                             | pgTAP                      | `unchanged` ou alerte `existing` ; toujours 1 alerte                                                                                                                                                                                               |
| 9   | même produit vérifié deux fois                 | pgTAP + E2E local          | 2e appel : `complete`, zéro claim de paire                                                                                                                                                                                                         |
| 10  | deux produits identiques, même utilisateur     | pgTAP                      | 2 matches et 2 alertes, une par ligne (D3)                                                                                                                                                                                                         |
| 11  | deux utilisateurs avec le même GTIN            | pgTAP + Deno               | A ne peut vérifier le produit de B (`not_found`). L'alerte de A ne va qu'à A. La vérification de A n'évalue pas B                                                                                                                                  |
| 12  | suppression du produit pendant la vérification | pgTAP (2 sessions)         | claim ou finalize renvoie `missing` ; job et reports en cascade ; aucune erreur visible                                                                                                                                                            |
| 13  | réédition d'un identifiant                     | pgTAP                      | révision + 1, job `pending`, nouveaux fingerprints. Une complétion de l'ancienne révision est refusée                                                                                                                                              |
| 14  | modification cosmétique                        | pgTAP                      | `purchase_country_code`, `scan_date`, `image_path`, `identification_confidence` et `safety_attributes` ne réarment pas. **Note :** v1 n'a pas de « nom d'affichage » séparé ; `product_name` est une entrée du matcher et réarme donc légitimement |
| 15  | source ou juridiction non applicable           | pgTAP                      | source non autoritative : jamais listée, 0 alerte. Juridiction : non évaluée par v1 (D2), test documentaire                                                                                                                                        |
| 16  | matcher indisponible                           | unitaire + pgTAP           | erreur RPC ou bail `busy` : job `retrying`, backoff, produit intact, aucune décision partielle                                                                                                                                                     |
| 17  | ancien recall présent avant le produit         | E2E local                  | trouvé à la création (Thule 8877, GTIN `091021037090`) : `confirmed` et alerte                                                                                                                                                                     |
| 18  | nouveau recall après le produit                | pgTAP + Node               | le pipeline recall-first inchangé le trouve. Croisement des deux chemins : `unchanged`, sans doublon                                                                                                                                               |

Cas supplémentaires :

- report → le pipeline évalue en hybride (mock), finalise, et l'état passe de `review_pending` à
  l'état final ;
- la politique v2 bloque le chemin produit ;
- `control.enabled = false` laisse les jobs en pending ;
- le curseur dépasse 100 recalls.

### End-to-end local

Stack locale, `supabase functions serve` des deux nouvelles fonctions et de
`process-recall-matches`, sans `NEBIUS_API_KEY`.

1. Ingestion du recall 8877.
2. Inscription d'un utilisateur de démo.
3. Ajout du produit Thule.
4. Appel de `check-owned-product` : `recall_detected`, 1 alerte.
5. Rappel identique : `complete` sans travail.
6. Un second utilisateur ne voit rien.
7. Étape de drain : aucun doublon.

Tout est rejoué par `npm run check:all`.

---

## 13. Migration / rollback plan

- **Installation** (phase ultérieure, « GO » par étape, jamais pendant 17.7a) :
  1. migration ;
  2. install-check en lecture seule ;
  3. déploiement des deux fonctions ;
  4. déploiement de l'automation avec l'étape `productChecks` ;
  5. publication mobile.

  `enabled` reste `false` : tout est inerte. L'activation est un « GO » séparé.

- **Ordre sûr.** La migration seule n'a aucun effet visible, à part l'armement de jobs que rien ne
  consomme. Les fonctions déployées avec `enabled = false` répondent `disabled`. Un mobile qui
  appelle une fonction absente ou désactivée enregistre quand même le produit.
- **Rollback immédiat.** `enabled = false`. Le chemin recall-first n'est jamais affecté.
- **Rollback structurel** (migration forward-only de retrait) : suppression des deux triggers.
  Les tables restent inertes ou sont supprimées. `recall_matches` et `alerts` déjà créés restent
  valides : ce sont des décisions v1 ordinaires.
- **Aucun backfill destructif.** Aucune RPC existante n'est modifiée. Les fingerprints existants
  sont inchangés.

---

## 14. Production risk

| Risque                                                    | Niveau         | Mitigation                                                                                          |
| --------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| Trigger sur `owned_products` dans la transaction d'insert | moyen → faible | une seule instruction d'upsert, aucun I/O, pgTAP, rollback par suppression du trigger               |
| Divergence du pré-filtre (faux négatifs)                  | moyen → faible | test de parité exhaustif sur fixtures ; garde TS et matcher inchangés                               |
| Nouvel endpoint JWT (premier de ce type dans le dépôt)    | moyen          | propriété vérifiée en base, corps à un UUID, quota, zéro IA, bornes serveur, tests Deno             |
| Étape ajoutée à l'automation 16.33                        | moyen          | étape isolée, son échec n'affecte ni le watermark ni `pending_recalls`, tests 12 et 16.33 inchangés |
| Alertes v1 « GTIN sans lot » plus fréquentes (D1)         | à décider      | identiques au chemin recall-first : risque déjà accepté en production, désormais atteint plus tôt   |
| Charge                                                    | faible         | ≤ 100 recalls par vérification, index, quota                                                        |
| Production pendant 17.7a                                  | **nul**        | aucune action                                                                                       |

---

## 15. Files expected to change (implémentation, phase suivante)

**Nouveaux :**

- `supabase/migrations/2026100X…_phase_17_7a_owned_product_recall_check.sql`
- `supabase/functions/_shared/recallMatching/productCheck.ts`
- `supabase/functions/_shared/recallMatching/productScopedStore.ts`
- `supabase/functions/check-owned-product/index.ts`, `store.ts`
- `supabase/functions/process-owned-product-checks/index.ts`
- `supabase/tests/phase-17-7a-owned-product-recall-check.sql`
- `supabase/remote-install-checks/phase-17-7a-…sql` (lecture seule)
- `tests/phase-17-7a-product-check.test.mjs`, `tests/phase-17-7a-check-owned-product.test.ts`
- `src/data/ProductMonitoringRepository.ts`, `src/data/SupabaseProductMonitoringRepository.ts`

**Modifiés :**

- `supabase/config.toml`
- `supabase/functions/_shared/automation/orchestrator.ts`, `types.ts`
- `supabase/functions/run-recall-automation/children.ts`, `store.ts`
- `src/domain/types.ts`, `src/data/index.ts`
- `src/features/products/ProductScreens.tsx` (appel post-enregistrement)
- `src/features/products/ProductsScreen.tsx` (états et relance au focus)
- `package.json` (scripts de test)
- `docs/automatic-recall-loop.md`, `docs/recall-matching.md`

**Explicitement inchangés :**

- `_shared/matching/*`
- `_shared/recallMatching/orchestrator.ts`, `fingerprint.ts`, `projection.ts`
- `process-recall-matches/*`
- toutes les migrations existantes
- v2

---

## 16. Estimated implementation size

| Bloc                                                        | Estimation                          |
| ----------------------------------------------------------- | ----------------------------------- |
| Migration (tables, trigger, 8 RPC, index)                   | ~450 à 600 lignes SQL               |
| pgTAP (dont la matrice de parité)                           | ~120 à 160 assertions               |
| Edge (module partagé, store, 2 fonctions, étape automation) | ~450 à 550 lignes TS                |
| Tests Node et Deno                                          | ~400 lignes                         |
| Mobile (repository, appels, libellés provisoires)           | ~150 à 200 lignes                   |
| Total                                                       | ~1 600 à 1 900 lignes, 2 à 3 passes |

**Découpage recommandé :**

- **17.7a-1** : DB, chemin rapide Edge et mobile, avec relance client.
- **17.7a-2** : drain serveur et étape d'automation.

Chacune se termine par `check:all` au vert et un stop report, sans aucune action en production.

---

## Safe confirmation contract

Phase 17.7a-R1. Audit, tests locaux et conception. Aucune écriture production, aucune migration,
aucun deploy, aucun commit.

**Preuves produites :**

- `tests/phase-17-7a-safe-confirmation.test.mjs` : **35/35 PASS**. Les tests épinglent le
  comportement **actuel** et la sortie sûre attendue. Aucun code runtime n'est modifié.
- `tests/finding-f1-ai-budget-fingerprint-freeze.test.mjs` : **1/1 PASS**. Il reproduit F-1.
- Lectures seules de production (MCP `execute_sql`, `SELECT` uniquement) le 2026-10-02 : schéma à
  32 migrations, dernière `20261001090000`.

### SC-1. D1 reproduit : conditions obligatoires ignorées par v1

Pour chaque cas, le tableau donne trois résultats :

- **v1 actuel** : `evaluateDeterministicMatch` inchangé, sur un scope structuré ;
- **v2 core sur des critères revus** : `evaluateDeterministicMatchV2` inchangé, sur un `all_of`
  explicite ;
- **sortie sûre sans preuve de complétude** : ce que doit produire le chemin produit.

| Cas | Situation                                               | v1 actuel       | v2 core (critères revus) | Sortie sûre sans preuve de complétude |
| --- | ------------------------------------------------------- | --------------- | ------------------------ | ------------------------------------- |
| A   | GTIN exact, l'avis ne déclare qu'un GTIN                | `confirmed`     | `confirmed`              | `unsupported_scope` → needs_review    |
| B   | GTIN exact + lot exigé, produit sans lot                | **`confirmed`** | `needs_review`           | `incomplete_evidence`                 |
| C   | GTIN exact + lot exigé, mauvais lot                     | `needs_review`  | `rejected`               | `human_review_required`               |
| D   | GTIN exact + lot exigé, bon lot                         | `confirmed`     | `confirmed`              | `unsupported_scope` → needs_review    |
| E   | GTIN exact + fenêtre de fabrication, date absente       | **`confirmed`** | `needs_review`           | `incomplete_evidence`                 |
| F   | GTIN exact + fenêtre de fabrication, date hors plage    | **`confirmed`** | `rejected`               | `human_review_required`               |
| G   | GTIN exact + fenêtre de fabrication, date dans la plage | `confirmed`     | `confirmed`              | `unsupported_scope` → needs_review    |

**Mécanisme (code inchangé) :**

- `evaluateRange` (`evidence.ts`) retourne sans produire d'item quand le produit n'a pas de lot.
  B est donc confirmé.
- Un lot hors plage crée un conflit, et la règle « conflit + identifiant matché » donne
  `needs_review` (C).
- `manufactured_from/to` n'est jamais comparé : la date d'achat n'est pas une date de fabrication,
  et v1 ne lit pas `safety_attributes.manufacture_date`. E, F et G sont donc confirmés.
- **F est un faux positif démontré** : produit prouvé hors de la fenêtre, et pourtant confirmé.

**Autres faits établis par les tests :**

- **Retenue d'un rejet.** Un rejet v2 sur des règles dont la couverture est incomplète est retenu
  (`rejectionWithheld`) et devient `needs_review`.
- **Abstention sans critères revus.** Sur les mêmes scopes, sans critères revus, v2 core répond
  toujours `needs_review`.
- **Forme réelle de l'avis 8877** (13 scopes UPC « recall-level » et un scope nom) : v1 confirme sur
  le GTIN, même pour un produit fabriqué en 2017.
- **Allowlist v2 live** (`validateLiveReviewedCriteriaV2`) : elle accepte un critère `model_number`
  revu (contrôle positif) et **refuse** aujourd'hui les critères revus `gtin`, `lot_number` et
  `manufacture_date`.

### SC-2. D2 reproduit : la juridiction est invisible pour v1

| Cas                      | v1 actuel                 | Sortie sûre exigée                         |
| ------------------------ | ------------------------- | ------------------------------------------ |
| recall US, acheté aux US | `confirmed`               | `eligible_for_deterministic_confirmation`  |
| recall US, acheté au CA  | `confirmed` (pays ignoré) | `jurisdiction_mismatch` (jamais d'alerte)  |
| recall CA, acheté au CA  | `confirmed`               | `eligible_for_deterministic_confirmation`  |
| recall CA, acheté aux US | `confirmed` (pays ignoré) | `jurisdiction_mismatch`                    |
| pays d'achat inconnu     | `confirmed`               | `incomplete_evidence` (sauf avis `GLOBAL`) |

- `projectOwnedProduct` et `projectOwnedProductForProductionV2` n'exposent pas
  `purchase_country_code`. Le fingerprint v1 est identique pour US, CA et null.
- **Forme production Health Canada.** Les 62 scopes HC portent des clés `source_*` dans
  `additional_criteria`, que v1 traite comme « complexes ». Un GTIN exact y donne donc
  `needs_review`. C'est un effet de bord, pas une règle de juridiction.

**Règle de compatibilité de juridiction pour le nouveau chemin.**

Entrées : J = lignes `recall_notice_jurisdictions` de l'avis ; c = `purchase_country_code`.

| Condition                                                          | Résultat                                  |
| ------------------------------------------------------------------ | ----------------------------------------- |
| J vide                                                             | `unsupported_scope`                       |
| `GLOBAL ∈ J`                                                       | compatible, y compris quand c est inconnu |
| c inconnu (sans `GLOBAL`)                                          | `incomplete_evidence`                     |
| c ∈ pays(J)                                                        | compatible                                |
| J ne contient que des régions sans table d'appartenance officielle | `human_review_required`                   |
| sinon                                                              | `jurisdiction_mismatch`                   |

**La prose ne rend jamais un avis multi-juridiction.** Exemple : l'avis 8877 dit « about 880 were
sold in Canada » et pointe vers un rappel conjoint Health Canada qui n'est pas ingéré. Ses lignes de
juridiction restent `US` seulement, donc un achat au Canada donne `jurisdiction_mismatch` pour
**cet** avis.

### SC-3. Règle de confirmation sûre

**CANDIDATE ≠ CONFIRMED.** Ni un pré-filtre ni un GTIN exact ne confirment seuls.

```text
isSafeForAutomaticConfirmation(product, notice, servedRuleSets) ->
  eligible_for_deterministic_confirmation
  | incomplete_evidence | unsupported_scope | jurisdiction_mismatch | human_review_required
```

La porte **n'évalue aucun critère** et ne duplique pas le matcher. Elle décide seulement si un
`confirmed` du moteur déterministe peut devenir automatique. Ses vérifications, dans l'ordre :

1. **Source.** Source non autoritative → `unsupported_scope`. Ces avis sont déjà exclus du
   listing.
2. **Juridiction.** Règle de SC-2.
3. **Complétude prouvée de la portée.**
   - Chaque scope canonique de l'avis doit être servi par `get_recall_v2_scopes` avec une
     enveloppe `recall_rule_sets_v1`.
   - Cette enveloppe doit être validée par `validateLiveRuleSetEnvelopeV2`, sans modification.
   - Et donner `projection.coverageComplete === true`.
   - Sinon → `unsupported_scope`.

   Ce drapeau est la **seule preuve positive** de complétude du dépôt. Il exige le ledger de
   couverture 16.13 (`complete`, positifs `independent`, `negativeEvidenceEligible`), l'absence de
   règle écartée, et l'attestation humaine 16.33 sur les sections que le recensement ne lit pas.
   Les descriptions en prose, comme le « sans autocollant QC2020 » de l'avis 8877, en font partie.

4. **Ambiguïté.** Un ensemble `ambiguous`, une règle écartée ou une validation en échec →
   `human_review_required`.

**Décision finale du chemin produit :**

```text
gate = isSafeForAutomaticConfirmation(...)
v2   = evaluateRuleSetsPairV2(product, projection)          // bibliothèque v2 inchangée
decision =
  gate === eligible                  ? v2.decision           // confirmed | rejected | needs_review
                                     : 'needs_review'        // jamais confirmed, jamais rejected
reason   = gate !== eligible ? gate
         : v2 needs_review avec critère requis 'missing' ? 'incomplete_evidence'  // lu dans v2.criterionEvaluations
         : v2 needs_review                                ? 'human_review_required'
         : null
alerte   = decision === 'confirmed' uniquement
```

**Propriétés exigées (tests de propriété en 17.7a-1) :**

- **Monotonie.** {confirmed du chemin produit} ⊆ {confirmed de v2}. La porte ne peut que
  rétrograder, jamais promouvoir.
- **Pas de critère obligatoire ignoré.** Un `confirmed` exige `coverageComplete` **et** tous les
  critères requis d'une règle revue `matched` (contrat `all_of` de v2).
- **Absence n'est pas preuve.** Une colonne vide, un `additional_criteria` sans clé de restriction
  ou une description non parsée ne prouvent jamais qu'une restriction est absente.
- **Juridiction.** Une juridiction incompatible ou inconnue ne produit jamais d'alerte.

### SC-4. Sources de critères en production (lecture seule, 2026-10-02)

| Source                                                 | État en production                                                                                                                                                                                                          | Peut établir la portée complète ?                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `recall_scopes`                                        | 103 avis (CPSC 41, HC 62), 116 scopes : 13 GTIN (un seul avis, 8877), **0** modèle, **0** plage lot/serial, **0** fenêtre de fabrication, 103 noms                                                                          | **Non.** Ce sont des structures partielles, et l'absence d'un champ ne prouve rien. |
| `additional_criteria`                                  | CPSC : `association`, `evidence_level`, `manufacturer_names`, `source_category_id`, `source_product_type`. HC : `source_archived`, `source_category`, `source_date_semantics`, `source_organization`, `source_recall_class` | **Non.** Ce sont des métadonnées de source, pas des conditions d'applicabilité.     |
| `owned_products.safety_attributes`                     | côté produit seulement (variante, couleur, taille, capacité, batterie, port, vis, `date_code`, `manufacture_date`, `production_date`)                                                                                       | Sans objet : c'est une preuve produit, pas une portée.                              |
| Critères revus v2                                      | `recall_scope_criteria_v2` : **0** ; `recall_scope_rule_sets_v2` : **0** ; 18 candidats `unreviewed` (aucun pour 8877) ; 0 ligne de ledger de revue ; 0 autorisation de relecteur                                           | **Oui, seulement s'ils sont revus avec `coverageComplete`.** Aujourd'hui : aucun.   |
| Champs canoniques (titre, description, danger, remède) | prose ; pour 8877, la description contient la fenêtre et l'autocollant                                                                                                                                                      | **Non**, de façon automatique : rien n'est parsé en critères.                       |
| `raw_payload` officiel conservé                        | `Products[].Model` vide 30/30 (audit 16.8) ; `ProductUPCs` recall-level ; `NumberOfUnits` et `Inconjunctions` donnent des indices de juridiction                                                                            | **Non.** C'est une preuve à relire, pas une structure fiable.                       |
| Preuves de page CPSC                                   | 1 révision de page pour 8877, **0** candidat extrait (numéros produit, date code YY/MM et autocollant hors des classes extraites)                                                                                           | **Seulement via** candidats, revue humaine, ledger de couverture et attestation.    |

**Conclusion honnête.** Aujourd'hui, **aucun** avis en production n'a une portée prouvée complète.
Le chemin produit ne confirmerait donc **rien** automatiquement. Il signalerait les correspondances
plausibles (par exemple le GTIN de 8877) en `needs_review`, sans alerte. C'est le comportement sûr
attendu, pas un défaut du design.

### SC-5. Utiliser v2 pour le chemin produit : est-ce propre ?

**Verdict : propre, à cinq conditions explicites. C'est même la seule option sans duplication.**

1. **Aucune activation globale.**
   - `RECALL_MATCHING_POLICY` reste `phase_10_guarded_v1`.
   - `process-recall-matches` et le pipeline recall-first v1 sont inchangés.
   - Le chemin produit est gouverné par son propre interrupteur (`owned_product_check_control`,
     défaut `false`).
2. **Même bibliothèque, sans copie.** Le chemin réutilise tels quels :
   - côté calcul : `projectOwnedProductForProductionV2`, `retrieveRecallCandidates`,
     `validateLiveRuleSetEnvelopeV2`, `projectRecallRuleSetsForProductionV2`,
     `evaluateRuleSetsPairV2` et `ruleSetsFingerprintV2` ;
   - côté RPC installées (vérifié : `20260923142030`, `20260923160000`, `20260926090000`
     présentes en production, sans contrôle de politique) : `get_recall_v2_scopes`,
     `get_owned_product_evidence_v2`, `claim_recall_match_evaluation`,
     `finalize_recall_match_evaluation_v2` et `create_recall_v2_alert`.
3. **Le seul code nouveau** est un orchestrateur mince à produit unique (I/O et contrôle de flux),
   la porte (juridiction + drapeaux de complétude, sans évaluation de critère) et le fingerprint
   composite. `processRecallMatchesV2` n'est pas réutilisé tel quel : il n'a ni point d'insertion
   pour la porte ni le compte rendu résolu/non résolu de 16.33. La porte dans le store aurait été
   un comportement caché.
4. **Persistance v2 séparée.** Les écritures vont dans `recall_match_evaluations_v2`, les
   éligibilités et `recall_alert_snapshots_v2`, **jamais** dans `recall_matches` ni `alerts` (v1).
   Les fingerprints v1 et Phase 16 sont intacts. Le fil `get_recall_safety_feed_v2` affiche déjà
   une seule ligne par paire et fusionne une éventuelle alerte v1 (`no_longer_confirmed`,
   `confirmed_alert`). `create_recall_v2_alert` refuse si une alerte v1 existe déjà pour la paire.
5. **Zéro IA.** Aucun import de fournisseur, aucun `hybrid_guarded_v2`.

**Ce qui serait une seconde sémantique dangereuse, et que ce design évite :**

- une porte qui interprète elle-même des critères ;
- un renvoi des `needs_review` vers v1, qui confirmerait 8877 sur GTIN seul ;
- une confirmation v2 sans `coverageComplete` sur ce chemin ;
- une écriture dans les tables v1.

**Divergence résiduelle acceptée, et pourquoi elle est sûre.** Pour une même paire, le chemin
produit peut dire `needs_review` alors que le pipeline recall-first v1 confirmera plus tard. La
divergence va toujours dans le sens prudent pour le nouveau chemin. Le risque v1 lui-même préexiste
(voir SC-9) et n'est pas aggravé.

**Limite connue.** L'allowlist live n'accepte aujourd'hui que des critères revus `model_number` et
`date_code`, ancrés sur un modèle. Un produit identifié **seulement** par GTIN ne pourra donc jamais
être confirmé automatiquement tant qu'une classe de critère GTIN revue n'aura pas été approuvée.
Ce serait une phase de conception séparée : les UPC CPSC sont « recall-level » et non associés à
un produit.

### SC-6. Avis GTIN de production : CPSC 8877 (audit en lecture seule)

| Élément                           | Constat (données publiques)                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avis                              | CPSC RecallID 8877, n° 20-164, « Thule Recalls Strollers Due to Injury Hazard », 2020-08-12, source autoritative et active                                                                                                                                                             |
| GTIN                              | 13 UPC valides : `091021037090`, `091021070585`, `091021079779`, `091021091900`, `091021190214`, `091021349001`, `091021433137`, `091021460256`, `091021514386`, `091021648937`, `091021761773`, `091021883703`, `091021978485`. Ils sont recall-level et figurent **sur l'emballage** |
| Restrictions officielles          | **(1)** fabriqué entre mai 2018 et septembre 2019 (date code YY/MM sur l'étiquette) ; **(2)** **sans** autocollant QC2020 près de l'étiquette ; contexte : Thule Sleek, numéros produit `11000001-5`, `11000017`, `11000330`, `11000337-342`                                           |
| Lot / serial / modèle             | aucun lot ni serial ; modèle API vide ; numéros produit en prose seulement (raccourcis non développés)                                                                                                                                                                                 |
| Structuré en base                 | 14 scopes : 13 GTIN seuls (`association`/`evidence_level: recall`) et 1 nom. **0** fenêtre de fabrication, **0** condition d'autocollant                                                                                                                                               |
| Juridiction                       | ligne `US` (pays) ; la prose mentionne environ 880 unités vendues au Canada et un rappel conjoint Health Canada (73641r) **non ingéré**                                                                                                                                                |
| Revue v2                          | aucune : 0 critère v2, 0 règle, 0 candidat de page, 0 revue ; 1 révision de page                                                                                                                                                                                                       |
| Données structurées suffisantes ? | **Non.** Deux conditions obligatoires sont absentes de la structure, et l'une d'elles (l'autocollant) n'a aucune classe de critère ni aucun champ produit                                                                                                                              |
| Comportement v1 actuel            | un produit Thule avec l'un de ces GTIN est **`confirmed`** avec alerte (épinglé par le test de forme 8877)                                                                                                                                                                             |

**Classification : `NEEDS_REVIEW`.** Un GTIN exact présent dans l'avis officiel rend la
correspondance plausible et digne d'être signalée. En revanche, la portée structurée est
**insuffisante** pour une confirmation automatique : fenêtre de fabrication et autocollant non
structurés, rien de revu ni d'attesté. Ce n'est jamais `SAFE_AUTO_CONFIRM`.

**Usage E2E.** 8877 peut servir honnêtement à **un seul** E2E : « GTIN exact → `needs_review` →
correspondance possible, aucune alerte ». Il **ne doit plus** servir de démonstration
« confirmed → alerte ». La démonstration de la Phase 10 confirmait précisément ce cas dangereux.
Le E2E « confirmed » utilisera une fixture locale **synthétique**, étiquetée comme telle : une
règle revue complète passée par le chemin ledger et coverage en pgTAP local.

### SC-7. Décision : contrat B, avec porte de complétude et de juridiction

**Le contrat A (porte + matcher v1) est rejeté.** Pour empêcher v1 de confirmer sur un GTIN seul,
la porte devrait connaître et comparer les critères revus, c'est-à-dire réimplémenter v2. Une porte
fondée sur les seules structures v1 ne peut pas prouver la complétude (SC-4).

**Contrat retenu (B+) :**

```text
product (outbox job, JWT owner-checked)
  -> candidats : pré-filtre de parité (get_owned_product_recall_batch) + garde TS retrieveRecallCandidates
  -> pour chaque avis candidat :
       servedRuleSets = get_recall_v2_scopes(notice) -> validateLiveRuleSetEnvelopeV2 (inchangé)
       projection     = projectRecallRuleSetsForProductionV2 (inchangé)
       gate           = isSafeForAutomaticConfirmation(product.country, notice.jurisdictions, projection)
       fingerprint    = sha256({ v2: ruleSetsFingerprintV2(...), gate: { version: 'product_check_gate_v1',
                                  purchaseCountry, noticeJurisdictions(triées) } })
       claim_recall_match_evaluation (inchangé) -> unchanged | busy | stale | missing | claimed
       v2             = evaluateRuleSetsPairV2 (inchangé)
       decision       = gate eligible ? v2.decision : needs_review  (+ reason)
       finalize_recall_match_evaluation_v2 (inchangé) -> create_recall_v2_alert si confirmed (inchangé)
  -> complete_owned_product_recall_check
```

**Changements d'architecture par rapport à la première conception (§5 à §12) :**

| Élément                | Avant R1                                                                  | Après R1                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moteur                 | `processRecallMatches` v1 via un store produit                            | primitives v2 inchangées, orchestrateur mince à produit unique, porte SC-3                                                                         |
| `needs_review`         | renvoyé à `pending_recalls`, donc au pipeline v1                          | **persisté en v2** avec sa raison ; **aucun** renvoi vers v1 ; aucune IA                                                                           |
| Persistance            | `recall_matches` et `alerts` v1                                           | `finalize_recall_match_evaluation_v2` et `create_recall_v2_alert` (installées, non gouvernées par la politique)                                    |
| RPC supprimée          | `defer_recall_match_evaluation`, table des reports                        | supprimées                                                                                                                                         |
| Colonnes de réarmement | projection v1 (dont `category`, `purchase_date`, `identification_method`) | entrées v2 et porte : `brand`, `product_name`, `gtin`, `model_number`, `serial_number`, `lot_number`, `safety_attributes`, `purchase_country_code` |
| Fingerprint            | fingerprint v1 partagé                                                    | composite v2 + entrées de la porte. Le fingerprint v2 contient déjà la révision produit et la révision avis                                        |
| Contrôle F-1           | contourné par le report                                                   | sans objet : pas d'orchestrateur v1, pas d'IA                                                                                                      |
| Nouvelle RPC           | —                                                                         | aucune pour la juridiction : `recall_notice_jurisdictions` est lisible par le service ; ajout d'une colonne au batch produit                       |

**États de surveillance du produit (révision de §10) :**

| État                                          | Condition                                                                                                          | Libellé prudent                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `recall_detected`                             | alerte v2 confirmée actuelle, ou alerte v1 encore confirmée                                                        | « Rappel détecté »                                                                                        |
| `possible_match_needs_verification`           | au moins une évaluation `needs_review` actuelle avec identifiant matché (GTIN, modèle…) ou `jurisdiction_mismatch` | « Correspondance possible avec un rappel officiel — vérification nécessaire » (aucune alerte, aucun push) |
| `check_failed` / `retrying` / `pending_check` | inchangés (§10)                                                                                                    | inchangés                                                                                                 |
| `monitored_no_known_recall`                   | job complet, aucune évaluation confirmée ni plausible                                                              | « Aucun rappel correspondant trouvé dans les sources actuellement surveillées »                           |

`review_pending` (lié au report) est supprimé. 17.5 choisit l'UX de
`possible_match_needs_verification`, en affichant les conditions officielles et le lien vers
l'avis.

**Immédiateté.** Elle est garantie pour les avis dont la portée est **réellement** complète
(revue, `coverageComplete`). Aujourd'hui, il n'en existe aucun en production. La valeur immédiate
du chemin produit est donc de **signaler** les correspondances plausibles sans fausse alerte. Les
confirmations automatiques viendront avec les revues humaines v2.

**Révisions de la matrice des 18 cas (§12) :**

- **Cas 1, 3, 5, 6 et 15** : gouvernés par SC-1 à SC-3.
  - Cas 1 : `confirmed` **seulement** avec une règle revue complète. Sinon `needs_review` et
    `possible_match_needs_verification`.
  - Cas 5 et 6 : `incomplete_evidence` ou `human_review_required`, 0 alerte.
  - Cas 15 : `jurisdiction_mismatch`, 0 alerte.
- **Cas 17** : 8877 → `needs_review` (pas d'alerte). Fixture synthétique revue → `confirmed`.
- **Cas 18** : le pipeline recall-first v1 reste inchangé. Croisement des deux chemins : aucune
  double alerte côté v2 (`create_recall_v2_alert` voit l'alerte v1), et le fil v2 affiche une
  seule ligne par paire.
- **Ajouts** :
  - test de propriété « monotonie » ;
  - parité pré-filtre (inchangée) ;
  - E/F/G avec `safety_attributes.manufacture_date` (la classe `manufacture_date` n'est pas
    servie en live aujourd'hui, donc `needs_review`) ;
  - juridiction SC-2 complète, dont `GLOBAL` et les régions.

**Fichiers et taille :**

- Ajouts : `_shared/recallMatching/productCheckV2.ts` (orchestrateur mince) et
  `_shared/recallMatching/productCheckGate.ts` (porte pure).
- Suppressions par rapport au design initial : store produit v1, `defer` et table des reports.
- Estimation : inchangée à ±10 %, soit environ 1 600 à 1 900 lignes. La migration perd la table des
  reports et la RPC `defer`. Le TS gagne la porte et ses tests.

### SC-8. F-1 (suivi séparé)

Le défaut F-1 est documenté dans
[docs/findings/f-1-ai-budget-fingerprint-freeze.md](findings/f-1-ai-budget-fingerprint-freeze.md) :
fichier, reproduction, impact et correction envisagée. Sa reproduction est
`tests/finding-f1-ai-budget-fingerprint-freeze.test.mjs`. Il n'est **pas** corrigé, et il n'est
pas mêlé à 17.7a.

### SC-9. Risque préexistant à trancher (hors 17.7a)

Le pipeline recall-first v1 de **production** confirme aujourd'hui sur un GTIN seul, sans
juridiction (SC-1, SC-2). Concrètement : si un utilisateur possède un produit Thule avec l'un des
13 GTIN et que l'avis 8877 est réaffecté (révision CPSC, ou réingestion `updated`), v1 créera une
alerte automatique en ignorant la fenêtre de fabrication et l'autocollant. Cela vaut aussi pour un
achat au Canada.

- Le chemin produit R1 ne crée pas ce risque et ne l'aggrave pas.
- Il ne le supprime pas non plus.
- Le corriger exige une décision dédiée sur v1, qui toucherait les fingerprints Phase 16 et une
  politique versionnée.

**Recommandation :** ouvrir F-4, « v1 confirme sur des scopes recall-level sans conditions
structurées ». Production actuelle : 0 produit, donc 0 exposition réalisée.
