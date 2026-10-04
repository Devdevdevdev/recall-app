# Phase 17.3-S — Canonical GTIN equivalence — implémentation locale

Statut : **implémentation LOCALE, en attente de revue**. Aucune production, migration distante,
deploy, flag, secret, cron, commit ni push.
Base : `main` @ `07821592c280648be1a056b0dd27634894c5d8c4` (= `origin/main`, ahead 0 / behind 0).
Investigation : `docs/phase-17-3-s-gtin-equivalence-investigation.md`.

| Constat                          | Statut                                             |
| -------------------------------- | -------------------------------------------------- |
| D1 — UPC-E réel rejeté           | **CONFIRMED**                                      |
| D2 — représentation iOS          | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE** |
| Défaut d'équivalence indépendant | **CONFIRMED** (code actuel + exécution locale)     |

D2 n'est ni une preuve ni une justification de cette passe. Aucun test Android physique n'est
revendiqué : aucune ligne de log appareil n'a été capturée.

---

## 1. Ce qui change

Avant, pour le même identifiant commercial (scope CPSC `091021037090`) :

| GTIN du produit  | candidat     | v1                | v2          |
| ---------------- | ------------ | ----------------- | ----------- |
| `091021037090`   | `exact_gtin` | `confirmed`       | matched     |
| `0091021037090`  | aucun signal | **rejected 0,98** | conflicting |
| `00091021037090` | aucun signal | **rejected 0,98** | conflicting |

Après : les trois lignes se comportent comme la première. Une représentation équivalente se
comporte **exactement** comme la représentation exacte qui existait déjà. Rien d'autre ne change.

Une équivalence GTIN signifie seulement « même identifiant commercial ». Elle ne confirme jamais un
rappel par elle-même et ne contourne ni lot, date, modèle, juridiction, `coverageComplete`, F-4,
l'activation IA, ni `RECALL_MATCHING_POLICY`.

## 2. Primitive TypeScript unique

`supabase/functions/_shared/matching/gtin.ts` (nouveau, sans dépendance hors `normalization.ts`) :

| Fonction                                 | Rôle                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalGtin14(value)`                 | GTIN-8/12/13/14 valide → GTIN-14 complété à gauche par des zéros ; sinon `null`. Aucune symbologie, donc aucune expansion UPC-E. Miroir SQL exact. |
| `gtinsEquivalent(a, b)`                  | vrai seulement si les deux sont valides et ont le même GTIN-14 canonique.                                                                          |
| `expandUpcE(value)`                      | UPC-E 8 chiffres (système 0/1) → UPC-A 12 chiffres selon les règles GS1, check digit de l'UPC-A vérifié.                                           |
| `canonicalizeGtin(value, { symbology })` | identité complète : `raw` (jamais réécrit), `valid`, `sourceLength`, `gtinFormat`, `canonicalGtin14`, `symbology`, `expandedFromUpce`.             |

Règles : jamais de `Number` ; zéros initiaux conservés ; chiffres ASCII uniquement après
`String.prototype.trim` ; longueurs 8/12/13/14 ; check digit GS1 vérifié ; forme canonique à
14 chiffres ; complément à gauche uniquement, jamais de suppression de zéro.

La validation (trim, chiffres, longueur, check digit) reste **l'unique** implémentation existante
de `normalization.ts` (`normalizeGtin` / `isValidGtin`), qui n'est **pas modifié**. `gtin.ts`
n'ajoute que la canonicalisation, l'équivalence et l'expansion UPC-E.

Vérifié : `091021037090`, `0091021037090` et `00091021037090` → `00091021037090`.

### Frontière 8 chiffres

Une chaîne de 8 chiffres seule est un **GTIN-8**. L'expansion UPC-E n'a lieu que si la symbologie
`upc_e` est fournie explicitement à `canonicalizeGtin`. `canonicalGtin14` et le SQL n'ont pas de
symbologie et n'expansent jamais :

| Entrée     | sans symbologie           | `symbology: 'upc_e'`                    |
| ---------- | ------------------------- | --------------------------------------- |
| `04252614` | invalide (`null`)         | UPC-A `042100005264` → `00042100005264` |
| `01234558` | GTIN-8 → `00000001234558` | UPC-A `012345000058` → `00012345000058` |

`01234558` est valide dans les deux interprétations : seule la symbologie décide, jamais les
chiffres. Les quatre branches GS1 (d6 ∈ 0-2, 3, 4, 5-9) et le système de numérotation 1 sont
testés, ainsi qu'un mauvais check digit, un système 2 et 7 chiffres.

**Le câblage scanner de l'expansion UPC-E est reporté à 17.3a.** Il change la classification
affichée, les paramètres de route et l'UI, et il suppose de transmettre la symbologie. 17.3-S ne
modifie aucune UI.

## 3. Primitive SQL canonique

Migration locale `supabase/migrations/20261004090000_phase_17_3_s_canonical_gtin_equivalence.sql` :

```
private.canonical_gtin14(text) returns text
  language sql immutable strict parallel safe, set search_path = ''
```

- `btrim` avec **exactement** l'ensemble `String.prototype.trim` (25 caractères, listés en
  `\uXXXX`). Un test compare cette liste à l'ensemble calculé par Node sur tous les points de
  code Unicode.
- `^[0-9]+$` (ASCII), longueur ∈ {8,12,13,14}, check digit mod-10 GS1 (CASE imbriqué : le
  calcul n'est évalué qu'après validation syntaxique), `lpad(…, 14, '0')`, sinon `NULL`.
- Aucune expansion UPC-E.
- Privilèges : révoqué pour `public`, `anon`, `authenticated` et `service_role`, puis **EXECUTE
  accordé à `authenticated` et `service_role` seulement**. Une expression d'index est évaluée avec
  les droits du rôle qui écrit la ligne ; sans ce grant, un `insert` de l'app dans
  `owned_products` échoue (« permission denied for function canonical_gtin14 », vérifié
  localement). Aucun rôle d'API n'a `USAGE` sur `private`, donc la fonction reste inatteignable
  par son nom.

**Vecteurs communs** : `tests/fixtures/phase-17-3-s-gtin-vectors.json` (31 vecteurs canoniques,
12 vecteurs UPC-E). Le fichier est embarqué **octet pour octet** dans
`supabase/tests/phase-17-3-s-canonical-gtin.sql` (bloc `$vectors$`) et lu en `jsonb`. Le test Node
vérifie l'identité du bloc et exécute les mêmes vecteurs dans `gtin.ts`. Les vecteurs ont aussi été
vérifiés par une implémentation indépendante, hors dépôt. Le fixture est exclu de prettier, qui
remplacerait les échappements `\u` par des caractères invisibles.

## 4. Schéma / indexation

| Option                       | Données distantes | Backfill  | Logique dupliquée  | Indexable | Décision    |
| ---------------------------- | ----------------- | --------- | ------------------ | --------- | ----------- |
| A. colonne canonique stockée | écriture          | requis    | trigger + fonction | oui       | non         |
| B. colonne générée stockée   | réécriture table  | implicite | non                | oui       | non         |
| **C. index d'expression**    | **aucune**        | **aucun** | **non**            | **oui**   | **retenue** |
| D. calcul à la volée seul    | aucune            | aucun     | non                | non       | non         |

C est la solution minimale : `gtin` brut préservé, aucune donnée réécrite, historique couvert
automatiquement, même fonction pour `owned_products` et `recall_scopes` :

- `owned_products_canonical_gtin14_idx` sur `(private.canonical_gtin14(gtin)) where gtin is not null` ;
- `recall_scopes_canonical_gtin14_idx`, même définition.

`EXPLAIN` local (`enable_seqscan = off`) : `Index Scan using …_canonical_gtin14_idx`, avec
`Index Cond: (private.canonical_gtin14(gtin) = '00091021037090')`.

## 5. Historique

- Les lignes stockées en 12, 13 ou 14 chiffres convergent vers la même clé, **sans réécrire**
  `gtin` (pgTAP : les valeurs brutes restent identiques).
- Une valeur historique invalide reste visible, n'obtient jamais de clé canonique et n'est jamais
  rendue valide artificiellement (fail closed).
- Une valeur historique de 8 chiffres est traitée comme un GTIN-8. Aucune expansion UPC-E n'est
  devinée : `04252614` ne retrouve pas `042100005264`.

## 6. Candidate generation SQL

`get_recall_candidates` et `get_owned_product_recall_candidates` sont redéfinies par
`create or replace`. Leurs corps sont générés à partir du texte exact des migrations d'origine,
avec des substitutions vérifiées : toutes les autres lignes sont identiques, et les grants comme le
caractère `security definer` sont conservés.

- Le prédicat GTIN devient **égalité legacy (`regexp_replace` des chiffres) OU égalité
  canonique**. Rien n'est restreint : un scope publié `0910-2103-7090` retrouve toujours P1
  par la voie legacy (pgTAP).
- Rang GTIN inchangé (4), même pour une équivalence ; le classement des autres signaux est
  inchangé.
- Produit → rappels : une branche `union all` de rang 4 a été ajoutée sur
  `private.canonical_gtin14(scope.gtin) = product.gtin14_key`, avec `scope.gtin is not null`
  explicite pour l'index partiel.
- La parité entre les deux sens est vérifiée (même ensemble produit × rappel × rang).

## 7. Matching TypeScript

| Site | Fichier                     | Changement                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `candidateRetrieval.ts`     | `exact_gtin` si `gtinsEquivalent(ownedGtin, scope.gtin)` (au lieu de l'égalité de chaîne). Le libellé et le score sont inchangés.                                                                                                                                                                                         |
| T2   | `evidence.ts` (v1)          | Si les deux GTIN sont valides : `gtinsEquivalent` → `matched`, sinon contradiction (inchangé). Les valeurs brutes sont conservées dans l'évidence ; le détail historique « Exact valid GTIN match… » est gardé pour le cas identique, et un détail « Equivalent valid GTIN (same canonical GTIN-14)… » est utilisé sinon. |
| T3   | `criterionEvaluatorV2.ts`   | `equals` / `one_of` sur `kind: 'gtin'` : égalité legacy **ou** équivalence canonique. Les autres kinds sont inchangés.                                                                                                                                                                                                    |
| T4   | `nemotronSafetyVerifier.ts` | `compareExact('gtin')` : `gtinsEquivalent` au lieu de `===`. Prompt, policy, budget et activation sont inchangés ; l'IA doit toujours recopier les valeurs exactes.                                                                                                                                                       |

`productCheck/orchestrator.ts` n'est pas modifié : il dérive `matched.gtin` du signal
`exact_gtin` avec la valeur brute du produit.

### v1 legacy

L'équivalence ne fait qu'étendre le cas exact qui existait : le chemin `hasGtinMatch → confirmed`
est atteint exactement comme pour P1. Les autorisations d'alerte ne sont pas élargies : le
finaliseur SQL F-4 rétrograde tout `confirmed` v1 non prouvé en `needs_review` sans alerte.
Vérifié en pgTAP pour P1, P2 et P3 : `finalized|needs_review|unsupported_scope|none`, 0 alerte, le
candidat reste observable avec sa valeur brute.

### v2

- Équivalent canonique → `matched` pour le critère GTIN.
- Canonique différent → `conflicting`.
- GTIN du produit invalide → `unresolved` (fail closed, inchangé).
- Valeur officielle invalide face à un GTIN valide non identique → `conflicting` (legacy
  inchangé).

Un GTIN `matched` ne rend pas une règle éligible : lot, date et modèle restent évalués à
l'identique pour P1, P2 et P3 (test T).

**Limite documentée, inchangée** : les opérateurs `prefix` et `range` sur un critère GTIN gardent
leur sémantique de chaîne brute. Aucun rule set de production ne les utilise : seuls
`model_number` et `date_code` sont admis en production (`reviewedCriteriaV2.ts`).

### F-4

Non modifié. Un critère `gtin` reste hors de l'allowlist (`model_number`, `date_code`) : un match
GTIN canonique n'est jamais une éligibilité automatique (tests S et pgTAP
`automatic_alert_eligibility = unsupported_scope` pour P1, P2 et P3).

## 8. Représentation brute et symbologie : décision

| Donnée                  | 17.3-S                                                                                                                                          | Plus tard                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| représentation brute    | **déjà conservée** : `owned_products.gtin` stocke la valeur validée telle quelle ; scopes CPSC tels que publiés                                 | —                                                                |
| GTIN-14 canonique       | **dérivé** (index d'expression), jamais stocké                                                                                                  | —                                                                |
| symbologie              | **non stockée** : pour 12/13/14 chiffres, la canonicalisation n'en a pas besoin, donc la sécurité du matching ne dépend d'aucune donnée absente | 17.3a : colonne + route param, nécessaires uniquement pour UPC-E |
| code brut scanné ≠ GTIN | non (route, `ProductForm`, `ScanScreen` inchangés)                                                                                              | 17.3a (avec la symbologie)                                       |

`src/domain/barcode.ts` et `cpsc/validation.ts` gardent leur validateur. Un test de parité prouve
qu'ils acceptent exactement les mêmes valeurs que la primitive. Les fusionner toucherait la release
app et les bundles d'ingestion : c'est reporté à 17.3a avec le câblage UPC-E.

## 9. Re-gel documenté (autorisé, limité à 17.3-S)

Record : `benchmarks/recall-matching/phase-17-3-s-refreeze.json`.

| Manifest                   | Section                   | Fichier                                     |
| -------------------------- | ------------------------- | ------------------------------------------- |
| phase-9-1/holdout-manifest | `frozenPolicyFiles`       | `evidence.ts`, `nemotronSafetyVerifier.ts`  |
| phase-15/freeze-manifest   | `promptPolicyArtifacts`   | `evidence.ts`                               |
| phase-15/freeze-manifest   | `historicalArtifacts`     | `phase-9-1/holdout-manifest.json` (cascade) |
| phase-16/freeze-manifest   | `implementationArtifacts` | `criterionEvaluatorV2.ts`                   |

Les empreintes de `candidateRetrieval.ts`, `criterionEvaluatorV2.ts` et `evidence.ts` ont aussi été
mises à jour dans la table `FROZEN` de `tests/phase-17-7a-1-product-check.test.mjs`, avec un
commentaire, comme l'avaient fait F-4 et 17.7a-2.

Inchangés : `normalization.ts`, tous les datasets, résultats, rapports et fingerprints de policy.
Les rapports historiques Phase 15 continuent d'épingler les empreintes d'avant 17.3-S, qui sont la
provenance de leurs runs (vérifié par test).

**Preuve de comportement** : aucun dataset gelé ne contient deux représentations équivalentes d'un
même GTIN. Les benchmarks déterministes (Phase 8, 9.1 holdout, 15 ×4, 16 v2, delta v1→v2, sonde
v2.1) ont été rejoués dans deux copies isolées (`git archive HEAD` contre HEAD + 17.3-S) puis
comparés aux résultats commités : seuls `generatedAt`, `sourceGitCommit` et les latences diffèrent.
Toutes les décisions et métriques sont identiques.

## 10. Tests

Nouveaux :

- `tests/phase-17-3-s-gtin-equivalence.test.mjs` (21 tests Node) ;
- `supabase/tests/phase-17-3-s-canonical-gtin.sql` (58 assertions pgTAP).

| Cas                                        | Où                                                           |
| ------------------------------------------ | ------------------------------------------------------------ |
| A même GTIN-14                             | vecteurs TS + SQL, test « A »                                |
| B `exact_gtin` pour les trois formes       | test « B/N/O », pgTAP rang 4                                 |
| C v1 sans `rejected`                       | test « C/P » (5 variantes de scope × 4 variantes de produit) |
| D v2 `matched`, jamais `conflicting`       | test « D/Q »                                                 |
| E/F vrais différents / invalides           | vecteurs, tests E/F (v1, v2, candidats), pgTAP P4/P5         |
| G zéros initiaux                           | 2 000 GTIN-12 générés, vecteurs                              |
| H GTIN-8                                   | vecteurs `96385074`, `01234558`                              |
| I UPC-E + `upc_e`                          | 12 vecteurs UPC-E, toutes les branches                       |
| J 8 chiffres sans `upc_e`                  | vecteurs, test J, pgTAP P6/N4                                |
| K/L/M historique 12/13/14                  | pgTAP : valeurs brutes intactes, clés convergentes           |
| N/O recall→product, product→recall         | pgTAP + parité des deux sens                                 |
| P v1 legacy                                | test « C/P » + pgTAP finaliseur v1                           |
| Q v2 targeted                              | tests « D/Q », « T (v2) »                                    |
| R Nemotron verifier                        | test « R »                                                   |
| S F-4 inéligible                           | test « S », pgTAP `automatic_alert_eligibility`              |
| T lot/date/modèle/juridiction obligatoires | tests « T (v2) », « T/U » (7 scénarios de product check)     |
| U aucune alerte équivalence seule          | tests « U/16 », « T/U », pgTAP 0 alerte                      |
| Régression Thule P1/P2/P3                  | product check, v1, v2 et SQL                                 |

Gardes ajoutées :

- le bloc de vecteurs pgTAP est identique au fixture ;
- l'ensemble trim SQL est identique à l'ensemble JS ;
- la migration ne contient aucun DML ni aucune référence à F-4 ou à la policy ;
- le re-gel est limité aux entrées listées ;
- l'historique Phase 15 est intact.

## 11. Points à traiter avant toute installation (non faits ici)

Traité par la revue de release : `docs/phase-17-3-s-production-install-plan.md`. Inventaire production = 0 (aucun replay) ; set minimal de 3 Edge Functions stagées depuis les octets déployés ; ordre Edge puis migration ; rollback gated vérifié.

1. **Paires déjà évaluées.** Le fingerprint v1 ne couvre pas le code du matcher. Une paire déjà
   évaluée `rejected` (GTIN « contradictoire » équivalent) ne sera pas réévaluée tant que ni le
   produit ni le rappel ne changent. Il faut prévoir un inventaire en lecture seule des paires
   `recall_matches` dont le GTIN produit et le GTIN de scope ont la même clé canonique, puis une
   décision explicite de réévaluation (GO par étape).
2. **Bundles Edge.** `gtin.ts` entre dans la clôture de modules des fonctions qui importent le matching
   (notamment `check-owned-product`, `process-owned-product-checks`, `process-recall-matches`,
   `process-recall-matches-v2-cohort`). Les listes épinglées de
   `scripts/stage-17-7a-edge-bundles.mjs` (commit `REVIEWED`) devront être restagées.
3. **Ordre.** Migration (fonction + index + RPC) avant les fonctions Edge ; vérification pgTAP
   distante selon la procédure habituelle.

## 12. Hors périmètre

Aucun lookup produit (Open Food Facts, Go-UPC, Barcode Lookup, UPCitemdb, GS1, `identify-product`,
cache catalogue). Aucun QR, GS1 Digital Link, DataMatrix ni PDF417. Aucune UI. Aucun câblage UPC-E
dans le scanner (17.3a).
