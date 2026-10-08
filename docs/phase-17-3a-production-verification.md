# Phase 17.3a — Scan identity foundation — Vérification production

Statut : **CLOSED — installée en production et vérifiée sur appareil le 2026-10-08**.
Enregistrement machine : `releases/phase-17-3a/phase-17-3a-closeout.json`. Plan suivi :
`docs/phase-17-3a-production-install-plan.md`. Conception : `docs/phase-17-3a-scan-identity-foundation.md`.

| Commit       | SHA                                        | Titre                                          |
| ------------ | ------------------------------------------ | ---------------------------------------------- |
| Runtime      | `b440a2ff9f5d6274b4ada7f4e682dac6279ef498` | Add scan identity provenance and UPC-E support |
| Release-prep | `7754a6802e0ca41dc62b45e326aa2a627083004e` | Prepare Phase 17.3a production installation    |

## 1. Ce que 17.3a livre (et ne livre pas)

Livré :

- la symbologie réellement rapportée par le scanner est conservée (`barcode_symbology`) ;
- la valeur de code-barres livrée à JavaScript est conservée (`barcode_raw_value`) ;
- EAN-8 et UPC-E sont distingués : 8 chiffres seuls ne sont jamais un UPC-E ;
- un UPC-E n'est développé en UPC-A que si la symbologie `upc_e` est explicite ;
- `owned_products.gtin` contient le GTIN de matching (un UPC-E y est stocké sous sa forme UPC-A) ;
- le GTIN-14 canonique se dérive, il n'est pas stocké ;
- la base garantit que la provenance décrit toujours le GTIN **actuel** ;
- les produits historiques et l'app d'avant 17.3a restent compatibles.

**Non livré :** 17.3a n'identifie pas automatiquement le nom ni la marque d'un produit. Cela relève
de la phase suivante, **Product Lookup (GTIN → nom + marque)**.

## 2. Migration production

| Élément        | Valeur                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Fichier        | `supabase/migrations/20261005090000_phase_17_3a_scan_identity_provenance.sql`                                                                   |
| SHA-256        | `419e69eb8d57dae72efab2fb9a8ed312c34a9b9ddb96b1929dcc37ae38b7474e`                                                                              |
| Dry-run        | une seule migration : `20261005090000`                                                                                                          |
| Application    | `GO 17.3A-MIGRATION`, 2026-10-06 de 04:35:29 à 04:35:32 UTC, code de sortie 0                                                                   |
| Après          | 37 migrations, historique `b12b91149bd21a05aa8f23e18bc96fab`                                                                                    |
| Objets ajoutés | 2 colonnes nullables sans défaut, 3 contraintes, `private.expand_upce_to_upca(text)`, fonction et trigger de nettoyage, grants/revokes minimaux |
| Backfill       | aucun ; les 2 produits historiques ont une provenance NULL                                                                                      |
| Edge           | aucun déploiement (set vide) ; 10 fonctions inchangées                                                                                          |

Empreintes de définition en production :

- helper : `32d4b208…` ;
- contraintes : `c0e4fa54…` ;
- trigger : `ee7f943b…` ;
- fonction trigger : `629fb932…`.

Rollbacks gated préparés, **non exécutés** :

- A : `20261005090100_phase_17_3a_rollback.sql`, `2d151ee3…`, uniquement avant toute app 17.3a ;
- B : `20261005090200_phase_17_3a_post_rollout_relax.sql`, `6fcb261e…`, après le déploiement de
  l'app.

## 3. Remote verify (`GO 17.3A-REMOTE-VERIFY`)

Suite `releases/phase-17-3a/phase-17-3a-scan-provenance.remote.sql` (SHA-256 `eda8ef06…`), générée
par `build-remote-suite.py` (`3f7acb57…`). Exécutée par l'opérateur avec `npm run test:remote-pgtap`.

| Champ                                           | Résultat      |
| ----------------------------------------------- | ------------- |
| plan / ok / notOk                               | 82 / 82 / 0   |
| psqlExit, passed, rolledBack                    | 0, true, true |
| pgTAP avant / après                             | 0 / 0         |
| `idle in transaction` après                     | 0             |
| garde-fous / historique inchangés               | true / true   |
| résidu (fixtures, rôles, extensions, compteurs) | **NONE**      |
| compatibilité de l'ancien client en production  | **PASS**      |
| compatibilité du nouveau client en production   | **PASS**      |

## 4. Build rejetée — incident conservé

| Élément     | Valeur                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Build EAS   | `67f3eea3-9cba-429e-a245-9101517cc6c4`                                                                               |
| Statut EAS  | SUCCESS                                                                                                              |
| Acceptance  | **REJECTED**                                                                                                         |
| SHA-256 APK | `5604af6230b20b02e9a940d9a92e93f08209134ccd81dd9b9f61502d2c55caa5`                                                   |
| Cause       | les variables client Supabase de l'environnement EAS `preview` contenaient des chevrons littéraux autour des valeurs |
| Symptôme    | « Supabase configuration needed — EXPO_PUBLIC_SUPABASE_URL must be a valid URL. »                                    |

**Cet artefact ne doit jamais être considéré comme une build 17.3a valide.**

Ma vérification de l'APK avait d'abord testé la seule **présence** des valeurs (sous-chaîne), et
elle n'a donc pas vu les chevrons. Elle a été remplacée par une comparaison d'égalité exacte (§6).

## 5. Correction de l'environnement EAS (`GO 17.3A-EAS-ENV-FIX`)

Les deux valeurs ont été remplacées directement à partir de `.env.local` : seules ces deux
variables ont été lues, et aucune valeur n'a été affichée. Avant la build 2 :

| Contrôle                                  | Résultat  |
| ----------------------------------------- | --------- |
| URL exact equality (`.env.local` ↔ EAS)   | YES       |
| KEY exact equality                        | YES       |
| URL syntaxe valide (`new URL`) / `https:` | YES / YES |
| URL chevrons                              | NO        |
| KEY chevrons                              | NO        |

Aucune valeur réelle n'apparaît dans ce document ni dans l'enregistrement JSON.

## 6. Build acceptée

| Élément                                          | Valeur                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Build EAS                                        | `7720b0a8-03e0-44a2-be78-8aab14610d2b` (FINISHED / SUCCESS)        |
| Profil / distribution / artefact                 | `preview` / INTERNAL / APK                                         |
| Package / version / versionCode / SDK            | `com.silversys.recall` / `1.0.0` / 1 / 57.0.0                      |
| Commit source (EAS)                              | `7754a6802e0ca41dc62b45e326aa2a627083004e`                         |
| SHA-256 APK                                      | `6f40930b2084f4f4c5d366d3f9496d3b8b924215a0e0f779054848fa8896ecbf` |
| Taille                                           | 175 253 064 octets                                                 |
| Certificat                                       | `2de01276ac9598a81bac89d778f06c5570df45f932d1b038ee81aa467bef7059` |
| Debuggable                                       | non                                                                |
| Configuration Supabase embarquée, égalité exacte | **PASS**                                                           |
| Diagnostic absent                                | **PASS**                                                           |

Méthode de preuve de la configuration embarquée :

- lecture de la table des chaînes du bytecode Hermes v98 de l'APK, avec l'offset et la longueur
  réels de chaque chaîne ;
- comparaison par SHA-256 et par longueur avec `.env.local`, en ne produisant que des booléens ;
- le lecteur n'a été retenu qu'après trois contrôles :
  - intégrité (magic, version, longueur du fichier) ;
  - référence locale ;
  - contrôle négatif sur l'APK rejeté, où l'entrée `<valeur>` est bien détectée.

## 7. Acceptance appareil (`GO 17.3A-DEVICE-REGRESSION-2`, 2026-10-08)

**Appareil :** Samsung SM-S938B, **Android 17** (SDK 37). Le téléphone était sous Android 16 lors
des observations du 2026-10-05/06, puis a été mis à jour avant la régression finale : celle-ci
constitue donc une preuve **Android 17**.

| Contrôle                             | Résultat                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| SHA-256 du `base.apk` installé       | `6f40930b…`, correspondance exacte avec l'artefact : **YES**    |
| Remplacement `adb install -r`        | **PASS** (désinstallation non nécessaire)                       |
| Fonctionnement autonome sans Metro   | **PASS**                                                        |
| Configuration Supabase à l'exécution | **PASS**                                                        |
| Authentification                     | **PASS** (identifiants saisis par l'opérateur, jamais capturés) |
| Lecture des produits historiques     | **PASS** (liste et détail)                                      |
| Crashs                               | 0                                                               |

### PHYSICAL PRODUCT TEST — EAN-13

`5400141472714` : type `ean13`, GTIN de matching `5400141472714`, forme canonique `05400141472714`,
transformation `null`. Formulaire prérempli correctement : **PASS**. Rien enregistré.

Le produit `7622202826269` n'était plus disponible lors de la régression finale ; il n'est pas
utilisé comme preuve finale. Observation distincte : lors d'un scan antérieur de ce produit, le
scanner avait rapporté un `code128`, que l'app a correctement refusé comme GTIN. L'explication
documentée reste un éventuel second code-barres sur l'emballage.

### PHYSICAL PRODUCT TEST — EAN-8

`27044193` : type `ean8`, GTIN de matching `27044193`, forme canonique `00000027044193`,
**aucune expansion UPC-E**. Formulaire : **PASS**. Rien enregistré.

### GENERATED BARCODE TEST — UPC-E (pas un produit physique)

Valeur brute `04252614`, symbologie `upc_e`, GTIN de matching `042100005264`, forme canonique
`00042100005264`, transformation `upc_e_to_upc_a`. Formulaire (GTIN développé et note UPC-E) :
**PASS**. Persistance : **PASS**.

### Persistance, édition équivalente, nettoyage

- Un seul produit temporaire, nommé `17.3a DEVICE REGRESSION - GENERATED UPC-E`. Le tiret simple
  remplace le tiret long, que `adb input` ne sait pas saisir ; c'est sans effet fonctionnel.
- Après création : `gtin = 042100005264`, `barcode_raw_value = 04252614`,
  `barcode_symbology = upc_e`. Le détail affiche « Scanned barcode — 04252614 (UPC-E) ».
- Après l'édition équivalente via l'app : `gtin = 00042100005264`, `barcode_raw_value = 04252614`,
  `barcode_symbology = upc_e`. **Provenance conservée : YES.**
- Checks automatiques 17.7a : 2 révisions (création, puis édition du GTIN), statut `complete`,
  aucune invocation manuelle de worker. 0 match, 0 évaluation, 0 éligibilité, 0 alerte, 0 push
  incorrects. C'est une régression réelle du chemin 17.7a sur un produit 17.3a, **pas** la preuve
  d'un rappel positif.
- Suppression via l'app, sans aucun SQL manuel. Ensuite : `owned_products` = 2, checks = 2,
  events = 8, produit de test = 0, provenance non NULL = 0, et 0 match, évaluation, éligibilité,
  snapshot, alerte ou push de test. **Résidu persistant : NONE.** Les 2 produits historiques sont
  inchangés (`dde9db73…`).

**Non testés physiquement :** UPC-A, et UPC-E sur un emballage réel (testé uniquement sur un
code-barres généré).

## 8. Non-régression

| Élément                     | Valeur finale                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `canonical_gtin14` (17.3-S) | `1f360d45…`                                                                                    |
| RPC 17.3-S                  | `695243ea…` / `985de76d…`                                                                      |
| Empreinte d'index           | `cad8a801608bc2cd71dbda1f35e9fdf6` (formule reproductible, voir le plan d'installation §2.1.1) |
| F-4                         | 5 triggers, `b6a31c8d…`, intacte                                                               |
| Flags                       | `product_check_enabled = true`, `max_product_check_candidates = 25`                            |
| Cron                        | `recall-automation-every-6h`, `17 */6 * * *`, actif                                            |
| Edge                        | 10 fonctions inchangées, aucun déploiement 17.3a                                               |

État final (2026-10-08, 11:41 UTC) : 37 migrations, 2 produits historiques, 0 provenance non NULL,
0 match, 0 alerte, 0 résidu de test.

## 9. Observations non bloquantes

**Incident Health Canada (indépendant de 17.3a).** Run naturel du 2026-10-06 à 18:17 UTC :
`partial_success`, `source_partial_failure`. Health Canada a répondu HTTP 502, CPSC a réussi ;
0 candidat, 0 escalade IA, 0 alerte, 0 push. Résorbé : les 6 runs suivants, jusqu'au 2026-10-08
06:17 UTC, sont en `success`. Ce n'est pas un défaut 17.3a.

**Avertissement passager sur l'accueil — NON-BLOCKING FOLLOW-UP.** Au premier lancement après
authentification, l'accueil a brièvement affiché « Monitoring status unavailable » et « Some summary
data could not be refreshed ». Un **Refresh** a immédiatement restauré la surveillance active,
les 2 sources et la couverture. Aucun crash ; les écrans Produits, Scan et Détail n'étaient pas
affectés. Ce n'est pas corrigé dans 17.3a ; à investiguer dans une phase ultérieure (chargement du
résumé avant l'établissement complet de la session).

## 10. iOS

- Bundle iOS : compilé et exporté avec succès.
- Acceptance physique iOS : **aucune**.
- D2 : **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**.

L'export iOS n'est pas une preuve appareil.

## 11. Couverture

La couverture publique est inchangée : « Recall currently monitors official product-safety recall
data from the U.S. Consumer Product Safety Commission and Health Canada. » Que des produits belges
se scannent correctement ne l'élargit pas : **le support de l'identité produit n'est pas la
couverture des sources de rappels.**

## 12. Suite

**Phase suivante recommandée : PRODUCT LOOKUP — GTIN → NAME + BRAND**, sur le contrat d'entrée
défini dans le document de fondation (§14) : `matchingGtin`, `canonicalGtin14`, et `scan` ou
`null`.
