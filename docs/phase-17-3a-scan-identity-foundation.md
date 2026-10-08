# Phase 17.3a — Scan identity foundation

Statut : **CLOSED (2026-10-08)** — migration installée en production, remote verify 82/82,
build Android preview acceptée et régression appareil Android 17 réussie. Preuves finales :
`docs/phase-17-3a-production-verification.md` et `releases/phase-17-3a/phase-17-3a-closeout.json`.
Aucun appel à un fournisseur de catalogue (Product Lookup = phase suivante).

Les sections ci-dessous décrivent la conception et l'acceptance locale ; elles restent l'historique
de la phase.

| Point                   | Statut                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Baseline                | `main` = `origin/main` = `985ab7df6230d09de2c5e0f0ad8b998122cd75a3`                                                            |
| 17.3-S                  | CLOSED, inchangée (`gtin.ts`, migration `20261004090000`, tests)                                                               |
| D1 — UPC-E réel rejeté  | **corrigé côté app** (câblage scanner UPC-E)                                                                                   |
| D2 — représentation iOS | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**                                                                             |
| Acceptance Android      | EAN-13 et EAN-8 physiques, UPC-E **généré** : conformes (§12, Android 16) ; finale sur Android 17 (vérification production §7) |
| UPC-A                   | **NOT PHYSICALLY TESTED**                                                                                                      |
| UPC-E                   | **NOT PHYSICALLY TESTED ON PRODUCT PACKAGING** — **GENERATED BARCODE TEST PASSED**                                             |
| Migration 17.3a         | `20261005090000_phase_17_3a_scan_identity_provenance.sql`, **installée en production** le 2026-10-06                           |
| Statut de la phase      | **CLOSED**                                                                                                                     |

## 1. Flux scan avant 17.3a (audit)

| Étape                                 | Type / valeur                                                                                                    | Perte                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CameraView` `barcodeTypes`           | `ean13, ean8, upc_a, upc_e, itf14, code128`                                                                      | —                                                                                          |
| callback `BarcodeScanningResult`      | `{ type: string, data: string, raw?: string }` ; `raw` Android seulement (`@hidden`), littéral `"null"` possible | iOS : `raw` absent ; EAN-13 commençant par `0` : un `0` retiré par Expo (D2, non confirmé) |
| `handleBarcodeScanned`                | `type` filtré, `toScannedBarcode(type, raw ?? data, data)`                                                       | `raw` Android et `data` mélangés selon la plateforme                                       |
| `toScannedBarcode` / `validateGtin`   | `data.trim()`, 8/12/13/14 chiffres, check digit **sans symbologie**                                              | **UPC-E testé comme GTIN-8 → rejeté (D1)** ; Code 128 numérique accepté comme GTIN         |
| écran de confirmation                 | affiche `normalizedValue`                                                                                        | —                                                                                          |
| route `/products/new`                 | `{ gtin, source: 'barcode_scan' }`                                                                               | **symbologie et raw perdus**                                                               |
| `productCreationPrefillFromParams`    | revalide `gtin`, préremplit le champ                                                                             | —                                                                                          |
| `ProductForm` → `validateProductForm` | `gtin` trimé                                                                                                     | —                                                                                          |
| `ownedProductsRepository.create`      | insert `gtin`, `identification_method = 'barcode_scan'`                                                          | **aucune provenance persistée**                                                            |
| `requestCheckInBackground`            | RPC du check, `gtin` seul utilisé par le matching                                                                | —                                                                                          |

## 2. Symbologies

La liste caméra est **inchangée** (`productBarcodeFormats`). Aucun QR, DataMatrix ou PDF417 activé.

| Symbologie | Porte un GTIN ?                        | Longueurs acceptées | Transformation                            |
| ---------- | -------------------------------------- | ------------------- | ----------------------------------------- |
| `ean13`    | oui                                    | 12, 13              | aucune                                    |
| `upc_a`    | oui                                    | 12, 13              | aucune                                    |
| `ean8`     | oui (GTIN-8)                           | 8                   | aucune, **jamais UPC-E**                  |
| `upc_e`    | oui                                    | 8, 12               | 8 chiffres → **UPC-A** ; 12 = déjà étendu |
| `itf14`    | oui (GTIN-14)                          | 14                  | aucune                                    |
| `code128`  | **non** — Code 128 générique ≠ GS1-128 | —                   | jamais traité comme GTIN                  |

Un symbole EAN-13 encode 13 chiffres. Recall accepte une valeur GTIN-12 lorsque la couche caméra
la rapporte sous le type `ean13`, afin de rester robuste aux normalisations de scanner (un UPC-A est
un EAN-13 commençant par `0`). La valeur n'est jamais artificiellement préfixée ou tronquée : les
deux représentations ont simplement le même GTIN-14 canonique. Ce n'est pas une règle iOS : D2
reste non confirmé. La même tolérance vaut pour `upc_a` livré en 13 chiffres.

`itf14` : exactement 14 chiffres, check digit GTIN valide, GTIN-14 canonique identique à la valeur.
Sur iOS, Expo rapporte aussi un Interleaved 2 of 5 générique comme `itf14` : rien n'est généralisé à
d'autres ITF, et une valeur courte n'est jamais acceptée comme GTIN.

**Changement de comportement volontaire** : un Code 128 purement numérique avec un check digit
valide était classé `valid_gtin`. Il est désormais `non_gtin_product_code` (proposition de lire
l'étiquette). Un Code 128 peut contenir un GTIN dans certains systèmes GS1 (GS1-128, AI `01`), mais
sans preuve de structure GS1 (FNC1, identifiants d'application), un Code 128 générique ne doit pas
être traité comme un GTIN : 1 chaîne numérique sur 10 a par hasard un check digit valide. GS1-128
n'est pas implémenté dans cette phase.

## 3. Contrat d'identité de scan

`src/domain/barcode.ts` :

```ts
type ScannedBarcode = {
  rawValue: string; // BarcodeScanningResult.data, exactement tel que livré
  format: ProductBarcodeFormat; // BarcodeScanningResult.type
  classification: 'valid_gtin' | 'non_gtin_product_code' | 'invalid_or_unsupported';
  matchingGtin: string | null; // valeur de owned_products.gtin
  canonicalGtin14: string | null; // clé d'équivalence 17.3-S, interne
  transformation: 'upc_e_to_upc_a' | null;
};
```

- `rawValue` = `data` : la **valeur de code-barres livrée à JavaScript** par expo-camera, seul
  champ commun aux deux plateformes. Ce n'est pas forcément le payload natif brut du moteur de
  lecture (ML Kit, AVFoundation) : iOS peut déjà l'avoir normalisée. `event.raw` (Android seulement,
  non documenté publiquement, peut valoir `"null"`) n'entre pas dans le contrat ; sur l'appareil
  Android testé, il était identique à `data` pour EAN-13, EAN-8 et un UPC-E généré (§12). Le nom de colonne
  `barcode_raw_value` est conservé avec ce sens précis.
- **Fail closed** au bord du scanner : le payload doit être **exactement** des chiffres ASCII
  (rien n'est trimé, donc la valeur persistée est la valeur lue), d'une longueur que la symbologie
  peut porter, et valide pour la primitive 17.3-S. Sinon `invalid_or_unsupported`.
- `canonicalGtin14` et `transformation` se dérivent toujours de `(rawValue, format)` : ils ne sont
  ni transmis ni stockés.

## 4. Une seule sémantique GTIN (app / Edge / SQL)

| Option                                      | Évaluation                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. déplacer `gtin.ts` dans un module neutre | casse les manifests gelés (`normalization.ts` est gelé) et le bundling Edge hors `supabase/functions` n'est pas prouvé : rejeté |
| B. nouvelle couche commune                  | même coût que A, sans gain                                                                                                      |
| **C. wrapper app mince, source unique**     | **retenue** : l'app importe `supabase/functions/_shared/matching/gtin.ts` et `normalization.ts` directement                     |
| D. copie app                                | deuxième implémentation divergente : refusé                                                                                     |

- `gtin.ts` et `normalization.ts` sont des modules TS purs (imports relatifs `.ts`, aucune API
  Deno). `tsconfig` les inclut déjà ; Metro les résout dans la racine du projet. Vérifié par
  `expo export --platform android` : le bundle Hermes contient la primitive.
- `validateGtin` (app) délègue maintenant à `normalizeGtin` / `isValidGtin` : l'app n'a plus de
  calcul de check digit propre. Un test l'interdit (`weightedSum`, `% 10`, `padStart`).
- Aucun fichier Edge n'est modifié ; aucun deploy n'est nécessaire.
- Les mêmes vecteurs (`tests/fixtures/phase-17-3-s-gtin-vectors.json`) sont rejoués dans l'app
  (`validateGtin`, `toScannedBarcode('upc_e', …)`), l'Edge (tests 17.3-S) et le SQL (pgTAP 17.3-S).
- `cpsc/validation.ts` (ingestion) garde son validateur : hors périmètre app, couvert par le test
  de parité 17.3-S.

## 5. UPC-E

`type = upc_e` + 8 chiffres valides → `canonicalizeGtin(raw, { symbology: 'upc_e' })` →
`expandUpcE` de 17.3-S. Sans `upc_e`, jamais d'expansion.

| Scan                    | `rawValue`      | `matchingGtin` (`gtin`) | `canonicalGtin14` | `transformation` |
| ----------------------- | --------------- | ----------------------- | ----------------- | ---------------- |
| `upc_a` `091021037090`  | `091021037090`  | `091021037090`          | `00091021037090`  | —                |
| `ean13` `0091021037090` | `0091021037090` | `0091021037090`         | `00091021037090`  | —                |
| `upc_e` `04252614`      | `04252614`      | `042100005264`          | `00042100005264`  | `upc_e_to_upc_a` |
| `upc_e` `042100005264`  | `042100005264`  | `042100005264`          | `00042100005264`  | — (déjà étendu)  |
| `ean8` `01234558`       | `01234558`      | `01234558`              | `00000001234558`  | —                |
| `upc_e` `01234558`      | `01234558`      | `012345000058`          | `00012345000058`  | `upc_e_to_upc_a` |

Un payload UPC-E de 6 ou 7 chiffres (sans système de numérotation ou check digit) est refusé :
rien n'est deviné. Observé sur Android avec un code **généré** : `upc_e` + `04252614` (8 chiffres),
donc expansion réelle (§12).

## 6. Que stocker dans `owned_products.gtin` ?

| Option                        | Évaluation                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A. `gtin` = UPC-E brut        | le backend lirait un GTIN-8 (invalide ou **faux**, ex. `01234558`) : faux GTIN-8, matching cassé. Rejeté                     |
| **B. `gtin` = UPC-A étendu**  | **retenue** : compatible tel quel avec `canonical_gtin14`, l'index d'expression et les RPC 17.3-S ; aucun changement backend |
| C. `gtin` = GTIN-14 canonique | réécrit la représentation des UPC-A/EAN-13, change l'affichage, crée deux conventions historiques. Rejeté                    |
| D. colonnes dédiées           | **retenue en complément de B**, pour le raw et la symbologie                                                                 |

Pour toutes les autres symbologies, `gtin` reste la valeur lue (comportement inchangé).

## 7. Provenance : schéma minimal

Migration locale `20261005090000_phase_17_3a_scan_identity_provenance.sql`, deux colonnes
nullables, sans défaut ni backfill :

| Colonne             | Contenu                                            |
| ------------------- | -------------------------------------------------- |
| `barcode_raw_value` | valeur livrée à JavaScript, exacte (`04252614`)    |
| `barcode_symbology` | `ean13` \| `ean8` \| `upc_a` \| `upc_e` \| `itf14` |

- GTIN-14 canonique : **non stocké** (déjà dérivé par l'index d'expression 17.3-S).
- Transformation : **non stockée** (déterministe depuis raw + symbologie).
- `safety_attributes` n'est pas surchargé.
  Longueurs brutes acceptées (contrainte SQL = `gtinCarrierLengths` côté app) :

| Symbologie | Longueur                | Remarque                                         |
| ---------- | ----------------------- | ------------------------------------------------ |
| `ean13`    | 12 ou 13                | GTIN-12 toléré quand la caméra annonce `ean13`   |
| `upc_a`    | 12 ou 13                | idem, même famille de symboles                   |
| `ean8`     | 8                       | GTIN-8                                           |
| `upc_e`    | 8 ou 12                 | 8 = forme supprimée ; 12 = déjà étendue en UPC-A |
| `itf14`    | 14                      | GTIN-14                                          |
| autre      | refusé (dont `code128`) |                                                  |

Contraintes, toutes fail-closed :

- `owned_products_barcode_provenance_pair_check` : les deux colonnes sont nulles ensemble ou
  renseignées ensemble.
- `owned_products_barcode_provenance_check` : chiffres ASCII exacts (`^[0-9]+$`, rien de trimé),
  longueur du tableau ci-dessus.
- `owned_products_barcode_provenance_gtin_check` : l'identité du raw **sous sa symbologie** doit
  avoir le même GTIN-14 canonique que `gtin`. Seul `upc_e` de 8 chiffres est développé, par
  `private.expand_upce_to_upca` ; un `ean8` de 8 chiffres reste un GTIN-8. L'expression est
  enveloppée dans `coalesce(…, false)` : une comparaison `NULL` (`gtin` absent ou invalide, raw
  invalide) rejette, elle ne passe jamais le `CHECK`. Exemples : `gtin = 042100005264` ou
  `00042100005264` + `04252614`/`upc_e` acceptés ; `gtin = 012345678905` + `04252614`/`upc_e`
  refusé ; `012345000058` + `01234558`/`ean8` refusé.
- Les lignes historiques (deux colonnes `NULL`) ne sont concernées par aucune contrainte.

### Sémantique : provenance du GTIN **actuel**

`barcode_raw_value` + `barcode_symbology` décrivent le scan qui a produit le `gtin` actuel. Ce n'est
**pas** un historique permanent du premier scan (aucune table d'historique en 17.3a ; un historique
des scans serait une fonction séparée).

| Événement                                          | Provenance                         |
| -------------------------------------------------- | ---------------------------------- |
| création depuis un scan valide                     | enregistrée                        |
| `gtin` remplacé par une représentation équivalente | conservée (12 → 13 → 14)           |
| `gtin` remplacé par un GTIN non équivalent         | `NULL`                             |
| `gtin` remplacé par une valeur invalide            | `NULL` (fail closed)               |
| `gtin` supprimé                                    | `NULL`                             |
| nom, marque, modèle… modifiés, `gtin` inchangé     | conservée                          |
| GTIN d'origine remis après effacement              | reste `NULL` (pas de résurrection) |

### Primitive SQL UPC-E

`private.expand_upce_to_upca(text)` : miroir SQL exact de `expandUpcE` (8 chiffres ASCII,
système 0 ou 1, rien de trimé, règles GS1 de suppression des zéros, check digit validé par
`private.canonical_gtin14` sur l'UPC-A). `IMMUTABLE`, `STRICT`, `PARALLEL SAFE`, `SECURITY INVOKER`,
`search_path = ''`, corps SQL standard (`BEGIN ATOMIC`), aucune lecture de table, aucun SQL
dynamique. Elle n'est appelée que dans la branche `upc_e` de la contrainte ;
`private.canonical_gtin14` est **inchangée** et n'interprète toujours jamais 8 chiffres comme UPC-E.

Parité TS/SQL : le pgTAP 17.3a exécute la fonction SQL sur tous les vecteurs `upce` de
`tests/fixtures/phase-17-3-s-gtin-vectors.json` et de `tests/fixtures/phase-17-3a-upce-vectors.json`
(les 10 branches d6 du système 0, les branches 0/2/3/4/5 du système 1, mauvais check digit,
système 2 et 9, 7 et 9 chiffres, vide, non numérique, espaces, retour à la ligne, EAN-8 valide qui
n'est pas un UPC-E, `01234558` valide dans les deux lectures). Les blocs JSON sont embarqués octet
pour octet ; le test Node le vérifie et exécute les mêmes vecteurs dans `expandUpcE`.

Privilèges : comme `canonical_gtin14`, `EXECUTE` révoqué pour `public`, `anon`, `authenticated`,
`service_role`, puis accordé à `authenticated` et `service_role` seulement, parce qu'une contrainte
`CHECK` est évaluée avec les droits du rôle qui écrit. Le corps `BEGIN ATOMIC` est lié à la création :
aucun `USAGE` sur `private` n'est nécessaire, et aucun rôle d'API n'en a. Testé : appel par son nom
refusé (42501) ; sans ce grant, **tout** insert `authenticated` échoue (42501), le grant correspond
donc exactement au besoin de la contrainte ; aucune table `private` accordée à un rôle d'API.

### Effacement à la mise à jour

Garantie **côté base**, pas seulement par `ProductForm` : trigger
`owned_products_clear_stale_barcode_provenance`, `BEFORE UPDATE OF gtin`, dont la clause `WHEN`
compare `private.canonical_gtin14(OLD.gtin)` et `private.canonical_gtin14(NEW.gtin)`. Comme un UPC-E
est stocké dans `gtin` sous sa forme UPC-A, cette comparaison suffit. La fonction
`private.clear_stale_owned_product_barcode_provenance()` met les deux colonnes à `NULL` ; elle est
`security invoker`, `search_path = ''`, sans `EXECUTE` pour les rôles d'API. La clause `WHEN` est
stockée analysée : le rôle qui écrit n'a besoin que d'`EXECUTE` sur `canonical_gtin14`, déjà accordé
à `authenticated` et `service_role` par 17.3-S. Un contrôle par mutation (trigger désactivé) fait
échouer les tests pgTAP correspondants.

Côté app :

- L'app n'écrit la provenance qu'à la création (`toOwnedProductScanProvenanceRow` dans `create`) ;
  `toOwnedProductWriteRow`, utilisé aussi par `update`, ne la contient pas.
- `toOwnedProduct` n'expose `barcodeScan` que si la provenance décrit encore le `gtin` lu (même
  GTIN-14, via la primitive partagée). C'est une **défense en profondeur** : la base est la
  garantie, et une ligne conforme à ses contraintes ne peut pas échouer à ce contrôle.
- Produits manuels, OCR et antérieurs à 17.3a : colonnes `NULL`.

Aucune fonction de matching, index, policy, grant, empreinte ou règle F-4 n'est modifiée. Le trigger
d'armement du check produit ne surveille pas ces colonnes : elles ne sont pas des entrées du matching.

**Ordre de déploiement** : le `select` de l'app lit les deux colonnes. La migration doit être
installée en production **avant** toute build app contenant 17.3a. Les builds existantes restent
compatibles avec le nouveau schéma (colonnes nullables, jamais lues par elles).

## 8. Saisie manuelle

- 8/12/13/14 chiffres : validation GTIN 17.3-S, représentation trimée conservée.
- 8 chiffres : **GTIN-8 uniquement** ; `04252614` saisi à la main est un GTIN-8 invalide.
- Une saisie manuelle n'a jamais de `barcode_symbology`.

## 9. Route et ProductForm

- `ScanScreen` envoie `{ barcodeRawValue, barcodeSymbology, source: 'barcode_scan' }` : deux
  chaînes, pas d'objet JSON.
- `productCreationPrefillFromParams` traite ces paramètres comme non fiables : symbologie dans la
  liste GTIN, puis identité **recalculée** par `toScannedBarcode`. Le champ GTIN reçoit
  `matchingGtin` (pour un UPC-E, son UPC-A, qui passe la validation manuelle). La route historique
  `{ gtin, source }` fonctionne toujours, sans provenance.
- À l'enregistrement, `barcodeScanForSubmission` n'attache la provenance que si le GTIN soumis a
  toujours le même GTIN-14 canonique que le scan. Si l'utilisateur remplace ou vide le GTIN, rien
  n'est attaché.
- L'utilisateur peut toujours corriger le GTIN.

## 10. UX

- Confirmation (titre inchangé, « Product barcode detected ») : la symbologie et le **raw**
  (`091021037090`, `04252614`). Le GTIN-14 canonique n'est jamais affiché.
- Formulaire, UPC-E seulement : sous le champ GTIN, « Scanned UPC-E code 04252614, saved as its
  full 12-digit form. » La note disparaît si le champ change.
- Détail produit : ligne « Scanned barcode — 04252614 (UPC-E) » seulement si le raw diffère du
  GTIN **et** décrit toujours ce GTIN. Pas de ligne redondante pour un UPC-A.

## 11. D2 (iOS)

**UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE.** Aucun comportement spécifique iOS. Si iOS livre
`ean13` + `091021037090`, la valeur est acceptée telle quelle (12 chiffres, famille EAN-13/UPC-A)
et a le même GTIN-14 que les autres formes. La robustesse vient de raw + symbologie + normalisation
déterministe, pas d'un zéro ajouté ou retiré.

## 12. Acceptance Android (2026-10-05)

> Acceptance locale du 2026-10-05, sous Android 16 et via un client de développement. L'acceptance
> finale, sur l'APK preview accepté et sous Android 17, figure dans
> `docs/phase-17-3a-production-verification.md` §7.

### Méthode

- Appareil : Samsung SM-S938B, Android 16, client de développement Expo débuggable déjà installé
  (17.3a ne change que le JavaScript : aucune build native). Bundle servi par Metro sur l'arbre
  17.3a + diagnostic, vérifié par téléchargement du bundle.
- Diagnostic temporaire (patch hors dépôt, jamais commité, `__DEV__` uniquement, sans réseau, sans
  écriture, sans sauvegarde) : panneau visible dans l'UI avec numéro et heure du scan, `event.type`,
  `event.data`, longueur, `event.raw`, `raw === data`, classification, raw et symbologie conservés,
  GTIN de matching, GTIN-14 canonique, transformation.
- Relevé sans recopie manuelle : `adb` + `uiautomator dump` + captures d'écran. Chaque scan est
  reconstruit strictement à partir des dumps bruts : une ligne n'est attribuée à un scan que si son
  dump porte l'heure de ce scan ou suit sans interruption un dump de ce scan.
- Aucun produit sauvegardé (« Use this barcode » jamais touché).
- Retrait : `git apply -R` ; les 17 fichiers 17.3a sont identiques à leur empreinte pré-diagnostic,
  aucune trace dans `src`, bundle Metro sans diagnostic.

### Statut

| Élément     | Statut                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| EAN-13      | PHYSICAL PRODUCT TEST — conforme                                                             |
| EAN-8       | PHYSICAL PRODUCT TEST — conforme                                                             |
| UPC-A       | **NOT PHYSICALLY TESTED**                                                                    |
| UPC-E       | **NOT PHYSICALLY TESTED ON PRODUCT PACKAGING** — **GENERATED BARCODE TEST PASSED**           |
| D2 (iOS)    | **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**                                           |
| Orientation | une rotation avait été demandée, mais l'orientation n'est pas prouvable à partir des données |

### PHYSICAL PRODUCT TEST — EAN-13 et EAN-8 (produits belges)

Aucun UPC-A ni UPC-E physique disponible : non testés physiquement.

| Code                   | Scans observés                 | `type`  | `data` (longueur)    | `raw === data` | classification | `matchingGtin`  | `canonicalGtin14` | transformation |
| ---------------------- | ------------------------------ | ------- | -------------------- | -------------- | -------------- | --------------- | ----------------- | -------------- |
| EAN-13 `7622202826269` | 3 (n° 1, 3, 4)                 | `ean13` | `7622202826269` (13) | `true`         | `valid_gtin`   | `7622202826269` | `07622202826269`  | `null`         |
| EAN-8 `27044193`       | 3 (2 avant numérotation, n° 5) | `ean8`  | `27044193` (8)       | `true`         | `valid_gtin`   | `27044193`      | `00000027044193`  | `null`         |

- `event.raw` est toujours présent sur Android pour ces symbologies et **identique** à `event.data`.
- Stabilité : valeurs identiques sur tous les scans d'un même code, dont un scan avec orientation
  différente selon la consigne donnée (l'orientation n'est pas vérifiable dans les données).
- Scan n° 4 : `symbology (kept)` et `matching GTIN` n'ont pas été lus (lignes sautées au défilement) ;
  la carte affichait « EAN-13 » (libellé dérivé du même `format`) et le GTIN-14 est cohérent.
- Le scan n° 2 (EAN-13) a eu lieu mais n'a pas été capturé ; aucune valeur ne lui est attribuée.
- Aucune identité incohérente. Un enregistrement mélangé (n° 4 / n° 5) produit par l'outil de relevé
  a été identifié dans les dumps bruts et écarté ; l'app n'est pas en cause.
- EAN-13 de 12 chiffres : **non observé** sur Android (les EAN-13 réels arrivent en 13 chiffres).
  La tolérance reste pour la robustesse multi-plateforme ; D2 reste non confirmé.

### GENERATED BARCODE TEST — UPC-E `04252614` (jamais un PHYSICAL PRODUCT TEST)

Symbole UPC-E généré localement à partir des tables GS1 et affiché sur l'écran d'un ordinateur. Ce
test montre uniquement ce qu'expo-camera rapporte pour un symbole UPC-E généré ; il ne prouve rien
sur un emballage réel.

| Scan | `type`  | `data` (longueur) | `raw === data` | classification | `matchingGtin` | `canonicalGtin14` | transformation   |
| ---- | ------- | ----------------- | -------------- | -------------- | -------------- | ----------------- | ---------------- |
| n° 8 | `upc_e` | `04252614` (8)    | `true`         | `valid_gtin`   | `042100005264` | `00042100005264`  | `upc_e_to_upc_a` |

- ML Kit / expo-camera livre le UPC-E **en 8 chiffres** avec `type = upc_e` ; la transformation a
  réellement eu lieu dans l'app. Le cas « 12 chiffres déjà étendus » n'a pas été observé (il reste
  accepté par le contrat).
- Trois scans du code généré ont été faits (n° 6 à 8) ; seul le n° 8 a été capturé. Le contenu des
  n° 6 et 7 est inconnu et n'est pas revendiqué.

## 13. QR / DataMatrix / PDF417

Non activés. GS1 Digital Link et GS1-128 relèvent d'une sous-phase distincte.

## 14. Contrat du lookup produit (phase suivante)

Aucun fournisseur appelé en 17.3a. Entrée exacte :

```ts
type ProductLookupRequest = {
  matchingGtin: string; // GTIN de matching (owned_products.gtin ou ScannedBarcode.matchingGtin)
  canonicalGtin14: string; // canonicalGtin14(matchingGtin), primitive 17.3-S ; clé du lookup
  scan: { rawValue: string; symbology: GtinCarrierSymbology } | null; // contexte, jamais la clé
};
```

| Source                           | `matchingGtin` | `canonicalGtin14`       | `scan`                 |
| -------------------------------- | -------------- | ----------------------- | ---------------------- |
| scan en cours (`ScannedBarcode`) | `matchingGtin` | `canonicalGtin14`       | `{ rawValue, format }` |
| produit scanné stocké            | `gtin`         | `canonicalGtin14(gtin)` | `product.barcodeScan`  |
| produit manuel / historique      | `gtin`         | `canonicalGtin14(gtin)` | `null`                 |

Règles : pas de lookup si `canonicalGtin14(gtin)` est nul ; la clé est toujours dérivée de `gtin`
(ou de `matchingGtin`), **jamais** d'un raw sans symbologie ; un raw UPC-E de 8 chiffres n'est
qu'un contexte d'affichage. Sortie au plus : nom, marque, éventuellement image et catégorie, comme
**suggestions** à confirmer dans le formulaire.

## 15. Compatibilité 17.3-S

- `gtin.ts`, `normalization.ts`, migration `20261004090000`, tests et documents de clôture
  inchangés.
- Vecteurs 17.3-S rejoués ; pgTAP 17.3-S vert après `db reset`.
- L'équivalence GTIN ne confirme toujours rien seule ; F-4 inchangée.
- Seul ajout aux garde-fous : la migration 17.3a est enregistrée avec son SHA-256 dans
  `tests/phase-17-7a-2-automation.test.mjs` (`LATER_PHASES`), comme 17.3-S.

## 16. Tests

- `tests/phase-17-3a-scan-identity.test.mjs` (T1–T16, parité des vecteurs, absence de second
  calcul de check digit, revalidation des paramètres de route) ; `npm run test:phase-17-3a`.
- `supabase/tests/phase-17-3a-scan-provenance.sql` : colonnes, contraintes fail-closed (paire
  partielle, `code128`, symbologie inconnue, longueur impossible, non numérique, espaces, GTIN
  absent ou invalide, raw non équivalent), insert et édition par le propriétaire (RLS), sémantique
  « GTIN actuel » (équivalent 12 → 13 → 14 conservé, non équivalent / invalide / `NULL` effacé, pas
  de résurrection, produit historique inchangé), invariant UPC-E en SQL (cas A–I, parité des
  vecteurs, privilèges et nécessité exacte du grant), contrôles par mutation (trigger désactivé,
  contrainte supprimée : les tests correspondants échouent), UPC-E stocké en UPC-A retrouvé par le RPC 17.3-S
  inchangé, 8 chiffres manuels jamais devinés UPC-E, trigger d'armement non élargi.
- `scripts/validate-phase-6-1.mjs` : `.gtin` → `.matchingGtin`.

## 17. Limites

- `identification_method` reste `barcode_scan` si l'utilisateur remplace le GTIN scanné avant
  d'enregistrer (comportement existant) ; seule la provenance est alors omise.
- Pas d'historique des scans : effacée, une provenance est perdue (choix explicite).
- Android : UPC-A et UPC-E **physiques** non testés (aucun produit disponible) ; UPC-E observé
  seulement sur un code **généré**.
- iOS : D2 non confirmé.
