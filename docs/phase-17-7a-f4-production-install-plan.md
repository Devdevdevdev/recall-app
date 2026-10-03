# Phase 17.7a F-4 — Plan d'installation production

**Statut :** plan préparé. **Aucune écriture production** dans cette passe : seulement des
lectures (`SELECT`, `list_migrations`, `list_edge_functions`, `get_edge_function`) et des
répétitions locales. Pas de migration distante, deploy, neutralisation, changement de secret ou
de cron, push ou commit.

**Base :** HEAD `553173c` (F-4 : `0f4b7b3`, `553173c`). La migration F-4 a ensuite été renommée en `20261002110000` (contenu identique) par le commit « Prepare controlled F-4 production installation », pour précéder 17.7a-1. `main` a 9 commits d'avance sur
`origin/main`.

**Règle d'exécution :** chaque écriture production exige un « GO » explicite et séparé. Après
chaque GO, on exécute l'étape, puis toutes ses vérifications en lecture seule, et on s'arrête
avant l'étape suivante.

Si la politique d'auto-mode refuse une commande (cela a été le cas pour `supabase functions
deploy` et `test:remote-pgtap`), elle n'est pas contournée : la commande exacte est remise à
l'opérateur.

## Vue d'ensemble

| #   | Étape                                                        | Écriture production   | GO                   |
| --- | ------------------------------------------------------------ | --------------------- | -------------------- |
| 1   | Préflight                                                    | non                   | —                    |
| 2   | Migration F-4 seule                                          | **oui**               | `GO F4-MIGRATION`    |
| 3   | Vérification post-migration                                  | non                   | —                    |
| 4   | Deploy `process-recall-matches` depuis l'arbre minimal       | **oui**               | `GO F4-EDGE`         |
| 5   | Vérification du bundle déployé                               | non                   | —                    |
| 6   | Inventaire de neutralisation                                 | non                   | —                    |
| 7   | Neutralisation, **seulement si l'inventaire est non vide**   | conditionnelle        | `GO F4-NEUTRALIZE`   |
| 8   | Suite distante post-installation (transaction annulée)       | **oui** (transitoire) | `GO F4-REMOTE-SUITE` |
| 9   | Vérification au prochain run naturel                         | non                   | —                    |
| 10  | Fermeture F-4 (enregistrement de vérification, release gate) | non (commit local)    | GO commit local      |

**Écritures production : 3** (2, 4 et 8), plus 1 conditionnelle (7) attendue nulle.

## 1. Préflight (lecture seule, 2026-10-03 vers 08:40 UTC)

| Contrôle                                                   | Production                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations                                                 | **32**, dernière `20261001090000` ; empreinte d'historique `md5(string_agg(version‖name))` = `6b985817894f081ab0b31e85af51b3a1`, identique à une base locale construite jusqu'à `20261001090000`            |
| F-4 installé                                               | **non** : aucune fonction `private.automatic_alert_*` / `require_safe_*` / `neutralize_*`, aucun trigger `*_require_safe_*`                                                                                 |
| 17.7a-1 installé                                           | **non** : pas de `private.owned_product_recall_checks`, pas de colonne `product_check_enabled`, donc aucun contrôle produit actif possible                                                                  |
| `process-recall-matches`                                   | **v22**, `ezbr_sha256` `0b83d930901394050cc559b38777f5cc60433302f77b9cb804d1ea52c81501c8` ; 39 fichiers runtime, arbre `d52ccb10a8abb8e691b4ec39854485180aa12f632dd97b98ba7b3f11cdf7e3cc`                   |
| Fonctions remplacées par F-4 (md5 de `pg_get_functiondef`) | finalize v1 `81082f84…050b4`, finalize v2 `f4215904…16f2ed`, `create_recall_v2_alert` `0d36551e…629c19`, `queue_recall_push_alerts` `54fed69a…d90e14`, **identiques** au dépôt à `20261001090000`           |
| Droits de finalize v1                                      | `postgres`, `service_role` ; aucun objet dépendant                                                                                                                                                          |
| Données métier                                             | 0 produit ; 0 match (par statut : vide) ; 0 alerte ; 0 file push ; 0 livraison push ; 0 évaluation v2 ; 0 éligibilité v2 ; 0 snapshot v2 ; 103 avis, 116 scopes, 0 règle revue                              |
| Contrôle automation                                        | `enabled`, `ai_enabled` et `push_enabled` à `true` ; plafonds 100 / 500 / 5 / 25                                                                                                                            |
| Cron                                                       | un seul : job 2 `recall-automation-every-6h`, `17 */6 * * *`, actif, md5 de la commande `aae24c40…6651` (tickets 16.34)                                                                                     |
| Recalls en attente                                         | 0                                                                                                                                                                                                           |
| 3 derniers runs                                            | `partial_success`, `source_partial_failure`, 0 paire, 0 alerte, 0 IA (06:17, 00:17, 18:17)                                                                                                                  |
| Worker de page                                             | `never_started`, `running: false` ; aucun cron de page ; source en échec (`source_http_502`, dernier succès 2026-10-02 00:17)                                                                               |
| `RECALL_MATCHING_POLICY`                                   | valeur de secret **non lisible** en lecture seule (aucun secret consulté). Indices de v1 actif et de v2 global inactif : 0 évaluation v2 et chemin d'automation v1. F-4 ne lit ni ne modifie cette variable |

**À refaire immédiatement avant `GO F4-MIGRATION`** : la même requête de préflight. Elle doit
redonner 32 migrations, F-4 absent, 0 confirmation, 0 alerte, 0 éligibilité, et aucun run en
cours (`private.recall_automation_lease` vide).

## 2. Migration F-4 (`GO F4-MIGRATION`)

**Fichier :** `supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql`.
**SHA-256 :** `622dc3893d47875c68899970b9724832ff9be872c4b75867a522854a210ca457`.

**Surface d'écriture SQL (DDL uniquement, aucune donnée métier) :**

| Type                         | Objets                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fonctions créées (`private`) | `automatic_alert_identifier`, `automatic_alert_jurisdiction`, `automatic_alert_rule_set_valid`, `automatic_alert_classification`, `automatic_alert_eligibility` (`SECURITY DEFINER`, `search_path = ''`), `require_safe_v1_alert`, `require_safe_v2_eligibility`, `require_safe_v2_alert_snapshot`, `require_safe_confirmation`, `neutralize_unsafe_automatic_alerts` (opérateur, **non exécutée**) |
| Fonctions remplacées         | `public.finalize_recall_match_evaluation` (**supprimée puis recréée**, même signature ; deux colonnes de résultat ajoutées en fin), `public.finalize_recall_match_evaluation_v2` (wrapper), `public.create_recall_v2_alert`, `public.queue_recall_push_alerts`                                                                                                                                      |
| Triggers créés               | `alerts_require_safe_scope` (`public.alerts`), `recall_matches_require_safe_confirmation` (`public.recall_matches`), `recall_alert_eligibility_v2_require_safe_scope`, `recall_alert_snapshots_v2_require_safe_scope`, `recall_match_evaluations_v2_require_safe_confirmation` (`private`)                                                                                                          |
| Grants / revokes             | finalize v1 : `revoke` (public, anon, authenticated), `grant execute` à service_role. Toutes les fonctions `private` F-4 : `revoke` (public, anon, authenticated, service_role). Les fonctions remplacées par `create or replace` gardent leurs droits                                                                                                                                              |
| Tables affectées             | aucune ligne ; triggers seulement sur `alerts`, `recall_matches`, `recall_alert_eligibility_v2`, `recall_alert_snapshots_v2`, `recall_match_evaluations_v2`                                                                                                                                                                                                                                         |

**Ordre des migrations.** F-4 porte la version `20261002110000` : elle se place juste après
16.34 (`20261001090000`) et **avant** 17.7a-1 (`20261002120000`). Le contenu est inchangé (SHA
`622dc389…`). L'ordre du dépôt est donc l'ordre réel d'installation : F-4 maintenant, 17.7a-1
plus tard, sans migration hors ordre.

Un `db push` depuis le dépôt appliquerait **les deux** migrations en attente ; or 17.7a-1 ne
doit pas être installée maintenant. On pousse donc depuis un **arbre de staging propre** où
17.7a-1 est mise à l'écart, comme en Phase 16.34 :

```bash
SCR=<scratchpad>; rm -rf "$SCR/f4-db-stage" && mkdir -p "$SCR/f4-db-stage"
REV=<SHA du commit « Prepare controlled F-4 production installation »>
git archive "$REV" supabase/migrations supabase/config.toml | tar -x -C "$SCR/f4-db-stage"
mkdir -p "$SCR/f4-db-stage/supabase/gated-migrations"
mv "$SCR/f4-db-stage/supabase/migrations/20261002120000_phase_17_7a_1_owned_product_recall_checks.sql" \
   "$SCR/f4-db-stage/supabase/gated-migrations/"
mkdir -p "$SCR/f4-db-stage/supabase/.temp" && cp supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version} "$SCR/f4-db-stage/supabase/.temp/"
shasum -a 256 "$SCR/f4-db-stage/supabase/migrations/20261002110000_phase_17_7a_f4_automatic_alert_safety.sql"   # = 622dc389…
npx supabase db push --linked --workdir "$SCR/f4-db-stage" --dry-run   # doit lister UNIQUEMENT 20261002110000
npx supabase db push --linked --workdir "$SCR/f4-db-stage"
```

Le dry-run distant fait partie de l'étape couverte par le GO : selon la version de la CLI,
`--linked` peut créer un rôle de connexion temporaire. Il n'a donc pas été exécuté dans cette
passe.

**Répétition locale (faite) :**

1. base locale ramenée à `20261001090000` ;
2. dry-run depuis l'arbre de staging : **uniquement F-4** ;
3. `db push --local` : appliqué → 33 migrations, F-4 présent, 17.7a-1 absent ;
4. suites F-4, successeur, distante, 10, 11, 13, 16-33 et 16-4 : **704/704 PASS**.

**Installation ultérieure de 17.7a-1 :** sa version (`20261002120000`) est postérieure à F-4.
Un `db push` normal l'appliquera dans l'ordre, sans `--include-all`. C'est répété en local :
16.34 → F-4 seule, puis 17.7a-1.

**Fenêtre :** hors de la minute :17 (cron). Contrôler qu'aucun run n'est en cours. Les tables
sont minuscules, donc les verrous des `create trigger` sont brefs.

**Risques :**

- **Compatibilité de la fonction déployée v22.** Pendant l'intervalle entre migration et deploy,
  l'ancienne fonction lit seulement les anciennes colonnes (compatible). Ses compteurs de run
  pourraient compter `confirmed` une paire stockée `needs_review` : c'est sans risque de sécurité,
  et peu probable avec 0 produit.
- **Coût.** La preuve n'est calculée que pour les décisions `confirmed`.
- **Échec partiel.** La migration s'exécute dans une transaction (`begin` / `commit`).

**Post-état attendu :**

- 33 migrations, dernière `20261002110000` ;
- 10 fonctions F-4 et 5 triggers ;
- finalize v1 avec 8 colonnes de résultat ;
- **aucune ligne métier modifiée**.

## 3. Vérification post-migration (lecture seule)

```sql
select
 (select count(*) from supabase_migrations.schema_migrations) = 33
   and (select max(version) from supabase_migrations.schema_migrations) = '20261002110000' as migration_recorded,
 to_regclass('private.owned_product_recall_checks') is null as product_check_not_installed,
 (select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O' and tgname in (
   'alerts_require_safe_scope','recall_alert_eligibility_v2_require_safe_scope',
   'recall_alert_snapshots_v2_require_safe_scope','recall_matches_require_safe_confirmation',
   'recall_match_evaluations_v2_require_safe_confirmation')) = 5 as triggers_enabled,
 (select prosecdef and proconfig = array['search_path=""'] and pg_get_userbyid(proowner) = 'postgres'
  from pg_proc where oid = 'private.automatic_alert_eligibility(uuid,uuid)'::regprocedure) as proof_definer_owner_path,
 not exists (select 1 from unnest(array['anon','authenticated','service_role']) r
  where has_function_privilege(r, 'private.automatic_alert_eligibility(uuid,uuid)', 'EXECUTE')
     or has_function_privilege(r, 'private.neutralize_unsafe_automatic_alerts(boolean)', 'EXECUTE')) as proof_not_executable_by_api,
 has_function_privilege('service_role', 'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.finalize_recall_match_evaluation(uuid,uuid,text,timestamptz,timestamptz,uuid,public.recall_match_status,numeric,text,jsonb,text,text,text,text)', 'EXECUTE') as finalize_v1_grants,
 (select jsonb_object_agg(p.proname, md5(pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in ('finalize_recall_match_evaluation','finalize_recall_match_evaluation_v2','create_recall_v2_alert','queue_recall_push_alerts'))
     or (n.nspname = 'private' and (p.proname like 'automatic_alert%' or p.proname like 'require_safe%' or p.proname = 'neutralize_unsafe_automatic_alerts'))) as definition_md5,
 (select count(*) from public.owned_products) as owned_products,
 (select count(*) from public.recall_matches) as matches,
 (select count(*) from public.alerts) as alerts,
 (select count(*) from private.recall_alert_eligibility_v2) as v2_eligibility,
 (select count(*) from private.recall_alert_snapshots_v2) as v2_snapshots,
 (select count(*) from public.recall_notices) as notices;
```

**Valeurs attendues :** tous les booléens à `true`, compteurs inchangés depuis le préflight, et
`definition_md5` égal aux empreintes relevées sur la répétition locale :

| Fonction                              | md5 attendu                        |
| ------------------------------------- | ---------------------------------- |
| `finalize_recall_match_evaluation`    | `fbd878906a7ea59b0a6dd310620107f3` |
| `finalize_recall_match_evaluation_v2` | `d4735250828425086d32c7d23ebd1f34` |
| `create_recall_v2_alert`              | `9d94fb32a269916d9389de148fe6a847` |
| `queue_recall_push_alerts`            | `6210d9aa0e05feefa714033dd07a5245` |
| `automatic_alert_eligibility`         | `b6a31c8dd6b5e631b0ec2a1038483353` |
| `automatic_alert_classification`      | `b1aac773a5ef98363a09fcb6b103355f` |
| `automatic_alert_rule_set_valid`      | `95556d9eec5e6ec6d48154d418e94235` |
| `automatic_alert_jurisdiction`        | `5a2a069346927d10c444d6ee33f7e6dc` |
| `automatic_alert_identifier`          | `f6c92bb32cbb4fb9c6007516480c198f` |
| `require_safe_v1_alert`               | `8cf3e3f4f07701f4cf37815ab9c7367c` |
| `require_safe_v2_eligibility`         | `ff4d5b3453a2c956cc2bfd5b3728539e` |
| `require_safe_v2_alert_snapshot`      | `d258b88b9bd3923081a8f104b60573a4` |
| `require_safe_confirmation`           | `3afa5ad918ee8d05702a10feba734784` |
| `neutralize_unsafe_automatic_alerts`  | `b47d299025b5530b53bfbb1df03512fe` |

Aucune alerte et aucun match historique ne peuvent avoir été supprimés : il n'y en avait aucun,
et la migration ne contient aucun `delete` sur ces tables (test).

## 4. Deploy `process-recall-matches` (`GO F4-EDGE`)

**Requis ?** **Pas pour la sécurité**, puisque la base impose F-4 seule. **Oui pour l'exactitude
opérationnelle** : la v22 compte la décision du matcher et non le statut stocké. Le ledger des
runs afficherait `confirmed` pour une paire retenue, et le compteur `safetyWithheld` serait
absent. Le deploy est recommandé, après la migration.

**Écart entre le dépôt et le bundle déployé (lecture seule, v22) :**

- 34 fichiers sont identiques à HEAD ;
- 3 fichiers sont identiques à l'état pré-F-4 (les fichiers F-4) ;
- **2 fichiers v2 sont plus anciens que HEAD** : `_shared/recallMatching/orchestratorV2.ts`
  (`5fa66740…` contre `1319a219…`) et `reviewedCriteriaV2.ts` (`ef6e9da5…` contre
  `a5ae805f…`).

**Un deploy depuis HEAD embarquerait donc du code v2 non prévu.** Le deploy F-4 est construit par
`scripts/stage-f4-edge-bundle.mjs` (local, non commité) :

- il part des **octets exacts du bundle v22** sauvegardés par `get_edge_function` ;
- il remplace **uniquement** les 3 fichiers F-4 :

  | Fichier                                  | Avant       | Après       |
  | ---------------------------------------- | ----------- | ----------- |
  | `_shared/recallMatching/orchestrator.ts` | `8b044008…` | `0af16c71…` |
  | `process-recall-matches/legacyRun.ts`    | `f1a8d047…` | `19a12b15…` |
  | `process-recall-matches/store.ts`        | `df8a7b60…` | `daa90146…` |

- il ajoute les 3 modules de types non embarqués par le bundler : `nebius/types.ts`,
  `push/types.ts`, `recallMatching/types.ts` ;
- il **refuse** tout fichier 17.7a-1 (`productCheck`, `check-owned-product`,
  `process-owned-product-checks`), le worker de page, `_shared/cpsc`, et les modules v2 plus
  récents (`ruleSetsV2`, `deterministicRuleSetsV2`).

Aucune activation v2 n'en résulte : `RECALL_MATCHING_POLICY` n'est pas touchée, et le code v2
déployé reste celui de la v22.

**Hashes :**

|                  | SHA-256 de l'arbre runtime (`sha256` de la liste triée `sha  path`, 39 fichiers) |
| ---------------- | -------------------------------------------------------------------------------- |
| **Actuel (v22)** | `d52ccb10a8abb8e691b4ec39854485180aa12f632dd97b98ba7b3f11cdf7e3cc`               |
| **Cible F-4**    | `81ff731ce714bbc283144fc6f25b9aff1b39af04760f4cdbe6488ca3a13dd9e5`               |

L'arbre cible passe `deno check` (fait). L'`ezbr_sha256` de Supabase après deploy n'est pas
prédictible ; la preuve est la comparaison fichier par fichier (étape 5).

**Commande (après GO ; remise à l'opérateur si la politique la bloque) :**

```bash
node scripts/stage-f4-edge-bundle.mjs <deployed-v22.json> "$SCR/f4-edge-stage"   # doit afficher 81ff731c…
mkdir -p "$SCR/f4-edge-stage/supabase/.temp" && cp supabase/.temp/project-ref "$SCR/f4-edge-stage/supabase/.temp/"
npx supabase functions deploy process-recall-matches --project-ref cnftnulgtsraurtusnpb \
  --no-verify-jwt --workdir "$SCR/f4-edge-stage"
```

**Juste avant le deploy :** relire le bundle (`get_edge_function`) et confirmer qu'il est toujours
la v22 avec l'arbre `d52ccb10…`. Sinon, on s'arrête et on refait le staging.

## 5. Vérification du bundle déployé (lecture seule)

`list_edge_functions` doit montrer une **version > 22**, avec `verify_jwt: false`.

`get_edge_function` doit donner :

- exactement 39 fichiers runtime ;
- l'arbre recalculé égal à **`81ff731c…`** ;
- les 36 fichiers non F-4 identiques à la v22 ;
- aucun chemin interdit.

Les autres fonctions doivent être inchangées : versions et `ezbr` de `run-recall-automation`
v14, `send-recall-notifications` v16, `process-recall-matches-v2-cohort` v11,
`process-cpsc-page-evidence` v12 et des ingestions. Aucun secret n'est modifié.

## 6. Inventaire de neutralisation (lecture seule, après la migration)

La migration ne l'exécute pas. Le jour de l'installation, mesurer, **sans appeler la routine** :

```sql
select 'v1_match' as kind, m.id, private.automatic_alert_eligibility(m.owned_product_id, m.recall_notice_id) as reason,
  exists (select 1 from public.alerts a where a.recall_match_id = m.id) as has_alert,
  exists (select 1 from public.alerts a join private.push_deliveries d on d.alert_id = a.id where a.recall_match_id = m.id) as push_attempted
from public.recall_matches m
where m.status = 'confirmed'
  and private.automatic_alert_eligibility(m.owned_product_id, m.recall_notice_id) <> 'eligible'
union all
select 'v2_eligibility', e.evaluation_id, private.automatic_alert_eligibility(e.owned_product_id, e.recall_notice_id),
  exists (select 1 from private.recall_alert_snapshots_v2 s where s.owned_product_id = e.owned_product_id and s.recall_notice_id = e.recall_notice_id),
  false
from private.recall_alert_eligibility_v2 e
where e.revoked_at is null
  and private.automatic_alert_eligibility(e.owned_product_id, e.recall_notice_id) <> 'eligible';
```

Le résultat ne contient que des identifiants techniques et des raisons, **aucune donnée
utilisateur**.

- **Attendu : 0 ligne.** Au préflight : 0 match, 0 alerte, 0 éligibilité. Pas de neutralisation.
- **Si > 0 : STOP** et demander `GO F4-NEUTRALIZE`. Exécution par l'opérateur :
  `select * from private.neutralize_unsafe_automatic_alerts(false)` (inventaire), puis `(true)`.
  La routine n'est jamais exécutée implicitement, et elle ne supprime aucune alerte.

## 7. Suite distante post-installation (`GO F4-REMOTE-SUITE`)

**Commande :** `npm run test:remote-pgtap` (`SUPABASE_DB_URL` fourni par l'opérateur, jamais
affiché ; remise à l'opérateur si bloquée).

**Nature (aucun bypass) :**

- une seule transaction (`begin` … `rollback`) ;
- pgTAP installé transitoirement, puis vérifié absent ensuite ;
- **aucune couture** : la suite refuse de s'exécuter si F-4 est absent ;
- aucune désactivation de trigger, aucune écriture d'alerte ou d'éligibilité ;
- seules lectures de la preuve : la vérification qu'aucune paire de fixture n'est prouvée.

**Fixtures temporaires (annulées) :**

- 3 utilisateurs `pgtap_phase16_*@example.invalid` avec sessions MFA de test ;
- une autorisation de relecteur transitoire ;
- une identité, un avis, une révision de page et des candidats CPSC fictifs (numéro inutilisé
  90000–99999, URL `…/Recalls/2099/pgtap-phase16-<uuid>`) ;
- un ledger de couverture, une revue, une matérialisation et une attestation ;
- 5 produits de fixture, avec baux et évaluations v2 (`needs_review` / `rejected`).

Aucune donnée réelle n'est lue ni affichée.

**Attendu :** **90/90**, pgTAP absent après le run, aucune session restée en transaction.

## 8. Vérification au prochain run naturel (aucun déclenchement manuel)

Au prochain cron (`:17`, toutes les 6 h), lire en lecture seule :

- la nouvelle ligne de `private.recall_automation_runs` : statut `success`, ou `partial_success`
  avec une erreur **non F-4**. La source CPSC est actuellement en échec 502, donc
  `source_partial_failure` est attendu ;
- `net._http_response` du job 2 : HTTP 200, aucune réponse 401 ou 500 ;
- les logs Edge (`query_logs`) de `run-recall-automation` et `process-recall-matches` : aucune
  erreur liée à F-4 ;
- `alerts`, `push_alert_queue` et `push_deliveries` : toujours 0 ;
- les invariants `pending_recalls` / `matching_outcomes` sont respectés (pas d'éjection d'un
  recall non résolu).

**Limite honnête :** avec 0 produit, le matcher n'aura aucune paire ; le run naturel prouve
l'absence de régression du chemin, pas la décision F-4. La décision F-4 est prouvée par la suite
distante (étape 7) et par les suites locales.

## 9. Rollback

**Rollback DB (`GO F4-ROLLBACK`) :** `supabase/gated-migrations/20261003000000_phase_17_7a_f4_rollback.sql`
(local, non commité, **jamais** dans `supabase/migrations`).

- Il supprime les 5 triggers et les 10 fonctions F-4.
- Il restaure les **définitions pré-F-4 exactes** de finalize v1 (suppression puis recréation,
  droits rétablis), du wrapper v2, de `create_recall_v2_alert` et de `queue_recall_push_alerts`.
- **Vérifié localement :** sur une base où F-4 est appliqué, puis le rollback, les 4 md5
  reviennent à `81082f84…`, `f4215904…`, `0d36551e…` et `54fed69a…`, les droits sont identiques,
  et il ne reste aucun objet F-4.
- **Application :** comme migration avant (copiée dans un arbre de staging et poussée, version
  `20261003000000`). La ligne d'historique F-4 reste : rollback « forward-only ».

**Rollback Edge :** redéployer la v22 exacte. On la reconstruit avec
`node scripts/stage-f4-edge-bundle.mjs <deployed-v22.json> <dir> --as-deployed`, qui donne
l'arbre `d52ccb10…` (vérifié). L'ancienne fonction reste compatible avec un schéma F-4 comme avec
un schéma pré-F-4.

**Conséquences si F-4 a déjà rétrogradé des évaluations :**

- **Réversible :** le schéma (triggers, fonctions) et le bundle Edge.
- **Non réversible, et c'est voulu :** les `recall_matches` et évaluations v2 stockés en
  `needs_review` avec la raison `Automatic alert withheld (…)` restent tels quels. Les
  évaluations v2 sont append-only, et les alertes ne sont jamais supprimées.
- **Ne jamais re-promouvoir automatiquement.** Aucune requête de rollback ne doit repasser une
  ligne retenue en `confirmed`. Après un rollback, v1 ne réévalue une paire que si son
  fingerprint change.
- **Aucune donnée utilisateur ou historique supprimée,** dans aucun sens.

## 10. Release gate et fermeture

F-4 ne passe « résolu » et `productionReady` ne peut devenir vrai que si :

- migration installée et vérifiée (étape 3) ;
- triggers actifs ;
- Edge F-4 déployé et arbre `81ff731c…` vérifié (étape 5) ;
- inventaire vide ou neutralisation traitée ;
- suite distante 90/90 ;
- run naturel conforme ;
- 0 alerte non sûre ;
- aucun bypass.

On produit alors `releases/phase-17-7a-f4/post-install-verification.json` :

```json
{
  "migrationVersion": "20261002110000",
  "migrationSha256": "622dc3893d47875c68899970b9724832ff9be872c4b75867a522854a210ca457",
  "edgeRuntimeTreeSha256": "81ff731ce714bbc283144fc6f25b9aff1b39af04760f4cdbe6488ca3a13dd9e5",
  "remoteSuite": "pass",
  "neutralizationInventory": [],
  "verifiedAt": "<ISO>"
}
```

Le test du gate vérifie déjà que `migrationSha256` égale l'empreinte du fichier local. Le JSON du
gate n'est **pas** modifié dans cette passe. 17.7a-1 reste `productionReady: false` jusqu'à son
propre enregistrement d'installation.

**Premier GO requis :** `GO F4-MIGRATION`, précédé d'un préflight identique relancé juste avant.

**Fichiers locaux créés par cette passe (non commités) :**

- `docs/phase-17-7a-f4-production-install-plan.md` ;
- `scripts/stage-f4-edge-bundle.mjs` ;
- `supabase/gated-migrations/20261003000000_phase_17_7a_f4_rollback.sql`.
