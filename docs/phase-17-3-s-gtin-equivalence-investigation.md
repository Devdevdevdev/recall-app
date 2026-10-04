# Phase 17.3-S — GTIN equivalence safety investigation

Statut : **investigation close — implémentation 17.3-S justifiée (§11)**. Aucune correction
dans cette passe.
Base : `main` @ `0782159` (« Close Phase 17.7 after production verification »).
Contraintes de la passe : aucune production, migration, deploy, changement F-4, changement
matching, commit ni push. Le diagnostic `__DEV__` temporaire (§4) a été **retiré**.

Statuts finaux (2026-10-04) :

- **D1 (UPC-E) = CONFIRMED.**
- **D2 (iOS) = UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE.**
- **Défaut d'équivalence indépendant = CONFIRMED** (code actuel + exécution locale, §11.2).
- ANDROID-1 : **aucune ligne de log appareil capturée** (§11.1). Aucun test Android physique
  n'est revendiqué.

Suite : implémentation locale 17.3-S, voir `docs/phase-17-3-s-gtin-equivalence-implementation.md`.

Défauts suivis (numérotation de `docs/phase-17-3-product-identity-design.md`) :

- **D1** : un vrai UPC-E est rejeté (mod-10 calculé comme un GTIN-8).
- **D2** : le même UPC-A physique peut produire deux GTIN de longueurs différentes selon la
  plateforme, ce qui rend le matching faux.

---

## 0. Résumé

1. **Le code de expo-camera 57.0.5 contredit l'hypothèse de l'audit 17.3 pour iOS.** iOS déclare
   bien un UPC-A comme `ean13`, mais expo-camera **retire un `0` initial** de toute valeur EAN-13
   avant de l'envoyer au JS (`BarcodeScannerUtils.swift` l. 33-39). D'après le code, iOS devrait
   donc livrer `type: "ean13"` et `data: "091021037090"` (12 chiffres), pas 13 chiffres. **Ce
   n'est qu'une prédiction tirée du code** : D2 reste **NON CONFIRMÉ** tant que les appareils
   réels n'ont pas parlé (§7).
2. Recall conserve `event.data` sans transformation (seul `trim` est appliqué) : aucun zéro
   ajouté ou retiré, aucune expansion. La symbologie est perdue à l'enregistrement : `type` ne
   sert qu'à choisir le libellé affiché et n'est jamais persisté.
3. Toutes les comparaisons GTIN produit/rappel (3 en SQL, 4 en TypeScript) sont des **égalités
   exactes de chaînes de chiffres**, sans complément de zéros. Si deux représentations
   équivalentes coexistent, le risque est un **faux négatif** : le rappel n'est pas récupéré, ou
   il est rejeté comme « identifiant contradictoire ». Aucun faux positif n'est possible par ce
   biais. F-4 n'est pas concerné : un critère GTIN n'est jamais éligible à une alerte
   automatique.
4. Même si D2 caméra n'est pas reproduit, des représentations GTIN-13 (`0…`) ou GTIN-14 (`00…`)
   peuvent entrer par la **saisie manuelle** ou un scan ITF-14. C'est un risque distinct de D2,
   mais il justifie le même design (§8).

---

## 1. Chemin exact d'un scan expo-camera

### 1.1 Natif (expo-camera **57.0.5**, résolu dans `package-lock.json`)

Chemin réel :
`node_modules/.deno/expo-camera@57.0.5/node_modules/expo-camera`.

**iOS — `CameraView` + `onBarcodeScanned`** (AVFoundation, `MetaDataDelegate.swift` l. 33-58) :

| Étape             | Fichier                                              | Effet sur la valeur                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Types demandés    | `BarcodeScannerUtils.swift` l. 8-12                  | `upc_a` → `AVMetadataObject.ObjectType.ean13` (iOS n'a pas de type UPC-A). `ean13` → `.ean13`. Les deux demandes deviennent donc le même type AV.                                                                                                                                                                                    |
| `type` renvoyé    | `BarcodeRecord.swift` `toBarcodeType` l. 64-95       | `.ean13` → `"ean13"`. **iOS ne peut jamais renvoyer `"upc_a"`.** `.upce` → `"upc_e"`. `.itf14` / `.interleaved2of5` → `"itf14"`.                                                                                                                                                                                                     |
| `data` renvoyé    | `BarcodeScannerUtils.swift` l. 31-39                 | `data = stringValue`. **Si le type AV est `.ean13` et que la valeur commence par `0`, un seul `0` initial est retiré** (`value.dropFirst()`). Commentaire Expo : _« iOS converts upc_a to ean13 and appends a leading 0 »_. Toute valeur EAN-13 commençant par `0` est concernée, qu'elle soit imprimée comme UPC-A ou comme EAN-13. |
| `raw`             | —                                                    | absent sur iOS (`raw` vaut `undefined`, d'après `Camera.types.ts` l. 309-315 et CHANGELOG #25391).                                                                                                                                                                                                                                   |
| Fournisseur ZXing | `ios/barcode-scanning/ExpoCameraZXingProvider.swift` | ne lit que pdf417, code39 et codabar ; **il ne touche ni EAN ni UPC**.                                                                                                                                                                                                                                                               |
| Chemin VisionKit  | `visionDataScannerObjectToDictionary`                | réservé à `launchScanner` (modal), **que Recall n'utilise pas**.                                                                                                                                                                                                                                                                     |

Point à observer sur l'appareil : `dropFirst()` produit une `Substring` Swift placée dans un
`[String: Any]`. Si sa conversion vers JS se passe mal, `data` peut arriver vide, absent ou
inattendu. Le diagnostic (§4) le montrera.

**Android** (ML Kit, `BarcodeAnalyzer.kt` l. 47-68, `ExpoCameraView.kt` l. 799-818,
`CameraRecords.kt` l. 91-137) :

| Champ  | Valeur                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `type` | `Barcode.FORMAT_UPC_A` → `"upc_a"`, `FORMAT_EAN_13` → `"ean13"`, `FORMAT_UPC_E` → `"upc_e"`                                 |
| `data` | `barcode.displayValue` (`value.toString()`), sans transformation par Expo                                                   |
| `raw`  | `(barcode.rawValue ?: String(rawBytes)).toString()`. Si les deux sont nuls, Kotlin produit la **chaîne littérale `"null"`** |

ML Kit devrait renvoyer un UPC-A en 12 chiffres, mais ce n'est pas vérifié dans le code : seul
l'appareil le dira. De même, un UPC-E pourrait arriver en 8 chiffres ou étendu : à observer.

**JS expo-camera** (`CameraView.tsx` l. 315-335) : simple dédoublonnage d'événements identiques
(500 ms). Aucune transformation de `type` ni de `data`.

### 1.2 Recall

```
BarcodeScanningResult { type, data, raw? }
 │
 ├─ ScanScreen.handleBarcodeScanned            src/features/scan/ScanScreen.tsx l. 146-192 (avec diagnostic ; 146-176 sans)
 │    format = event.type as ProductBarcodeFormat
 │    format ∉ [ean13, ean8, upc_a, upc_e, itf14, code128] → événement ignoré, sans trace
 │    toScannedBarcode(format, rawValue = event.raw ?? event.data, valueForNormalization = event.data)
 │
 ├─ toScannedBarcode / validateGtin            src/domain/barcode.ts l. 38-87
 │    normalizedValue = event.data.trim()               ← seule transformation
 │    syntaxe : /^\d+$/ et longueur ∈ {8,12,13,14}
 │    contrôle mod-10 GS1 (poids 3/1 depuis la droite) — identique pour toutes les longueurs,
 │      donc UPC-E testé comme un GTIN-8 (D1)
 │    gtin = normalizedValue si valide, sinon null
 │    `format` n'influence que code128 (classification non_gtin_product_code)
 │
 ├─ ConfirmationCard                           ScanScreen.tsx l. ~520-560
 │    affiche barcodeTypeLabels[format] (iOS : « EAN-13 » pour un UPC-A) + normalizedValue
 │
 ├─ useBarcode → router.push('/products/new', { gtin: detected.gtin, source: 'barcode_scan' })
 │    seul le GTIN est transmis ; format et rawValue sont abandonnés ici
 │
 ├─ app/products/new.tsx → productCreationPrefillFromParams
 │    src/features/products/productFormUtils.ts l. 129-147
 │    revalide validateGtin(params.gtin) → values.gtin = normalizedValue (trim)
 │
 ├─ ProductForm (champ « GTIN / barcode », modifiable, max 14 caractères)
 │    validateProductForm l. 236-242, 301 : validateGtin → input.gtin = normalizedValue
 │
 └─ SupabaseOwnedProductsRepository.create → owned_products.gtin (text, sans contrainte de format)
      identification_method = 'barcode_scan'
```

Réponses aux questions posées :

| Question                          | Réponse                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data` est-il conservé tel quel ? | Oui, à un `trim` près. C'est `event.data`, et non `event.raw`, qui est validé et persisté.                                                                                                                                                               |
| Recall ajoute/enlève des zéros ?  | **Non**, nulle part côté app. Le seul retrait de zéro est fait par **expo-camera iOS**, en amont de Recall.                                                                                                                                              |
| Dépendance à `type` ?             | Filtrage (types non listés ignorés), libellé affiché, classification code128. **La validation GTIN ne dépend pas de `type`** : un `upc_e` est validé comme un GTIN-8.                                                                                    |
| Perte de symbologie ?             | **Oui.** Elle n'est ni transmise à `/products/new` ni persistée. De plus, iOS l'a déjà perdue : il est impossible de distinguer un UPC-A d'un EAN-13 commençant par `0`. C'est sans conséquence, car les barres sont identiques et les GTIN équivalents. |
| Autres entrées du même champ      | La saisie manuelle et l'édition acceptent 8/12/13/14 chiffres sans canonicalisation. `0091021037090` ou `00091021037090` saisis à la main sont stockés tels quels.                                                                                       |

---

## 2. Sites de comparaison GTIN produit ↔ rappel

Les primitives de normalisation :

- **SQL** : `regexp_replace(gtin, '[^0-9]', '', 'g')`. Supprime tout caractère non chiffre ; aucun
  complément de zéros.
- **TS** : `normalizeGtin` (`_shared/matching/normalization.ts` l. 21-28). `trim`, puis **rejet**
  si un caractère n'est pas un chiffre ; aucun complément. `isValidGtin` (l. 30-43) : longueurs
  8/12/13/14 et mod-10.
- **Ingestion CPSC** : `cpsc/validation.ts::validateGtin` (l. 122+), qui accepte 8 ou 12-14
  chiffres. Un UPC valide est stocké **tel que publié** dans `recall_scopes.gtin`
  (`cpsc/mapper.ts` l. 72-82), sinon il est rangé dans `source_upc`. Health Canada : `gtin: null`.

| #   | Site                                                                                                                                                  | Lang. | Comparaison                                                                                                              | Normalisé ?                  | Candidate generation                                                       | v1                                                                                                                                           | v2                                                                                                    | F-4 / éligibilité automatique                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S1  | `public.get_recall_candidates`, `20260914100000_phase_10_recall_matching.sql` l. 204-207 (rang exact) et l. 244-247 (filtre candidat)                 | SQL   | `regexp(owned.gtin) = regexp(scope.gtin)`                                                                                | chiffres seulement, sans pad | **oui** : sens rappel → produits (`process-recall-matches/store.ts` l. 71) | alimente v1                                                                                                                                  | alimente aussi la projection v2 du batch                                                              | aucun rôle direct                                                                    |
| S2  | `public.get_owned_product_recall_candidates`, `20261002120000_phase_17_7a_1_owned_product_recall_checks.sql` l. 232-233 et l. 253-255 (hit de rang 4) | SQL   | `regexp(scope.gtin) = product.gtin_key`                                                                                  | idem                         | **oui** : sens produit → rappels (`productCheck/supabaseStore.ts` l. 178)  | alimente v1 (product check)                                                                                                                  | alimente v2 (product check)                                                                           | aucun rôle direct                                                                    |
| S3  | index `owned_products_normalized_gtin_idx` et `recall_scopes_normalized_gtin_idx` (phase 10, l. 38-40 et 57-59)                                       | SQL   | support de S1/S2                                                                                                         | idem                         | performance                                                                | —                                                                                                                                            | —                                                                                                     | —                                                                                    |
| T1  | `retrieveRecallCandidates`, `_shared/matching/candidateRetrieval.ts` l. 66-82 (signal `exact_gtin`), classement l. 21                                 | TS    | `official === ownedGtin` et les deux valides                                                                             | `normalizeGtin`, sans pad    | **oui** : signal `exact_gtin` (score 1), rang de tête                      | signal propagé vers v1                                                                                                                       | `productCheck/orchestrator.ts` l. 167 dérive `matched.gtin` du signal                                 | aucun                                                                                |
| T2  | `evidence.ts` l. 153-190 (comparaison), décision l. 321-412                                                                                           | TS    | égal → `matched.gtin` ; **les deux valides et différents → `conflicting.gtin`**                                          | `normalizeGtin`, sans pad    | —                                                                          | **décisif** : match GTIN seul → `confirmed` (l. 353-362) ; GTIN différent → `rejected`, confiance 0,98 (l. 403-412) ; mixte → `needs_review` | —                                                                                                     | `confirmed` v1 rétrogradé par F-4 sauf éligibilité, que GTIN ne peut jamais produire |
| T3  | `criterionEvaluatorV2.ts` l. 44 et l. 61-80, critère `kind: 'gtin'`                                                                                   | TS    | `equals` : `===` ; `one_of` : `includes` ; `prefix` : `startsWith`                                                       | `normalizeGtin`, sans pad    | —                                                                          | —                                                                                                                                            | **décisif** : `false` = « safely contradicts » → scope exclu (`deterministicMatcherV2.ts` l. 98, 139) | kind `gtin` ⇒ inéligible (voir F4)                                                   |
| T4  | `nemotronSafetyVerifier.ts` l. 106-109                                                                                                                | TS    | `left === right` et les deux valides                                                                                     | `normalizeGtin`, sans pad    | —                                                                          | hybride guardé v1 : une affirmation IA « GTIN » est refusée si les valeurs diffèrent                                                         | —                                                                                                     | —                                                                                    |
| F4  | `private.automatic_alert_eligibility`, `20261002110000_phase_17_7a_f4_automatic_alert_safety.sql` l. 175                                              | SQL   | **aucune comparaison GTIN** : tout critère dont le kind n'est pas `model_number` ou `date_code` rend la règle inéligible | —                            | —                                                                          | —                                                                                                                                            | —                                                                                                     | **un GTIN ne peut ni créer ni bloquer une éligibilité**                              |

Comparaisons de produit à produit, sans lien avec le matching de rappel :

- `productMonitoring.ts` l. 57 : `before.gtin !== after.gtin`.
- Trigger `arm_owned_product_recall_check` (17.7a-1, l. 160-167) : `old.gtin is distinct from
new.gtin`. Passer de 12 à 13 chiffres réarme donc la vérification, ce qui est sans danger.

Non concernés :

- `nemotronSafetyVerifierV2_1.ts` et `hybridGuardedMatcher.ts` l. 94 : associations de champs,
  sans comparaison de valeurs GTIN.
- `guardedNemotronProjectionV2_1.ts` et `productionPolicyV2.ts` : projection seulement.

**Conséquence d'une représentation divergente.** Cas : produit `0091021037090`, scope CPSC
`091021037090`.

| Étape                 | Effet                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S1 / S2               | aucun hit GTIN ; le rappel n'est récupéré que via nom, marque ou modèle                                                              |
| T1                    | aucun signal `exact_gtin`                                                                                                            |
| T2, s'il est récupéré | les deux GTIN sont valides et différents : **`rejected` à 0,98 de confiance**, soit un faux négatif présenté comme une contradiction |
| T3                    | critère `gtin` « safely contradicted » : scope exclu                                                                                 |
| F-4                   | inchangé                                                                                                                             |

**Direction du risque : manquer un rappel réel.** La divergence ne peut pas créer d'alerte à tort.

---

## 3. Cas Thule de référence

Primitive locale testée : script jetable hors dépôt (`node --test`, **9/9 tests passent**).
Le check digit a été recalculé à la main.

```
checkDigit(body) = (10 - Σ digit_i × (3 si i pair sinon 1), i compté depuis la droite du corps) mod 10
toGtin14(v)      = v valide ? v.padStart(14, '0') : null      (GS1 : champ 14 chiffres, justifié à droite, complété par des zéros)
```

| Représentation                            | Valeur           | Longueur | Check digit       | Valide GS1 | Équivalente au GTIN Thule ?                        |
| ----------------------------------------- | ---------------- | -------- | ----------------- | ---------- | -------------------------------------------------- |
| UPC-A (GTIN-12) imprimé                   | `091021037090`   | 12       | `0` (calculé `0`) | oui        | référence                                          |
| EAN-13 / GTIN-13 (`0` + UPC-A)            | `0091021037090`  | 13       | `0`               | oui        | **oui** : même GTIN                                |
| GTIN-14 canonique                         | `00091021037090` | 14       | `0`               | oui        | **oui** : forme canonique                          |
| Valeur AVFoundation probable (avant Expo) | `0091021037090`  | 13       | —                 | —          | Expo la ramène à `091021037090` (prédiction, §1.1) |
| Zéros supprimés arbitrairement            | `91021037090`    | 11       | —                 | **non**    | **interdit**                                       |
| GTIN-14 avec indicateur 1 (carton)        | `10091021037097` | 14       | `7`               | oui        | **non** : autre article commercial                 |

La valeur `10091021037097` du carton a été recalculée : le corps est `1009102103709`.

Règles d'équivalence retenues (GS1 General Specifications, format de stockage GTIN-14) :

1. GTIN-8, GTIN-12, GTIN-13 et GTIN-14 valides sont équivalents **si et seulement si** leur
   complément à gauche par des zéros jusqu'à 14 chiffres est identique. Le check digit ne change
   pas, car les poids partent de la droite.
2. Seul un **complément** de zéros est permis. Recall ne retire jamais de zéro lui-même ; le
   seul retrait observé dans le code est celui de expo-camera iOS, et il reste équivalent au
   sens de la règle 1.
3. **Exception UPC-E** : un UPC-E de 8 chiffres **n'est pas** un GTIN-8. Le compléter par des
   zéros donne un autre identifiant (`00000004252614` ≠ `00042100005264`). Il faut d'abord
   l'étendre en UPC-A, ce qui suppose de connaître sa symbologie.
4. L'indicateur d'un GTIN-14 (1-8 : niveau d'emballage ; 9 : mesure variable) n'est jamais
   retiré.

---

## 4. Diagnostic physique (local, temporaire)

**Nécessaire.** Il n'existe aucun log sur ce chemin, et l'UI ne montre ni `event.type` (seulement
le libellé dérivé), ni `event.raw`, ni les longueurs, ni d'éventuels caractères invisibles. Elle
ne montre rien non plus quand un type est ignoré.

Patch appliqué **dans l'arbre de travail uniquement, non commité** :
`src/features/scan/ScanScreen.tsx`, 16 lignes délimitées par `PHASE-17.3-S-DIAG`, en tête de
`handleBarcodeScanned`, après le verrou et **avant** le filtre de format.

- exécuté seulement si `__DEV__` ;
- `console.log('[17.3-S]', JSON.stringify({...}))`, ce qui échappe les caractères de contrôle.
  Champs : `os`, `osVersion`, `eventType`, `eventData`, `eventDataLength`, `eventRaw`,
  `eventRawLength`, `supported`, `format`, `classification`, `normalizedValue`, `gtin`,
  `gtinLength`, `isValidGtin` ;
- appelle le **même** `toScannedBarcode` que le code de production, sans rien changer à son
  comportement ;
- aucun secret, aucun réseau, aucune persistance, aucune écriture backend.

Vérifications : `tsc --noEmit` passe. `eslint` signale **un warning `no-console`, conservé
volontairement** pour empêcher un commit par inadvertance.

Suppression : `git checkout -- src/features/scan/ScanScreen.tsx` (le fichier n'avait aucune
autre modification).

**Retiré le 2026-10-04.** `ScanScreen.tsx` est identique à `HEAD` (`git diff` vide,
0 occurrence de `17.3-S`). Le patch a été conservé hors dépôt (scratchpad de session) pour une
éventuelle nouvelle capture Android. Pour le réappliquer : `git apply <patch>`, puis le retirer
à nouveau de la même façon.

---

## 5. Tests physiques UPC-A

### Précautions communes (production)

- Utiliser un **build de développement** (`expo-dev-client`), car `__DEV__` doit être vrai. Les
  logs apparaissent dans le terminal Metro (`npx expo start --dev-client`).
- **Ne jamais appuyer sur « Save »** dans le formulaire : l'enregistrement écrit dans
  `owned_products` de l'environnement Supabase configuré. Ouvrir le formulaire n'écrit rien,
  puisque `createProduct` n'est appelé qu'au Save.
- S'arrêter sur le formulaire prérempli, puis revenir en arrière.

### IOS-1 — iPhone, UPC-A Thule `091021037090`

1. Build : `npx expo run:ios --device` en local (crée `/ios`, qui est ignoré par git), ou un
   build EAS profil `development` déjà installé. Ne pas utiliser `production`.
2. Lancer Metro et ouvrir l'onglet Scan en mode barcode.
3. Scanner le code UPC-A imprimé sur l'emballage Thule, seul (cacher les autres codes).
4. Relever la ligne `[17.3-S]` dans Metro.
5. Noter le libellé affiché (« EAN-13 » attendu d'après le code), la valeur affichée et le
   message (« valid GTIN check digit » ou non).
6. Appuyer sur « Use this barcode », puis noter la valeur exacte du champ « GTIN / barcode » du
   formulaire. **Ne pas enregistrer.**
7. Répéter 3 fois, dont une avec le code tourné à 180°.

### ANDROID-1 — même code physique

Procédure identique (`npx expo run:android --device` ou dev client existant). Le libellé attendu
d'après le code est « UPC-A ».

### Grille de relevé (une ligne par scan)

| Test      | Appareil / OS (modèle, `osVersion`)                | expo-camera | eventType | eventData | eventDataLength | eventRaw | libellé UI | gtin Recall | gtinLength | classification | champ formulaire |
| --------- | -------------------------------------------------- | ----------- | --------- | --------- | --------------- | -------- | ---------- | ----------- | ---------- | -------------- | ---------------- |
| IOS-1     | **non exécuté : aucun iPhone physique disponible** | 57.0.5      | —         | —         | —               | —        | —          | —           | —          | —              | —                |
| ANDROID-1 | **sortie non reçue** (voir §11.1)                  | 57.0.5      | —         | —         | —               | —        | —          | —           | —          | —              | —                |

Prédiction tirée du code, **à infirmer ou confirmer, sans valeur de preuve** :

- iOS : `ean13` / `091021037090` / 12 / `raw` null.
- Android : `upc_a` / `091021037090` / 12 / `raw` `091021037090`.

---

## 6. Test UPC-E séparé

Ce test documente seulement D1. **Ne pas le mélanger** avec une correction UPC-A.

### UPCE-1 — iOS puis Android

- Trouver un vrai produit portant un UPC-E. Les petits formats nord-américains (canettes,
  chewing-gum, petits flacons) en portent souvent.
- Valeur de référence calculée : UPC-E `04252614` → UPC-A `042100005264` → GTIN-14
  `00042100005264`. Si aucun emballage réel ne porte ce code, relever le code réel et faire
  l'expansion à la main avec les règles ci-dessous.
- Relever les mêmes champs qu'au §5, plus le message de l'UI.

Règles d'expansion UPC-E vers UPC-A (système de numérotation 0 ou 1, `NS d1 d2 d3 d4 d5 d6 C`) :

| d6    | UPC-A                            |
| ----- | -------------------------------- |
| 0,1,2 | `NS d1 d2 d6 0 0 0 0 d3 d4 d5 C` |
| 3     | `NS d1 d2 d3 0 0 0 0 0 d4 d5 C`  |
| 4     | `NS d1 d2 d3 d4 0 0 0 0 0 d5 C`  |
| 5-9   | `NS d1 d2 d3 d4 d5 0 0 0 0 d6 C` |

`C` doit être le check digit mod-10 de l'UPC-A étendu.

Comportement actuel vérifié avec les fonctions Recall :

| Entrée                                      | Résultat Recall                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `toScannedBarcode('upc_e', '04252614')`     | `invalid_or_unsupported`, `gtin = null` : « not a supported product identifier » |
| `toScannedBarcode('upc_e', '042100005264')` | `valid_gtin`, `042100005264`, si une plateforme livrait la forme étendue         |

Questions auxquelles le test répond :

- `type` brut : `upc_e` sur les deux plateformes ?
- `data` brute : 8 chiffres ou forme étendue ?
- `raw` sur Android : différent de `data` ?

**Statut UPC-E** : D1 est confirmé par le code et le calcul, et le test physique doit encore
dire quelle forme chaque plateforme livre. La valeur canonique correcte est `00042100005264` pour
`04252614`.

---

## 7. Critère de confirmation de D2

D2 est **CONFIRMÉ** seulement si l'une de ces conditions est observée sur appareil réel :

- le même code physique donne des `gtin` Recall différents entre iOS et Android ;
- iOS livre une représentation EAN-13 à 13 chiffres (`0091021037090`) que Recall stocke telle
  quelle, ce que l'on vérifie par la valeur du champ formulaire.

Dans tous les autres cas, D2 reste **NON CONFIRMÉ**. On ne conclut jamais depuis le seul code
Expo. La prédiction du §5 ne compte pas comme une observation.

**Statut D2 au 2026-10-04 : UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE.** Ni le code
natif d'expo-camera (§1.1) ni sa documentation ne valent preuve physique.

Cas particulier : si iOS livre un `data` vide, absent ou non numérique (souci de conversion de
la `Substring`), D2 n'est pas confirmé, mais un défaut iOS distinct est confirmé. Il faut alors
le documenter à part.

Dans tous les cas, le risque d'entrée manuelle (§0, point 4) reste vrai indépendamment de D2. Il
est vérifiable sans appareil : saisir `0091021037090` dans le formulaire passe la validation.

---

## 8. Design 17.3-S, à n'engager que si D2 ou le risque d'entrée manuelle est retenu

Aucune implémentation dans cette passe.

### 8.1 Modèle

```
raw_code         text   -- tel que lu (data), ou saisi ; jamais réécrit
symbology        text   -- ean13 | ean8 | upc_a | upc_e | itf14 | code128 | qr_* | manual
gtin             text   -- existant : valeur validée affichée à l'utilisateur, inchangée
canonical_gtin14 text   -- toGtin14(...) après expansion UPC-E éventuelle ; clé d'équivalence
```

Pour le Thule :

| Plateforme             | raw_code        | symbology | gtin            | canonical_gtin14 |
| ---------------------- | --------------- | --------- | --------------- | ---------------- |
| Android                | `091021037090`  | `upc_a`   | `091021037090`  | `00091021037090` |
| iOS (prédiction)       | `091021037090`  | `ean13`   | `091021037090`  | `00091021037090` |
| iOS (si D2 confirmé)   | `0091021037090` | `ean13`   | `0091021037090` | `00091021037090` |
| Saisie manuelle 13 ch. | `0091021037090` | `manual`  | `0091021037090` | `00091021037090` |
| UPC-E `04252614`       | `04252614`      | `upc_e`   | `042100005264`  | `00042100005264` |
| Scope CPSC             | `091021037090`  | —         | `091021037090`  | `00091021037090` |

### 8.2 Évaluation de GTIN-14 comme clé d'équivalence

Pour :

- forme canonique officielle GS1 ;
- injective sur l'espace GTIN valide, avec les exceptions UPC-E et indicateur traitées en amont ;
- check digit invariant ;
- calculable en SQL (`lpad(digits, 14, '0')` après validation) comme en TS ;
- déjà prévue pour le cache et le lookup dans le design 17.3.

Contre et précautions :

- il faut une **source unique** de la primitive, au lieu de trois copies
  (`barcode.ts`, `normalization.ts`, `cpsc/validation.ts`), avec des tests de parité SQL/TS ;
- un 8 chiffres sans symbologie connue reste ambigu (EAN-8 ou UPC-E) : le traiter comme GTIN-8,
  sans deviner ;
- il faut de nouveaux index d'expression et une migration de données historiques ou un calcul à
  la volée, avec la procédure prod habituelle (GO par étape) ;
- `regexp_replace('[^0-9]')` en SQL est plus permissif que `normalizeGtin` en TS, qui rejette.
  Il faut aligner sur le rejet.

### 8.3 Règle de sûreté (non négociable)

Un `canonical_gtin14` égal signifie **uniquement** « même identifiant commercial GTIN ». Il :

- **n'est jamais** une confirmation à lui seul : la logique v1 T2 (`hasGtinMatch` →
  `confirmed`) n'est pas élargie sans réexamen, et F-4 continue de rétrograder ;
- **ne contourne pas** les restrictions lot, date ou modèle, ni les critères
  `additionalCriteria` ou `source_upc` ;
- **ne contourne pas** la juridiction ni `coverageComplete` ;
- **ne contourne pas** F-4 : le kind `gtin` reste hors de `('model_number', 'date_code')` ;
- élargit seulement la récupération des candidats (S1, S2, T1), et la non-contradiction en T2,
  T3 et T4.

Effet attendu : moins de faux négatifs, et aucun nouveau chemin vers une alerte automatique.

---

## 9. Tests futurs à préparer (non écrits dans cette passe)

| ID  | Cas                                                          | Entrées                                                         | Attendu                                                                                                             |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A   | UPC-A 12 vs EAN-13 avec zéro initial                         | `091021037090` / `0091021037090`                                | équivalents (GTIN-14 `00091021037090`)                                                                              |
| B   | UPC-A vs GTIN-14 canonique                                   | `091021037090` / `00091021037090`                               | équivalents                                                                                                         |
| C   | EAN-13 sans relation UPC-A                                   | `4006381333931`                                                 | GTIN-14 `04006381333931` ; **jamais tronqué**                                                                       |
| D   | zéro significatif                                            | `0091021037090` ≠ `91021037090`                                 | zéros conservés ; une forme à 11 chiffres est invalide                                                              |
| E   | check digit invalide                                         | `091021037091`                                                  | rejet, aucune clé canonique                                                                                         |
| F   | deux GTIN réellement différents                              | `091021037090` / `4006381333931`                                | contradictoires (T2 `rejected`, T3 contradicted)                                                                    |
| G   | Thule Android                                                | valeurs observées ANDROID-1                                     | clé `00091021037090`                                                                                                |
| H   | Thule iOS                                                    | valeurs observées IOS-1                                         | clé `00091021037090`                                                                                                |
| I   | candidate generation                                         | produit `0091021037090`, scope `091021037090`                   | hit S2 de rang 4, hit S1 et signal T1 `exact_gtin`                                                                  |
| J   | v1 legacy                                                    | idem, scope GTIN seul                                           | match GTIN, **pas de conflit** ; décision soumise à F-4 (rétrogradée en `needs_review`, aucune alerte)              |
| K   | v2 targeted                                                  | critère `gtin` `equals` / `one_of` / `prefix` en forme 12 ou 13 | `equals` et `one_of` satisfaits ; `prefix` à définir explicitement, sur la base canonique ou interdit pour les GTIN |
| L   | F-4 final gate                                               | règle avec critère `gtin` satisfait par équivalence             | toujours **inéligible** ; aucune alerte ni ligne d'éligibilité                                                      |
| M   | historique stocké en 12 chiffres                             | ligne existante `091021037090`                                  | clé calculée sans réécrire `gtin` ; aucun réarmement inutile                                                        |
| N   | historique stocké en 13 chiffres                             | ligne existante `0091021037090`                                 | même clé que M ; matching identique                                                                                 |
| O   | expansion UPC-E                                              | `upc_e` `04252614`                                              | `042100005264` / `00042100005264` ; un `manual` à 8 chiffres reste GTIN-8                                           |
| P   | lot, date, juridiction et `coverageComplete` restent imposés | GTIN équivalent mais lot hors plage ou juridiction différente   | aucun `confirmed` ni alerte : la règle §8.3 tient                                                                   |

---

## 10. État de sortie de la passe

- Production : **aucun changement**.
- Implémentation, matching et F-4 : **aucun changement**.
- Arbre de travail : le diagnostic `PHASE-17.3-S-DIAG` est **retiré**. `git status` ne montre
  plus que les deux documents d'audit non suivis (`phase-17-3-product-identity-design.md` et ce
  document).
- Prochaine étape : ouvrir l'implémentation 17.3-S (§11.3). Une vraie capture ANDROID-1 et un
  test UPCE-1 restent utiles comme cas G et O, mais ne bloquent pas.

---

## 11. Résultats et décision

### 11.1 ANDROID-1 — aucune donnée exploitable reçue

Les « trois sorties `[17.3-S]` » transmises sont en fait trois lignes du **code source** du
diagnostic, numérotées comme dans une sortie `grep`, et non trois sorties de log :

```
151:    // PHASE-17.3-S-DIAG (temporary, local only, never commit): raw scan vs Recall parsing.
156:      console.log('[17.3-S]', JSON.stringify({
165:    // END PHASE-17.3-S-DIAG
```

Une sortie réelle aurait la forme
`[17.3-S] {"os":"android","osVersion":…,"eventType":…,"eventData":…,…}` et apparaîtrait dans le
terminal Metro ou dans `adb logcat`. Par conséquent :

- comportement Android observé : **non documenté** ;
- `event.type`, `event.data`, `event.raw`, longueurs, valeur retenue, validation : **inconnus** ;
- stabilité des 3 scans : **non évaluable**.

Aucune valeur n'est inventée ici. La prédiction du §5 reste une prédiction.

### 11.2 Défaut d'équivalence établi sans appareil

Preuve locale en lecture seule. Le script jetable, hors dépôt, importe le code Recall actuel et
le fait tourner sur un rappel au scope `gtin = 091021037090` :

| GTIN du produit (saisie manuelle) | Formulaire (`validateProductForm`) | T1 `retrieveRecallCandidates` | T2 v1 `evaluateRecallScope`                                             | T3 v2 `evaluateCriterionV2` (`equals`) |
| --------------------------------- | ---------------------------------- | ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| `091021037090` (UPC-A)            | accepté, stocké tel quel           | `exact_gtin`                  | `confirmed` 1,0                                                         | `matched`                              |
| `0091021037090` (EAN-13 équiv.)   | **accepté, stocké tel quel**       | **pas de `exact_gtin`**       | **`rejected` 0,98**, `conflicting.gtin = 0091021037090 != 091021037090` | **`conflicting`**                      |
| `00091021037090` (GTIN-14 canon.) | **accepté, stocké tel quel**       | **pas de `exact_gtin`**       | **`rejected` 0,98**                                                     | **`conflicting`**                      |

Une représentation GS1 équivalente du **même** GTIN est donc aujourd'hui traitée comme une
**contradiction explicite**. Le résultat est un faux négatif présenté avec une confiance de 0,98.
Les sites SQL S1 et S2 ont la même égalité stricte, établie par lecture (§2).

D1 a été rejoué sur le code actuel : `toScannedBarcode('upc_e', '04252614')` donne
`invalid_or_unsupported` et `gtin = null`. La forme correcte est UPC-A `042100005264`, GTIN-14
`00042100005264`.

### 11.3 Décision

**OUI : l'implémentation 17.3-S est justifiée sans test iOS.**

- Le défaut d'équivalence est démontré par le code actuel et une exécution locale. Il ne dépend
  pas d'iOS : la saisie manuelle et l'édition suffisent à le déclencher, et un ITF-14 à
  indicateur `0` le déclencherait de la même façon.
- D1 est confirmé indépendamment.
- Le design du §8 (raw + symbology + `canonical_gtin14`) corrige le défaut quel que soit le
  comportement réel d'iOS. Si iOS livrait 13 chiffres, la clé canonique serait la même.
- La règle de sûreté du §8.3 reste obligatoire. L'équivalence élargit la récupération et la
  non-contradiction, jamais la confirmation ; elle ne contourne ni lot, date, modèle,
  juridiction, `coverageComplete` ni F-4.
- D2 reste **UNCONFIRMED — NO PHYSICAL IOS DEVICE AVAILABLE**. Il ne doit pas être cité comme
  motif de la correction.
- Les cas G et H (Thule Android/iOS) restent ouverts comme tests d'acceptation physiques. Ils
  pourront être exécutés plus tard, sans bloquer l'implémentation.
