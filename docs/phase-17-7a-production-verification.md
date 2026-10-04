# Phase 17.7a-1 + 17.7a-2 — Installation et vérification en production

**Statut :** **terminé.** Les deux phases sont installées, vérifiées et activées en production :
`product_check_enabled = true` depuis le 2026-10-04 à 17:31:02 UTC, avec
`max_product_check_candidates = 25`. Une seule fiche reste ouverte, F-5, non bloquante.

**Preuve machine :**
[releases/phase-17-7a-1/post-install-verification.json](../releases/phase-17-7a-1/post-install-verification.json).
Le test `tests/phase-17-7a-1-release-gate.test.mjs` en dérive `productionReady`.

**Plan suivi :** [phase-17-7a-production-install-plan.md](phase-17-7a-production-install-plan.md),
avec un GO séparé pour chaque écriture.

**Conventions de ce document :** heures en UTC ; aucune donnée personnelle (les identifiants sont
tronqués ou absents).

## 1. Installation (2026-10-03)

| Étape                          | Résultat                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GO 17.7A1-MIGRATION`          | `20261002120000` appliquée à 14:20:51 depuis l'arbre de staging `6bab7d3` (dry-run : cette seule migration). P1 : **25/25**                                                                                    |
| `GO 17.7A2-MIGRATION`          | `20261003090000` appliquée à 14:31:28. P2 : **28/28**. Fonction de plan : `SECURITY DEFINER`, `stable`, `search_path=""`, propriétaire `postgres`, ACL `postgres` et `service_role` uniquement                 |
| `GO 17.7A-CHECK-OWNED-PRODUCT` | v1, ezbr `b5703800…`, arbre runtime `b029ef38…` (17 fichiers), `verify_jwt=false`                                                                                                                              |
| `GO 17.7A-PRODUCT-WORKER`      | v1, ezbr `998e5ae0…`, arbre runtime `1b02f970…` (17 fichiers), `verify_jwt=false`                                                                                                                              |
| `GO 17.7A-AUTOMATION`          | v14 → **v15**, ezbr `5622e99c…`, arbre runtime `96875b00…`, construit depuis les **octets exacts** de la v14 (`37a79b95…`) ; 5 fichiers changés, `request.ts` identique ; variables d'environnement identiques |
| `GO 17.7A-REMOTE-VERIFY`       | P2 28/28 ; les 3 bundles identiques octet pour octet ; suite pgTAP distante **90/90**, en rollback ; pgTAP absent ensuite, 0 transaction idle, 0 fixture résiduelle                                            |

**Résultat :** 35 migrations, historique `a07eb32d…` identique au dépôt. F-4 inchangée : 5
triggers, empreinte composite `627cbc06…`, inventaire 0.

### Correction procédurale : octets exacts d'une Edge Function déployée

Pour toute comparaison octet pour octet d'un bundle déployé, utiliser **uniquement** :

- `supabase functions download <fn> --use-api` (dépaquetage côté serveur) ;
- ou l'API `get_edge_function`.

**Ne jamais utiliser** le `supabase functions download` par défaut, qui passe par Docker. Avec la
CLI 2.119, il renvoie des sources **transpilées** (types retirés, formatage changé).

**Incident concret :** au `GO 17.7A-AUTOMATION`, le stager a refusé ces octets transpilés
(« not the recorded v14 runtime tree; stop ») avant tout deploy. Le téléchargement avec
`--use-api` a ensuite rendu les 6 fichiers runtime identiques au release Gate A.

## 2. Phase avec le flag à `false`

### P4 — premier run naturel de la v15 (2026-10-03 18:17)

- Cron runid 67 ; ticket consommé une seule fois ; run `12879c39…` en `success`.
- v15 démarrée en 32 ms, HTTP 200.
- `productCheck.status = "disabled"`, `attempted: false`, `claimed: 0`.
- Worker **non appelé**.
- CPSC sans 502 sur ce run.

**Second run naturel (00:17) :** même résumé. La v23 a été appelée naturellement pour 12 nouveaux
avis, avec 0 paire candidate.

**Résultat : PASS.**

### T1 — parcours utilisateur réel avec le flag à `false` (2026-10-04 07:37)

- Produit créé par l'app (`POST owned_products` → 201), sans écriture SQL directe.
- Trigger d'armement : tâche `pending`, rév. 1, `attempts` 0, événement `armed/trigger`.
- `check-owned-product` v1 appelée 8 fois par l'app, toutes en HTTP 200 :
  - JWT validé par Auth ;
  - propriété acceptée ;
  - RPC sur la branche `disabled` : **0 claim**, 0 matching, état `pending_check`.

**Résultat : PASS.**

### P5 — run naturel avec une vraie tâche due (2026-10-04 12:17)

- Run `e405941b…` en `success`.
- `productCheck.status = "disabled"`, worker non appelé.
- La tâche T1 est restée **intacte** : `updated_at` inchangé, `attempts` 0, aucun bail, un seul
  événement.

**Résultat : PASS.**

## 3. Activation (`GO 17.7A-ACTIVATE`, 2026-10-04 17:31:02)

**Préconditions vérifiées :**

- app fermée, aucun processus `com.silversys.recall` ;
- Metro arrêté ;
- aucune invocation depuis 08:50 ;
- T1 `pending` avec `attempts` 0.

**Écriture unique :** `update private.recall_automation_control set product_check_enabled = true …
where singleton and product_check_enabled = false`. Une seule ligne modifiée.

**Juste après :** T1 intacte, aucun événement, aucun bail, aucune Edge Function modifiée.

**Rollback préparé**, non utilisé : la même ligne avec `false`.

## 4. T2 — première exécution réelle du worker (2026-10-04 18:17)

- Cron runid 71 ; ticket consommé une seule fois ; run `defc6550…` en `success`. Aucune course
  avec l'app : 0 appel entre 17:31 et le claim.
- `process-owned-product-checks` v1 : **première invocation réelle**.
  - démarrage en 66 ms ;
  - HTTP 200 en 1311 ms ;
  - appelé par le runtime Edge, `x-recall-matching-key` acceptée ;
  - aucun log `WARN` ou `ERROR`.
- Chaîne RPC : plan → `claim_due` → preuves → candidats (1) → scopes v2 → `complete`. Aucun claim
  de paire ni finalize.
- `productCheck = { status: "completed", enabled: true, attempted: true, claimed: 1, completed: 1,
possibleMatches: 0, confirmedAlerts: 0, maxProducts: 3, durationMs: 1356 }`.
- `aiCalls = 0` : le validateur de l'automation l'impose.
- Tâche T1 :
  - `pending` → `running` → **`complete`** ;
  - `attempts` 0 → 1 ; `completed_revision` 1 ; `checked_at` 18:17:05.686 ;
  - aucun bail ni curseur résiduel.
- Événements : `armed/trigger` → `claimed/worker` → `completed/worker`.
- État final : **`monitored_no_known_recall`**.
- 0 match, 0 évaluation v2, 0 alerte, 0 push. F-4 intacte.

**Résultat : PASS.**

## 5. T3 — chemin immédiat de l'app avec le flag à `true` (2026-10-04 18:55)

- Nouveau produit créé par l'app (`a3eeb506…`). T1 n'est pas modifiée.
- **36 candidats**, tous de rang 1 (signal faible) : 21 CPSC et 15 Health Canada, 0 critère revu.

| Appel                          | Détail                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (à l'enregistrement)         | HTTP **200** en 2936 ms. JWT 200, propriété acceptée, `claimed/user`. **25** candidats examinés (25 lectures de scopes), issue `continued/user`, curseur durable, `attempts` remis à 0 |
| 2 (focus de l'onglet Products) | `claimed/user`. Reprise **exacte** après le 25ᵉ candidat : **11** lectures de scopes, aucun des 25 premiers rejoué. Puis `completed/user`                                              |

**Tâche T3 après le second appel :**

- `complete`, `attempts` 1, `completed_revision` 1 ;
- `checked_at` 18:57:59.713 ;
- curseur supprimé, aucun bail, `last_error` vide.

**Événements :** `armed/trigger` → `claimed/user` → `continued/user` → `claimed/user` →
`completed/user`.

**Résultat produit :** état final `monitored_no_known_recall`. Worker non appelé, aucun cron en
jeu, `aiCalls = 0`. 0 match, 0 évaluation v2, 0 alerte, 0 push.

**Idempotence après complétion :** non observée en conditions réelles. L'app n'a pas rappelé la
fonction : elle ne relance que les produits en `pending_check`. Le code prévoit `complete` → 200
sans claim.

**Résultat : PASS.** Constat UX associé : **F-5**.

## 6. F-5 et budget de candidats

Voir [findings/f-5-immediate-check-continuation.md](findings/f-5-immediate-check-continuation.md).

**Décision :** `max_product_check_candidates` **reste à 25** pour la Phase 17.7.

- Les mesures de T3 ne garantissent pas le coût dans le pire cas pour 100 candidats.
- Ce budget est partagé avec le worker.
- Il n'y a aucun tuning sans benchmark dédié.

**Correctif préféré pour 17.7b :** une auto-continuation bornée sur le chemin immédiat. Elle n'est
**pas** implémentée.

## 7. État final de production (2026-10-04 19:03)

| Élément           | Valeur                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contrôle          | `product_check_enabled = true`, `max_product_check_candidates = 25`                                                                              |
| Produits / tâches | 2 / 2, toutes deux `complete`, rév. 1, `attempts` 1, `completed_revision` 1, aucun bail ni curseur ; 8 événements                                |
| États             | 2 × `monitored_no_known_recall`                                                                                                                  |
| Sûreté            | 0 match, 0 évaluation, éligibilité ou snapshot v2, 0 alerte, 0 push, 0 livraison ; F-4 : 5 triggers, `627cbc06…`, inventaire 0                   |
| Référentiel       | 117 avis, 130 scopes                                                                                                                             |
| Edge              | `check-owned-product` v1, `process-owned-product-checks` v1, `run-recall-automation` v15, `process-recall-matches` v23 ; les 6 autres inchangées |
| Cron              | un seul job, `17 */6 * * *`, commande inchangée ; 77 runs                                                                                        |
| Migrations        | 35, dernière `20261003090000`                                                                                                                    |

`firstRealCandidateInvocationObserved` reste **`false`**. La v23 a été invoquée naturellement
(00:17 et 12:17 le 2026-10-04), mais toujours avec 0 paire candidate.
