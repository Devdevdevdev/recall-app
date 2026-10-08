# Phase 17.3a — Scan identity foundation — Plan d'installation production

Commit candidat : `b440a2ff9f5d6274b4ada7f4e682dac6279ef498` (« Add scan identity provenance and
UPC-E support »), égal à `origin/main`, arbre propre.

Statut : **EXÉCUTÉ — phase CLOSED (2026-10-08).** Ce plan a été suivi :

- migration installée le 2026-10-06 ;
- remote verify 82/82 ;
- build `67f3eea3` rejetée, puis build `7720b0a8` acceptée ;
- régression appareil sur Android 17.

Le résultat est dans `docs/phase-17-3a-production-verification.md`. Le texte ci-dessous est le plan
tel que préparé avant l'installation.

**Règle d'exécution :** chaque écriture production exige un « GO » explicite et séparé, précédé
d'un préflight en lecture seule et suivi de ses vérifications en lecture seule. Point obligatoire :
**MIGRATION DB AVANT TOUTE APP 17.3a.**

## Gates absolus

> **NO 17.3a CLIENT AGAINST PRODUCTION UNTIL DB MIGRATION IS INSTALLED.**
>
> **NO 17.3a ROLLOUT UNTIL REMOTE VERIFY PASSES.**

**Risque observé (2026-10-05).** L'app de développement Android pointe vers la production
(`EXPO_PUBLIC_SUPABASE_URL` = projet `cnftnulgtsraurtusnpb`) et charge son JavaScript depuis un
Metro local. Ce Metro servait l'arbre `b440a2f`, donc le code 17.3a. Une app 17.3a servie
**avant** la migration échoue : elle lit `barcode_raw_value` et `barcode_symbology`, qui n'existent
pas encore. La liste des produits, le détail et l'enregistrement renvoient
« column … does not exist ». Pendant l'acceptance, seuls l'accueil et l'écran Scan ont été ouverts
et aucun produit n'a été enregistré : aucune écriture production n'a eu lieu.

**État au 2026-10-06 (`GO 17.3A-RELEASE-PREP`).** Aucun processus Metro, aucun port
8081/8082/19000–19002 en écoute, aucun `adb reverse`, app `com.silversys.recall` non lancée sur
l'appareil. Le client de développement ne peut donc recevoir aucun JS 17.3a. **Ne pas redémarrer
Metro sur un arbre 17.3a avant la fin de `GO 17.3A-MIGRATION` et de `GO 17.3A-REMOTE-VERIFY`.**
Si Metro est nécessaire avant, il est servi depuis un checkout de `985ab7d`.

## 0. Vue d'ensemble

| #   | Étape                                                                   | Écriture production   | GO                           |
| --- | ----------------------------------------------------------------------- | --------------------- | ---------------------------- |
| 1   | Push du commit (déjà fait : `origin/main` = `b440a2f`)                  | non                   | —                            |
| 2   | Préflight (lecture seule, juste avant le GO migration)                  | non                   | —                            |
| 3   | Migration `20261005090000` + vérification structurelle en lecture seule | **oui**               | `GO 17.3A-MIGRATION`         |
| 4   | Suite pgTAP distante 17.3a (transaction annulée)                        | **oui** (transitoire) | `GO 17.3A-REMOTE-VERIFY`     |
| 5   | Compatibilité ancien client en production (lecture seule)               | non                   | inclus dans 4                |
| 6   | App 17.3a sur appareil (Metro `b440a2f`, puis build preview Android)    | build : **oui**       | `GO 17.3A-APP-BUILD`         |
| 7   | Régression appareil contre la production                                | oui (données réelles) | `GO 17.3A-DEVICE-REGRESSION` |
| 8   | Enregistrement de vérification + commit de fermeture                    | non (local)           | `GO 17.3A-CLOSEOUT`          |
| R-A | Rollback complet (seulement avant toute app 17.3a)                      | **oui**               | `GO 17.3A-ROLLBACK`          |
| R-B | Assouplissement (après rollout de l'app)                                | **oui**               | `GO 17.3A-RELAX`             |

**Set Edge minimal : VIDE.** Aucun deploy Edge n'est planifié pour 17.3a.

## 1. Git

| Contrôle                | Valeur                                     |
| ----------------------- | ------------------------------------------ |
| Branche                 | `main`                                     |
| HEAD = `origin/main`    | `b440a2ff9f5d6274b4ada7f4e682dac6279ef498` |
| ahead / behind          | 0 / 0                                      |
| Arbre au début de revue | propre                                     |

## 2. Baseline production (lecture seule, 2026-10-05 ~18:30 UTC)

Lectures via `execute_sql`, `list_edge_functions` et `supabase db push --dry-run` uniquement.

### 2.1 Schéma

| Élément                                                                    | Valeur                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Migrations                                                                 | 36, dernière `20261004090000`                                                                                 |
| Historique `md5(string_agg(version‖name, ''))`                             | `e893f721bab6c56782dc84b510687d2f` (= enregistrement 17.3-S)                                                  |
| Colonnes `barcode_raw_value`, `barcode_symbology`                          | **absentes**                                                                                                  |
| `private.expand_upce_to_upca`, fonction/trigger de nettoyage               | **absents**                                                                                                   |
| `private.canonical_gtin14`                                                 | `1f360d45c59400d5a49ee82636ff680c` (= 17.3-S)                                                                 |
| `get_recall_candidates` / `get_owned_product_recall_candidates`            | `695243ea…` / `985de76d…` (= 17.3-S)                                                                          |
| F-4 `private.automatic_alert_eligibility`                                  | `b6a31c8dd6b5e631b0ec2a1038483353`                                                                            |
| Index publics + privés `md5(string_agg(indexdef, ',' order by indexname))` | `cad8a801608bc2cd71dbda1f35e9fdf6`                                                                            |
| Noms des contraintes / triggers de `owned_products` (md5)                  | `16ba85925c8397b577e0b90daad2cc5b` / `2e25a4292c1e0f7d32e1199f96c8321b`                                       |
| Privilèges `owned_products`                                                | `authenticated` : SELECT, INSERT, UPDATE, DELETE (niveau table, 0 grant par colonne) ; RLS active, 4 policies |
| `USAGE` sur `private`                                                      | `anon`, `authenticated`, `service_role` : **non**                                                             |
| `canonical_gtin14` EXECUTE                                                 | `authenticated`, `service_role` ; pas `anon`                                                                  |
| pgTAP installé / sessions `idle in transaction`                            | 0 / 0                                                                                                         |
| PostgreSQL                                                                 | 17.6                                                                                                          |

### 2.1.1 Empreinte d'index : formule de référence

**Problème.** L'empreinte `232db25670612c47a798803bb043e60f` enregistrée par 17.3-S (« empreinte
globale » des index) a été notée **sans sa formule**. Treize variantes plausibles
(séparateurs, ordre, colonnes, schémas) **ne la reproduisent pas**. Elle n'est **pas reproduite**
et n'est plus utilisée comme référence.

**Nouvelle référence reproductible : `cad8a801608bc2cd71dbda1f35e9fdf6`.**

```sql
select md5(string_agg(indexdef, ',' order by indexname))
from pg_indexes
where schemaname in ('public', 'private');
```

| Paramètre     | Valeur                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------- |
| Objets        | toutes les lignes de `pg_indexes` des schémas `public` et `private` (166 index au 2026-10-05) |
| Valeur hachée | `indexdef` tel que renvoyé par PostgreSQL (`pg_get_indexdef`), sans autre normalisation       |
| Ordre         | `indexname`, collation par défaut de la base                                                  |
| Séparateur    | `,` (virgule, sans espace)                                                                    |
| Algorithme    | MD5 (`md5()` PostgreSQL) de la chaîne concaténée, en hexadécimal minuscule                    |

**Preuve.** Même requête, même résultat `cad8a801…` sur :

1. la production actuelle (36 migrations, 2026-10-05) ;
2. une base locale ramenée exactement à `20261004090000` (`supabase db reset --local --no-seed
--version 20261004090000`).

Les 8 autres empreintes du §2.1 sont aussi identiques entre ces deux bases : historique,
`canonical_gtin14`, 2 RPC, F-4, noms des contraintes et noms des triggers de `owned_products`.
17.3a n'ajoute aucun index : la valeur attendue après migration reste `cad8a801…`. Cette formule
est la référence pour les contrôles suivants. Aucun index production n'est modifié.

### 2.2 Données et automatisation

| Mesure                                                                                               | Valeur                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `owned_products`                                                                                     | 2 (2 GTIN de 13 chiffres valides, 0 NULL, 0 invalide, `barcode_scan`)                                         |
| `owned_product_recall_checks` / events                                                               | 2 `complete` / 8                                                                                              |
| `recall_matches`, évaluations v2, éligibilités v2, snapshots v2, snapshots legacy v2, corrections v2 | 0 partout                                                                                                     |
| `alerts`, `push_alert_queue`, `push_deliveries`                                                      | 0, 0, 0 (`push_devices` 3)                                                                                    |
| `recall_notices` / `recall_scopes`                                                                   | 117 / 130                                                                                                     |
| Runs d'automatisation                                                                                | 81, 0 actif ; dernier `success` (cron, 18:17 UTC)                                                             |
| Leases automation / matching, tickets scheduler                                                      | 0 / 0, 18                                                                                                     |
| Flags                                                                                                | `enabled`, `ai_enabled`, `push_enabled`, `product_check_enabled` = true ; `max_product_check_candidates` = 25 |
| Cron                                                                                                 | `recall-automation-every-6h`, `17 */6 * * *`, actif                                                           |

### 2.3 Edge Functions (identiques à l'enregistrement 17.3-S)

| Fonction                                                                       | Version    | ezbr                                |
| ------------------------------------------------------------------------------ | ---------- | ----------------------------------- |
| `process-owned-product-checks`                                                 | v2         | `6c924d42…`                         |
| `check-owned-product`                                                          | v2         | `f0eeee9f…`                         |
| `process-recall-matches`                                                       | v24        | `4d68e4aa…`                         |
| `run-recall-automation`                                                        | v15        | `5622e99c…`                         |
| `process-recall-matches-v2-cohort`                                             | v11        | `682308bd…` (désactivée, inchangée) |
| autres (`ingest-*`, `send-recall-notifications`, `process-cpsc-page-evidence`) | inchangées | —                                   |

## 3. Migration candidate

| Élément | Valeur                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| Fichier | `supabase/migrations/20261005090000_phase_17_3a_scan_identity_provenance.sql` (167 lignes)                 |
| SHA-256 | `419e69eb8d57dae72efab2fb9a8ed312c34a9b9ddb96b1929dcc37ae38b7474e` (recalculé ; = `LATER_PHASES`)          |
| Dry-run | « Would push these migrations: `20261005090000_phase_17_3a_scan_identity_provenance.sql` » — **une seule** |

Objets créés (rien n'est remplacé) :

| Objet                                                    | Détail                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.expand_upce_to_upca(text)`                      | `IMMUTABLE`, `STRICT`, `PARALLEL SAFE`, invoker, `search_path=''`, corps SQL standard (`BEGIN ATOMIC`)                                                                             |
| `owned_products.barcode_raw_value`, `barcode_symbology`  | `text`, nullables, **sans défaut** (métadonnées uniquement, aucune réécriture)                                                                                                     |
| `owned_products_barcode_provenance_pair_check`           | deux colonnes nulles ensemble ou renseignées ensemble                                                                                                                              |
| `owned_products_barcode_provenance_check`                | chiffres ASCII exacts, longueur par symbologie (`ean13`/`upc_a` 12–13, `ean8` 8, `upc_e` 8 ou 12, `itf14` 14 ; autre, dont `code128`, refusé)                                      |
| `owned_products_barcode_provenance_gtin_check`           | identité du raw sous sa symbologie = GTIN-14 de `gtin` ; UPC-E 8 chiffres développé **seulement** si `upc_e` ; `coalesce(…, false)`                                                |
| `private.clear_stale_owned_product_barcode_provenance()` | fonction trigger, invoker, `search_path=''`, met seulement les deux colonnes à NULL                                                                                                |
| trigger `owned_products_clear_stale_barcode_provenance`  | `BEFORE UPDATE OF gtin`, clause `WHEN` canonique OLD/NEW                                                                                                                           |
| Grants                                                   | `expand_upce_to_upca` : `revoke all … from public, anon, authenticated, service_role`, puis `grant execute … to authenticated, service_role` ; fonction trigger : aucun rôle d'API |
| Commentaires                                             | sur les deux colonnes                                                                                                                                                              |

Garanties vérifiées dans le texte et en base :

- aucun `INSERT`, `UPDATE`, `DELETE`, backfill ni SQL dynamique ;
- `canonical_gtin14`, les RPC 17.3-S, F-4, les flags et le cron ne sont pas modifiés (md5 identiques après migration en local) ;
- aucun index nouveau (`cad8a801…` inchangé) ;
- trigger d'armement du check produit non élargi.

**Verrous :** `ADD CONSTRAINT CHECK` prend un `ACCESS EXCLUSIVE` le temps de valider 2 lignes, ce
qui est négligeable. Planifier hors de la minute `:17` (cron toutes les 6 h), vérifier 0 run actif
et 0 transaction longue au préflight, et garder `lock_timeout` court (voir §12).

**Fonctions lisant la ligne entière :** `automatic_alert_eligibility` (F-4) et
`claim_owned_product_recall_check` font `select * into … %rowtype`, mais n'utilisent que des champs
nommés. Les nouvelles colonnes ne changent ni leurs sorties ni une empreinte. Aucun code Edge ne
lit `owned_products` directement ; seules les RPC le font.

## 4. Compatibilité des données historiques

- Production : 2 lignes. En évaluant les trois prédicats avec une provenance NULL (la valeur de
  toute ligne existante après `ADD COLUMN` sans défaut), on obtient **0 violation** de chacun.
- Local : 6 lignes historiques insérées **avant** la migration (2 scans de 13 chiffres, GTIN NULL,
  GTIN invalide, 8 chiffres manuels, OCR), puis seule la migration 17.3a est appliquée. Résultat :
  succès, contraintes validées (`convalidated = true`), 6/6 lignes avec provenance NULL, aucune
  réécriture.

## 5. Compatibilité de l'ancienne app (gate obligatoire)

Preuve locale par de vrais appels PostgREST sous RLS, en tant qu'utilisateur authentifié, après
la migration. L'ancienne app est le **code exact de `985ab7d`** : sa liste de colonnes
`ownedProductColumns`, qui ne contient aucune colonne `barcode_*`, et son mapper
`toOwnedProductWriteRow`.

| Cas                                                              | Résultat               |
| ---------------------------------------------------------------- | ---------------------- |
| `SELECT` avec sa propre liste de colonnes                        | PASS                   |
| `INSERT` produit manuel, sans provenance                         | PASS (provenance NULL) |
| `INSERT` `barcode_scan` (ancien flux scan), sans provenance      | PASS (provenance NULL) |
| `UPDATE` nom, marque, modèle                                     | PASS                   |
| `UPDATE` d'un GTIN historique (valide, puis invalide, puis NULL) | PASS                   |
| Ligne historique antérieure à la migration                       | PASS (provenance NULL) |

L'ancienne app n'a besoin d'aucune nouvelle colonne. Les contraintes acceptent NULL/NULL pour
toutes ses écritures.

## 6. Compatibilité de la nouvelle app (locale)

Code de `b440a2f` (identité de scan, `barcodeScanForSubmission`, mappers) via PostgREST :

| Cas                                                                                      | Résultat                  |
| ---------------------------------------------------------------------------------------- | ------------------------- |
| `SELECT` avec les deux nouvelles colonnes                                                | PASS                      |
| Création EAN-13 `7622202826269` avec provenance                                          | PASS                      |
| Création EAN-8 `27044193` avec provenance                                                | PASS                      |
| Création UPC-E : `gtin` `042100005264`, raw `04252614`, `upc_e`                          | PASS                      |
| Édition nom/marque, GTIN inchangé                                                        | PASS, conservée           |
| Édition vers `00042100005264` (GTIN-14 équivalent)                                       | PASS, conservée           |
| Édition vers `012345678905`                                                              | PASS, effacée             |
| **Versions mélangées** : ancienne app qui édite un produit de la nouvelle, GTIN inchangé | PASS, conservée           |
| **Versions mélangées** : ancienne app qui change le GTIN d'un produit de la nouvelle     | PASS, effacée par la base |

Total : **15/15** (outil de staging hors dépôt, base locale uniquement).

## 7. Helper UPC-E, contraintes, trigger, permissions

- `expand_upce_to_upca('04252614')` = `042100005264` ; `canonical_gtin14('042100005264')` =
  `00042100005264`. Parité TS/SQL sur les 27 vecteurs UPC-E (17.3-S et 17.3a). Un `ean8` n'est
  jamais développé ; `canonical_gtin14('04252614')` reste NULL.
- Contraintes : les cas PASS et REJECT demandés sont couverts par la suite pgTAP 17.3a
  (`supabase/tests/phase-17-3a-scan-provenance.sql`) et par la suite distante. Un contrôle par mutation (contrainte
  supprimée, trigger désactivé) fait échouer les tests correspondants.
- Trigger : l'équivalence 12 → 13 → 14 conserve ; un GTIN différent, invalide ou NULL efface ;
  une édition hors GTIN conserve ; un produit historique reste sans provenance. Il ne modifie
  que les deux colonnes de provenance, jamais `gtin`, et n'invente ni provenance ni transformation.
- Permissions : `expand_upce_to_upca` est exécutable par `postgres`, `authenticated` et
  `service_role` seulement (pas PUBLIC, pas `anon`). La fonction trigger n'est exécutable que par
  `postgres`. Aucun `USAGE` sur `private` pour un rôle d'API, aucune table `private` accordée. Un
  appel direct est refusé (42501). Sans le grant, **tout** insert `authenticated` échoue : le
  grant correspond donc exactement au besoin de la contrainte.

## 8. Edge

17.3a ne modifie **aucun** fichier `supabase/functions/**` (0 fichier entre `985ab7d` et
`b440a2f`), et aucun code Edge ne référence les colonnes de provenance. **Set Edge minimal :
VIDE.** Les runtimes 17.3-S restent ceux vérifiés (§2.3).

## 9. Staging de la migration

- Arbre de staging construit par `git archive b440a2f supabase/migrations supabase/config.toml`
  (37 fichiers, SHA identiques au commit).
- Historique : les 36 premières migrations du dépôt donnent `e893f721…`, soit l'historique de
  production. Une seule migration est en attente.
- `supabase db push --dry-run --linked` (lecture seule) : **une seule migration**, `20261005090000`.
  La CLI affiche « Initialising login role… », son mécanisme d'authentification habituel. Le
  rôle `cli_login_postgres` existe en production ; il y était probablement déjà depuis les
  installations précédentes, mais ce n'est pas prouvable. Après le dry-run : 36 migrations,
  historique inchangé, 0 colonne `barcode_*`, 0 transaction en attente.
- Gate 17.7a-2 : `LATER_PHASES` = { 17.3-S `d58d8438…`, 17.3a `419e69eb…` }. La liste est fermée
  et ordonnée, chaque fichier est vérifié par son hash, et toute autre migration fait échouer le
  gate. **Gate affaibli : NON.**

## 10. Rollback

| Fenêtre                                  | Stratégie                                                                                                                                                                                                                                    | Fichier gated (jamais dans `supabase/migrations`)                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — avant toute app 17.3a distribuée** | Rollback complet : trigger, fonction trigger, 3 contraintes, 2 colonnes, helper. **Refuse** s'il existe une provenance non NULL.                                                                                                             | `supabase/gated-migrations/20261005090100_phase_17_3a_rollback.sql`, SHA-256 `2d151ee3643d218f22a7bfbda5894464f41ded342ef235b4e77ae4d16fc7b1f6`           |
| **B — après rollout de l'app 17.3a**     | Ne **jamais** supprimer les colonnes : l'app 17.3a les sélectionne. On garde le schéma additif et on supprime seulement les deux contraintes capables de rejeter une écriture. Le trigger ne fait que mettre à NULL, il ne peut pas bloquer. | `supabase/gated-migrations/20261005090200_phase_17_3a_post_rollout_relax.sql`, SHA-256 `6fcb261ea1a19d931ebacbf30cc75c52ffe190680021bb6a27261fc3975786ab` |

Revue des deux fichiers :

- **A** (`…090100`), à utiliser uniquement **avant** toute distribution d'une app 17.3a.
  - Il refuse (`raise exception`, transaction annulée) dès qu'une provenance non NULL existe.
  - Il supprime ensuite exactement les objets 17.3a et restaure le schéma pré-17.3a.
  - Il ne supprime aucune donnée utilisateur : les colonnes retirées sont prouvées toutes NULL,
    et aucun `DELETE`, `UPDATE` ni `TRUNCATE` n'est exécuté.
  - Il ne référence ni F-4, ni `canonical_gtin14`, ni les RPC 17.3-S, ni le cron, ni les flags.
- **B** (`…090200`), à utiliser **après** qu'une app 17.3a peut exister sur un appareil.
  - Il ne supprime ni `barcode_raw_value`, ni `barcode_symbology`, ni le helper, ni le trigger,
    ni la contrainte de paire : rien de ce que lisent les `SELECT` de l'app 17.3a.
  - Il retire seulement les deux contraintes capables de rejeter une écriture
    (`…_provenance_check`, `…_provenance_gtin_check`).

Vérifié localement :

- **A**, garde-fou : avec une ligne de provenance, refus, transaction annulée, schéma intact.
- **A**, réel : les colonnes et les fonctions ont disparu. `canonical_gtin14`, RPC, F-4, index
  (`cad8a801…`), contraintes (`16ba8592…`) et triggers (`2e25a429…`) sont **identiques à la
  production actuelle**. Ancienne app après rollback : 6/6.
- **B** : il reste la contrainte de paire, le trigger et le helper. Une provenance incohérente
  devient acceptée (c'est le but de l'assouplissement), le trigger efface toujours une provenance
  périmée. Ancienne app, nouvelle app et versions mélangées : 15/15, revérifié le 2026-10-06. L'app
  17.3a fait toujours `SELECT` avec les nouvelles colonnes, `INSERT` (EAN-13, EAN-8, UPC-E) et
  `UPDATE` (équivalent, différent).
- Après la fenêtre A, une app 17.3a cassée se corrige par une nouvelle version de l'app, pas par
  un retrait de schéma. Il n'y a pas d'OTA (`expo-updates` absent).

Rollback appliqué comme migration avant (version `20261005090100` ou `20261005090200`), comme
pour 17.3-S, puis le gate `LATER_PHASES` est mis à jour dans un commit séparé. Aucune donnée
métier n'est touchée dans aucun sens.

## 11. Suite de vérification distante

- Fichier : `releases/phase-17-3a/phase-17-3a-scan-provenance.remote.sql`, SHA-256
  `eda8ef063337b36f7b324ff6d64b2b203d7b8cc40245be6ea0ba1fe6a9351ba3`.
- Générée de façon déterministe par `releases/phase-17-3a/build-remote-suite.py` (SHA-256
  `3f7acb57…` ; `--check` donne `identical`) à partir de la suite du commit
  `supabase/tests/phase-17-3a-scan-provenance.sql` :
  - la ligne d'installation de pgTAP est retirée (le lanceur injecte un pgTAP temporaire) ;
  - la sonde REVOKE/GRANT est retirée : on ne change jamais un privilège en production, même
    dans une transaction annulée, et ce point est prouvé localement ;
  - ajouts : timeouts, garde-fou (refus si 17.3a ou F-4 est absent), empreintes figées
    (`canonical_gtin14`, RPC, F-4, 5 triggers F-4, flags, cron).
- Propriétés de la suite :
  - une seule transaction, `begin;` au début et `rollback;` à la fin, aucun `COMMIT` : aucune
    mutation ne persiste ;
  - aucun `REVOKE` ni `GRANT` (seulement mentionnés en commentaire) ;
  - pgTAP créé uniquement dans la transaction, par le lanceur ; la suite ne gère aucune
    extension elle-même ;
  - **82 assertions** ;
  - aucune donnée personnelle : seulement des fixtures synthétiques, namespacées
    `173a0000-0000-4000-8000-…` (UUID), `p173a-…` (notices) et `p173a@example.invalid`
    (domaine réservé) ;
  - zéro résidu attendu.
- Couverture réelle (nombre d'assertions dont l'intitulé porte sur le domaine ; une assertion
  peut compter dans plusieurs domaines) :

| Domaine                                                                                   | Assertions |
| ----------------------------------------------------------------------------------------- | ---------- |
| Schéma / colonnes                                                                         | 6          |
| Écritures ancien client, sans provenance                                                  | 4          |
| Écritures nouveau client, avec provenance                                                 | 5          |
| EAN-13 / EAN-8 / UPC-E                                                                    | 3 / 4 / 20 |
| Helper SQL et parité des vecteurs                                                         | 7          |
| Contraintes (refus et acceptations)                                                       | 18         |
| Trigger : équivalent, différent, NULL, invalide, pas de résurrection, pas de rattachement | 8          |
| Permissions                                                                               | 6          |
| F-4 inchangée / flags inchangés / cron inchangé                                           | 2 / 1 / 1  |
| 17.3-S inchangée (corps, retrieval, GTIN-8 jamais UPC-E)                                  | 6          |

- Le rollback transactionnel et l'absence de résidu ne sont pas des assertions. Ils sont
  vérifiés par le lanceur (`rolledBack`, pgTAP absent ensuite, 0 `idle in transaction`) et par les
  requêtes en lecture seule après l'exécution, ci-dessous.
- La suite distante **ne valide rien sur Android ou iOS**. L'acceptance appareil (§13) est une
  preuve distincte.
- Répétition locale avec le **vrai lanceur** (`node scripts/run-remote-pgtap.mjs --file …`) sur
  une base locale mise dans l'état de la production (flags, cron inerte, 2 produits) : **82/82**,
  `rolledBack: true`, pgTAP absent avant et après, 0 `idle in transaction`, historique inchangé,
  **0 résidu** (fixtures `p173a…` et `173a0000-…` absentes).
- Après l'exécution distante, à vérifier en lecture seule : aucun résidu de fixture
  (`auth.users` `p173a@example.invalid`, `recall_notices` `p173a-%`, `owned_products`
  `173a0000-0000-4000-8000-0000000000%`) et compteurs métier du §2.2 inchangés.

## 12. Procédure par GO

### Préflight (lecture seule, sans GO, juste avant `GO 17.3A-MIGRATION`)

- `origin/main` = commit de release-prep (« Prepare Phase 17.3a production installation »), dont
  le parent est `b440a2f`. Le code app et `supabase/migrations` sont identiques à `b440a2f`. SHA de
  la migration `419e69eb…`.
- 36 migrations, historique `e893f721…`, 0 colonne `barcode_*`, 0 objet 17.3a.
- Empreintes du §2.1 identiques ; Edge du §2.3 identiques.
- 0 run actif, 0 lease, 0 transaction longue, hors de la fenêtre `:15`–`:20` du cron.
- **Gate : aucun Metro ne sert un arbre 17.3a** (aucun processus, aucun port en écoute, aucun
  `adb reverse`). Sinon **STOP**.

### `GO 17.3A-MIGRATION`

1. Arbre de staging `git archive b440a2f` (SHA vérifiés), puis `supabase db push --dry-run` :
   une seule migration.
2. `supabase db push` depuis le staging.
3. Vérification structurelle en lecture seule, valeurs attendues (mesurées localement) :

| Élément                                             | Attendu                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Migrations / historique                             | 37 / `b12b91149bd21a05aa8f23e18bc96fab`                                                  |
| Colonnes                                            | `barcode_raw_value`, `barcode_symbology` : `text`, nullables, sans défaut                |
| `expand_upce_to_upca`                               | md5 `32d4b20877ffbed9e4fe8ac6a4dee985` ; ACL `postgres`, `authenticated`, `service_role` |
| Fonction trigger                                    | md5 `629fb9329289bbfa5d1150ee391d0616` ; ACL `postgres` seul                             |
| Trigger                                             | `pg_get_triggerdef` md5 `ee7f943bb862cfb3033248a3dbbd5590`                               |
| Définitions des 3 contraintes                       | md5 `c0e4fa54d6fef1192a7fb40e56bf60ad`                                                   |
| Noms des contraintes / triggers de `owned_products` | `86535826…` / `4b118d43…`                                                                |
| Index, `canonical_gtin14`, RPC, F-4                 | **inchangés** : `cad8a801…`, `1f360d45…`, `695243ea…`/`985de76d…`, `b6a31c8d…`           |
| Données                                             | 2 produits, provenance NULL ; compteurs du §2.2 inchangés                                |

### `GO 17.3A-REMOTE-VERIFY`

- `npm run test:remote-pgtap -- --file releases/phase-17-3a/phase-17-3a-scan-provenance.remote.sql`
  (SHA `eda8ef06…`), lancé par l'opérateur avec `SUPABASE_DB_URL` sans mot de passe et
  `PGPASSWORD` saisi masqué. Le lanceur refuse si pgTAP est déjà installé.
- Attendu : **82/82**, `rolledBack: true`, pgTAP absent avant et après, 0 `idle in transaction`.
- Puis contrôle des résidus et des compteurs (§11), et de la compatibilité de l'ancien client
  (§5) : les lignes des 2 produits existants restent lisibles avec la liste de colonnes de
  `985ab7d`.

### `GO 17.3A-APP-BUILD`

**Précondition : `GO 17.3A-REMOTE-VERIFY` PASS** (82/82, rollback, 0 résidu). Avant cela, aucun
client 17.3a contre la production, même en développement.

Il n'existe ni build `preview` ni build `production` (EAS : une seule build `development` interne
Android, 2026-09-15). Les appareils utilisent un client de développement + Metro. 17.3a ne change
aucun code natif (diff `985ab7d..b440a2f` : une ligne de script dans `package.json`).

1. Servir le JavaScript exact de `b440a2f` au client de développement installé (Metro sur un
   checkout propre de `b440a2f`). Aucune build native n'est nécessaire.
2. Puis une build **`eas build --profile preview --platform android`** (distribution interne, APK
   en mode release, JS embarqué, `__DEV__` faux) depuis `b440a2f`. C'est une build distribuée,
   d'où ce GO. Pas de profil `production` / Play Store dans cette phase.
3. iOS : le bundle compile (`expo export --platform ios` OK), mais aucune build ni validation
   physique iOS n'est revendiquée. D2 reste **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**.

### `GO 17.3A-DEVICE-REGRESSION`

Contre la production, avec des données réelles, sur l'app du GO précédent :

- liste des produits et détail des 2 produits existants ;
- scan EAN-13 physique `7622202826269` → enregistrement : `gtin` `7622202826269`, provenance
  `ean13` ;
- scan EAN-8 physique `27044193` → `gtin` `27044193`, provenance `ean8`, canonique
  `00000027044193` ;
- édition d'un produit sans changer le GTIN : provenance conservée ;
- changement de GTIN : provenance effacée ;
- check produit armé, puis `complete` ;
- 0 alerte, 0 éligibilité.

Produits de test supprimés ensuite (`DELETE` par l'app), puis vérification en lecture seule. UPC-E
reste un **GENERATED BARCODE TEST**, sans test physique.

### `GO 17.3A-CLOSEOUT`

`releases/phase-17-3a/post-install-verification.json`, `docs/phase-17-3a-production-verification.md`,
commit local de fermeture.

## 13. Acceptance à préserver (preuves)

| Élément                 | Statut                                             |
| ----------------------- | -------------------------------------------------- |
| PHYSICAL Android EAN-13 | `7622202826269` → canonique `07622202826269`       |
| PHYSICAL Android EAN-8  | `27044193` → canonique `00000027044193`            |
| GENERATED UPC-E         | `04252614` → `042100005264` → `00042100005264`     |
| UPC-A                   | **NOT PHYSICALLY TESTED**                          |
| UPC-E packaging         | **NOT PHYSICALLY TESTED**                          |
| D2                      | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE** |

## 14. Ordre d'installation sûr

Ordre proposé confirmé, avec deux précisions :

1. push (fait) ;
2. préflight ;
3. migration 17.3a ;
4. vérification structurelle en lecture seule ;
5. vérification transactionnelle distante ;
6. compatibilité de l'ancien client : en production, couverte par la suite distante (insert et
   update sans provenance, en rollback) et par la lecture des 2 produits existants. Aucune
   écriture réelle par l'ancienne app n'est nécessaire ;
7. app 17.3a : d'abord le client de développement servi depuis `b440a2f`, puis la build preview
   Android ;
8. régression appareil ;
9. closeout.

**Précision clé :** le risque « app 17.3a avant migration » existe **déjà** via Metro (bandeau en
tête). L'invariant « DB avant app » passe donc aussi par le contrôle de ce que Metro sert.

## 15. Release ready

**OUI**, pour commencer par `GO 17.3A-MIGRATION`, précédé du préflight. Toutes les preuves
locales passent :

- compatibilité ancienne, nouvelle et mélangée ;
- rollbacks A et B ;
- suite distante répétée avec le vrai lanceur, 82/82 ;
- dry-run à une seule migration ;
- production conforme à la baseline.

Premier GO production : **`GO 17.3A-MIGRATION`**.
