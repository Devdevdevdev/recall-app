# Phase 17.3 — Product identity / GTIN lookup — audit et design

Statut : **AUDIT + DESIGN uniquement**. Aucune implémentation, aucune migration, aucune Edge
Function, aucun secret, aucun package, aucune modification UI, aucune action production.

Base auditée : `main` @ `07821592c280648be1a056b0dd27634894c5d8c4` (« Close Phase 17.7 after
production verification »), identique à `origin/main`, 0 ahead / 0 behind, arbre propre.

Règle absolue reprise telle quelle : **Recall n'invente jamais un nom, une marque ou une identité
produit, et n'utilise aucune IA pour l'identification.** Si aucune source fiable ne connaît le
GTIN, le produit est « non identifié » et l'utilisateur saisit ou confirme lui-même.

---

## 1. Parcours de scan actuel (HEAD)

### 1.1 Fichiers

| Rôle                             | Fichier                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route onglet Scan                | `app/(tabs)/scan.tsx` → `src/features/scan/ScanScreen.tsx`                                                                                                                |
| Domaine code-barres (pur)        | `src/domain/barcode.ts` (`productBarcodeFormats`, `validateGtin`, `toScannedBarcode`)                                                                                     |
| Parsing OCR étiquette (pur)      | `src/domain/productLabel.ts` (`parseProductLabel`)                                                                                                                        |
| OCR on-device                    | `src/services/ocr/*` (`recognizeTextFromImage`, `deleteTemporaryImage`)                                                                                                   |
| Route création                   | `app/products/new.tsx` → `NewProductScreen` dans `src/features/products/ProductScreens.tsx`                                                                               |
| Revalidation paramètres de route | `src/features/products/productFormUtils.ts` (`productCreationPrefillFromParams`, `validateProductForm`)                                                                   |
| Formulaire                       | `src/features/products/ProductForm.tsx`                                                                                                                                   |
| Persistance                      | `src/data/SupabaseOwnedProductsRepository.ts`, `src/data/ownedProductsMappers.ts`                                                                                         |
| Déclenchement check produit      | `requestCheckInBackground` (`ProductScreens.tsx`) + trigger SQL `owned_products_arm_recall_check_insert` (`20261002120000_phase_17_7a_1_owned_product_recall_checks.sql`) |

Il n'existe **aucun hook** dédié au scan : tout l'état vit dans `ScanScreen` (`useState` /
`useRef`). Il n'existe **aucun service de lookup** produit, ni côté app ni côté Edge Functions.

### 1.2 Diagramme logique actuel

```text
Onglet Scan
 ├─ mode "barcode" (défaut)
 │   CameraView barcodeTypes = [ean13, ean8, upc_a, upc_e, itf14, code128]   (QR exclu)
 │   onBarcodeScanned(event)
 │     ├─ event.type ∉ productBarcodeFormats → ignoré
 │     ├─ verrou synchrone scanLocked + état "detected"
 │     └─ toScannedBarcode(format, raw = event.raw ?? event.data, norm = event.data)
 │          validateGtin(norm) : trim, /^\d+$/, longueur ∈ {8,12,13,14}, mod-10 GS1
 │          ├─ valide            → classification valid_gtin, gtin = valeur normalisée
 │          ├─ code128 propre    → non_gtin_product_code (jamais persisté)
 │          └─ sinon             → invalid_or_unsupported
 │   ConfirmationCard
 │     ├─ valid_gtin  : "Product barcode detected … Recall has not identified the product yet."
 │     │                [Use this barcode] → /products/new?gtin=…&source=barcode_scan
 │     ├─ code128     : [Read product label] → bascule mode label
 │     └─ invalide    : message + [Scan again]
 │
 ├─ mode "label" (OCR, natif uniquement)
 │   takePictureAsync → recognizeTextFromImage (on-device) → deleteTemporaryImage
 │   parseProductLabel → candidats lot/model/serial/… (étiquette explicite requise)
 │   [Continue] → /products/new?source=ocr_assisted&lotNumber=…  (referenceNumber jamais transmis)
 │
 └─ [Enter product manually] → /products/new

/products/new
 productCreationPrefillFromParams (revalide la route, non fiable)
   ├─ barcode_scan + GTIN valide → values.gtin, identificationMethod = barcode_scan
   ├─ ocr_assisted              → identifiants OCR, method = ocr_assisted si lot/model/serial
   └─ sinon                     → formulaire vide, method = null → 'manual'
 ProductForm : product_name OBLIGATOIRE ("Enter a product name."), brand facultatif
 validateProductForm → OwnedProductInput
 ownedProductsRepository.create
   insert owned_products { …champs, user_id, image_path: null,
                           identification_method, identification_confidence: null }
   → trigger AFTER INSERT arme private.owned_product_recall_checks (17.7)
 requestCheckInBackground(product.id)  (best effort, le serveur retente)
 → /products/:id
```

### 1.3 Où `product_name` / `brand` sont définis

Uniquement dans `ProductForm`, saisis par l'utilisateur. Aucun chemin (scan, OCR, serveur) ne les
remplit. `validateProductForm` exige `productName` non vide ; `brand` → `null` si vide.

### 1.4 Comportement quand seul le GTIN est connu

Le GTIN est prérempli, puis l'utilisateur **doit** taper un nom pour enregistrer. Le texte de
l'écran est honnête (« Recall has not identified the product yet », « Add a product name »). Il n'y
a donc ni identité inventée ni identité trouvée : c'est le manque que 17.3 doit combler.

### 1.5 Barcode vs QR vs OCR

- **Barcode** : décrit ci-dessus. Aucune photo prise.
- **QR** : **non scanné du tout** — `qr` n'est pas dans `productBarcodeFormats`, donc ni détecté ni
  parsé. Comportement délibéré documenté dans `docs/barcode-scanning.md`.
- **OCR** : n'extrait que des identifiants étiquetés (modèle, série, lot…). Il n'extrait **jamais**
  nom ou marque. Il ne cherche pas de GTIN dans le texte.

---

## 2. Formats de codes supportés

Vérifié dans `node_modules/expo-camera` 57.0.5 (`ios/Current/BarcodeRecord.swift`,
`build/Camera.types.d.ts`). `raw` n'est renseigné que sur Android (`@platform android`).

| Format                                        | Activé  | Valeur retournée par Expo Camera                                                                                                                                         | Transformation actuelle            | Validation actuelle                                                | Stockage actuel                                                                             |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| EAN-13                                        | oui     | 13 chiffres                                                                                                                                                              | trim                               | mod-10, longueur 13                                                | `gtin` 13 chiffres                                                                          |
| EAN-8                                         | oui     | 8 chiffres                                                                                                                                                               | trim                               | mod-10, longueur 8                                                 | `gtin` 8 chiffres                                                                           |
| UPC-A                                         | oui     | **Android** : `upc_a`, 12 chiffres. **iOS** : AVFoundation n'a pas de type UPC-A ; Expo mappe `upc_a` → `ean13` et la valeur arrive en **13 chiffres avec un 0 initial** | trim                               | mod-10 (longueur 12 ou 13)                                         | `gtin` 12 chiffres (Android) **ou 13 chiffres (iOS)** pour le même produit                  |
| UPC-E                                         | oui     | 8 chiffres (forme compressée, à confirmer sur appareil pour chaque plateforme)                                                                                           | trim                               | mod-10 **traité comme GTIN-8** — incorrect                         | voir défaut D1                                                                              |
| ITF-14                                        | oui     | 14 chiffres                                                                                                                                                              | trim                               | mod-10, longueur 14                                                | `gtin` 14 chiffres                                                                          |
| Code 128                                      | oui     | texte                                                                                                                                                                    | trim, rejet caractères de contrôle | GTIN si 8/12/13/14 chiffres valides, sinon `non_gtin_product_code` | jamais persisté s'il n'est pas un GTIN ; GS1-128 (séparateur FNC1 = U+001D) classé invalide |
| QR                                            | **non** | —                                                                                                                                                                        | —                                  | —                                                                  | —                                                                                           |
| DataMatrix, PDF417, Aztec, Code39/93, Codabar | non     | —                                                                                                                                                                        | —                                  | —                                                                  | —                                                                                           |

### Défauts constatés (factuels, non corrigés dans cette passe)

**D1 — UPC-E réels rejetés.** Le chiffre de contrôle d'un UPC-E est celui du UPC-A expansé, pas un
mod-10 calculé sur les 7 premiers chiffres. Vérifié : `04252614` est un UPC-E valide (expansion
`042100005264`, check digit valide) mais `validateGtin('04252614')` → invalide. Un UPC-E réel est
donc classé `invalid_or_unsupported` (~90 % des cas), ou, par coïncidence (~10 %), accepté comme un
faux GTIN-8 — qui désigne alors un **autre** article (espace EAN-8).

**D2 — Même produit, deux GTIN différents selon la plateforme (sécurité recall).** Sur iOS, un
UPC-A est stocké en 13 chiffres (`0` + UPC). Les scopes CPSC stockent les UPC tels que publiés
(12 chiffres, `_shared/cpsc/mapper.ts`). Or tout le matching compare des **chaînes de chiffres
exactes** :

- SQL : `regexp_replace(owned_product.gtin,'[^0-9]','','g') = regexp_replace(scope.gtin,…)`
  (`20261002120000_…_owned_product_recall_checks.sql` l. 232-255, index
  `owned_products_normalized_gtin_idx` / `recall_scopes_normalized_gtin_idx`) ;
- TS : `normalizeGtin` (`_shared/matching/normalization.ts`) ne fait que trim + `^\d+$` ;
  `evidence.ts` l. 153-180 : deux GTIN valides **différents** ⇒ identifiant **en conflit** ⇒
  décision `rejected` (confiance 0,98).

Cas réel : Thule 8877, GTIN `091021037090`. Scanné sur iOS ⇒ `0091021037090`. Résultat attendu
aujourd'hui : aucune récupération par GTIN, et si le scope est récupéré par nom/marque, le GTIN est
vu comme **contradictoire** ⇒ `rejected`. C'est un faux négatif silencieux. Les trois écritures
`091021037090`, `0091021037090`, `00091021037090` sont toutes valides et désignent le même
article. Ce défaut est **antérieur** à 17.3 et touche le chemin 17.7/F-4 ; il doit faire l'objet
d'une tranche de correction dédiée et revue (voir §22, tranche 17.3-S). Le comportement iOS
découle du code source Expo et du comportement documenté d'AVFoundation ; il reste à confirmer sur
un iPhone physique avant correction.

---

## 3. Stratégie QR

Aujourd'hui : QR non activé. Proposition : l'activer **uniquement** derrière un parseur local pur,
sans réseau.

```text
QR data (texte non fiable)
 ├─ longueur > 2048 ou caractères de contrôle            → rejet "unsupported"
 ├─ A. que des chiffres, longueur 8/12/13/14, mod-10 OK  → GTIN (source_format = qr_gtin)
 ├─ C. URI http(s) dont le chemin contient un segment
 │     primaire GS1 Digital Link : …/01/{gtin}[/22/…][/10/{lot}][/21/{serial}]
 │     (ou alias court /gtin/{gtin})                       → GTIN validé (source_format = qr_digital_link)
 │        - gtin : 8/12/13/14 chiffres, mod-10 obligatoire, canonicalisé en GTIN-14
 │        - lot (AI 10) / série (AI 21) : proposés à l'utilisateur, jamais auto-persistés
 │        - query string, fragment, domaine : ignorés et NON persistés
 │        - Digital Link compressé : non supporté → traité comme B
 ├─ B. autre URL                                          → "Ce QR ne contient pas d'identifiant produit"
 ├─ D. texte arbitraire                                   → idem
 └─ E. autre (vCard, Wi-Fi, …)                            → idem
```

Règles :

- **Aucun fetch**, ni côté app ni côté backend, d'une URL issue d'un QR (SSRF, tracking,
  phishing). Le domaine n'est jamais résolu, jamais suivi, jamais transmis au lookup.
- Le lookup reçoit **uniquement** le GTIN extrait, comme pour un code-barres.
- Le QR brut n'est **pas stocké** (peut contenir des jetons de suivi ou des données personnelles).
  Seuls le GTIN canonique et `source_format` sont conservés.
- Le domaine du Digital Link ne donne **aucune** confiance supplémentaire : n'importe qui peut
  écrire `https://exemple.test/01/<gtin>`. Un GTIN issu d'un QR a la même valeur qu'un GTIN de
  code-barres (lu sur l'emballage, confirmé par l'utilisateur).
- Un QR sans GTIN n'affiche jamais « Produit détecté ».

---

## 4. Normalisation GTIN

### 4.1 Existant

Deux primitives équivalentes mais dupliquées : `src/domain/barcode.ts::validateGtin` (app) et
`_shared/matching/normalization.ts::normalizeGtin/isValidGtin` (Edge, plus
`_shared/cpsc/validation.ts::validateGtin`). Bonnes propriétés : jamais de conversion en `Number`,
zéros initiaux préservés, mod-10 correct pour 8/12/13/14. Manques : pas de forme canonique, pas
d'expansion UPC-E, pas de notion de symbologie.

### 4.2 Primitive cible (pure, partagée app + Edge)

```ts
type GtinParse =
  | { ok: true; raw: string; symbology: Symbology; gtin: string /* forme GS1 sans zéros superflus ajoutés */;
      gtin14: string /* canonique */ }
  | { ok: false; raw: string; reason: 'not_digits' | 'bad_length' | 'bad_check_digit' | 'unsupported' };

parseGtin(raw, symbology?: 'ean13'|'ean8'|'upc_a'|'upc_e'|'itf14'|'code128'|'qr'|'manual')
```

Règles :

1. chiffres uniquement après trim ; jamais `Number()` ;
2. `upc_e` (symbologie connue) : expansion vers UPC-A 12 chiffres selon les règles GS1 (dernier
   chiffre 0-9), puis contrôle mod-10 sur l'UPC-A ; un 8 chiffres **saisi à la main** reste un
   GTIN-8 (ambiguïté EAN-8/UPC-E non devinée) ;
3. longueur ∈ {8,12,13,14}, mod-10 ;
4. `gtin14 = lpad(gtin, 14, '0')` — représentation canonique GS1 pour les bases ; le chiffre de
   contrôle est invariant au padding (vérifié sur `091021037090` / `0091021037090` /
   `00091021037090`) ;
5. un GTIN-14 dont l'indicateur (1er chiffre) est 1-8 désigne un **emballage/carton**, pas l'unité
   consommateur : il reste tel quel, on ne retire jamais l'indicateur pour « retrouver » l'unité
   (autre article, autre check digit) ;
6. GTIN « restreints » (préfixes 02, 04, 2x : poids variable / usage interne magasin) : valides
   syntaxiquement mais non identifiants globaux → pas de lookup externe, identification manuelle.

### 4.3 `raw_code` vs `canonical_gtin`

Distinction souhaitable et possible :

- `raw` : valeur telle que lue (ex. UPC-E `04252614`, iOS `0091021037090`) ;
- `gtin` (existant) : valeur validée telle que confirmée par l'utilisateur — **inchangée**
  pour compatibilité avec le matching actuel tant que 17.3-S n'est pas livrée ;
- `gtin14` : canonique, utilisé pour cache, lookup et — après 17.3-S — matching.

Le modèle actuel **ne suffit pas** : une seule colonne `gtin`, sans symbologie ni valeur brute.

---

## 5. Modèle `owned_products` réel à HEAD

Reconstitué depuis les migrations (`phase_2_foundation`, `phase_13`, `phase_14`, `phase_16`) :

| Colonne                                       | Type                               | Notes                                                                    |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `id`, `user_id`                               | uuid                               | RLS owner-only ; `user_id` protégé                                       |
| `brand`, `product_name`, `category`           | text                               | nullables en DB ; nom requis par le formulaire                           |
| `gtin`                                        | text                               | aucune contrainte DB de format ; index brut + index normalisé (chiffres) |
| `model_number`, `serial_number`, `lot_number` | text                               | index normalisés                                                         |
| `purchase_date`                               | date                               |                                                                          |
| `purchase_country_code`                       | text FK `country_codes`            |                                                                          |
| `scan_date`                                   | date not null default current_date |                                                                          |
| `safety_attributes`                           | jsonb not null default `{}`        | validateur whitelisté                                                    |
| `image_path`                                  | text                               | toujours `null` aujourd'hui                                              |
| `identification_method`                       | text                               | `manual` / `barcode_scan` / `ocr_assisted` ; pas de CHECK                |
| `identification_confidence`                   | numeric(5,4) 0..1                  | toujours `null` aujourd'hui                                              |
| `created_at`, `updated_at`                    | timestamptz                        | `created_at` immuable                                                    |

Trigger d'armement 17.7 : `AFTER UPDATE OF brand, product_name, gtin, model_number,
serial_number, lot_number, safety_attributes, purchase_country_code`. Toute nouvelle colonne de
provenance **ne réarme pas** le check (souhaité).

### Capacité pour l'identité

| Besoin                                              | Disponible ?                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| nom, marque, catégorie confirmés                    | oui (`product_name`, `brand`, `category`)                                                                         |
| méthode d'acquisition du code                       | partiel (`identification_method`, sans valeur QR)                                                                 |
| source de l'identification                          | **non**                                                                                                           |
| nom / marque proposés par la source (avant édition) | **non**                                                                                                           |
| image catalogue                                     | **non** (`image_path` = photo utilisateur, à garder séparée)                                                      |
| timestamp lookup                                    | **non**                                                                                                           |
| niveau de confiance factuel                         | **non** — `identification_confidence` est un pourcentage 0..1, exactement ce qu'on veut éviter ; à laisser `null` |
| raw barcode / symbologie                            | **non**                                                                                                           |
| GTIN canonique                                      | **non**                                                                                                           |

Conclusion : **migration nécessaire** (tranche 17.3b), aucune créée maintenant.

---

## 6. Sources de lookup

Vérifié le 2026-10-04 (documentation publique + 3 requêtes GET publiques sans clé sur le seul
GTIN Thule `091021037090`, déjà public dans l'avis CPSC 8877) :

| Requête                | Résultat                                                            |
| ---------------------- | ------------------------------------------------------------------- |
| Open Food Facts v2     | 404 `product not found` (code renvoyé canonicalisé `0091021037090`) |
| Open Products Facts v2 | 404 `product not found`                                             |
| UPCitemdb trial        | 200, `total: 0`                                                     |

### Comparatif

| Critère                                         | A. Open Food Facts (+ Open Beauty / Pet Food / Products Facts)                                                                                 | B. Commercial « général » (Go-UPC, Barcode Lookup, UPCitemdb…)                                                                                  | C. GS1 (Verified by GS1, Digital Link)                                                            | D. Cache Recall         | E. Manuel       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- | --------------- |
| Alimentaire                                     | très bon (EU/FR excellent, US/CA correct)                                                                                                      | bon                                                                                                                                             | registre propriétaire de marque                                                                   | ce qui a déjà été vu    | toujours        |
| Électroménager / électronique / jouets / maison | **faible** (Open Products Facts expérimental)                                                                                                  | revendiqué large (Go-UPC « 500M+ produits », toutes industries) — **à mesurer**                                                                 | dépend de la saisie par la marque                                                                 | idem                    | toujours        |
| US / EU / CA                                    | EU fort, US/CA moyen                                                                                                                           | US fort, international variable selon fournisseur                                                                                               | mondial (les marques déclarent leurs GTIN)                                                        | —                       | —               |
| Accès                                           | REST public, lecture sans auth, User-Agent `App/Version (contact)` obligatoire                                                                 | REST + clé API                                                                                                                                  | API sur clé après accord GS1 (MO ou programme partenaire) ; conditions à négocier                 | DB interne              | —               |
| Quotas                                          | **15 req/min/IP** en lecture produit (doc OFF actuelle). Depuis une Edge Function, l'IP sortante est partagée par tous les utilisateurs Recall | UPCitemdb free : 100/jour, 6/min ; Barcode Lookup : 5k/mois $99 → 500k $949, 100 req/min ; Go-UPC : 5k/mois $74,95 → 450k $795                  | non publiés                                                                                       | aucun                   | —               |
| Coût                                            | gratuit                                                                                                                                        | payant au volume                                                                                                                                | non publié                                                                                        | stockage                | —               |
| Licence                                         | données ODbL (attribution + share-alike sur base dérivée publique), images CC BY-SA                                                            | propriétaire ; conditions de **mise en cache / stockage non publiées** sur les pages consultées → à vérifier contractuellement avant tout cache | contrat GS1                                                                                       | dépend de chaque source | utilisateur     |
| Champs                                          | `product_name`, `brands`, `categories_tags`, images, quantité                                                                                  | titre, marque, catégorie, images, description                                                                                                   | GTIN, marque, description produit, URL image, catégorie GPC, contenu net, pays de vente, licencié | ce qu'on garde          | nom, marque     |
| Qualité nom/marque                              | communautaire, bonne en alimentaire, hétérogène ailleurs                                                                                       | agrégée (retail/scraping), titres parfois marketing, marque parfois absente                                                                     | la plus fiable (déclarée par le propriétaire de la marque)                                        | = source                | = utilisateur   |
| Images                                          | oui, CC BY-SA                                                                                                                                  | oui, licence floue                                                                                                                              | URL image fournie par la marque                                                                   | —                       | photo existante |
| Stabilité / dépendance                          | projet associatif stable ; quota bas                                                                                                           | fournisseur unique, prix évolutifs, risque de disparition                                                                                       | institutionnel, accès contractuel                                                                 | sous contrôle           | —               |

Constats :

- **Aucune source unique ne couvre « nourriture + électroménager + jouets + électronique + maison »
  avec une licence claire.** Une stratégie multi-sources est nécessaire.
- Open Food Facts seul échouerait sur le cœur de cible CPSC / Health Canada (puériculture,
  électroménager, jouets) — le cas Thule le montre.
- Un fournisseur commercial ne doit pas être choisi sur ses revendications : sélection par un
  **benchmark de couverture** sur un échantillon réel (GTIN des scopes CPSC/Health Canada déjà en
  base, qui sont publics), en mesurant taux de réponse, exactitude marque, et conditions de cache.
- GS1 est la seule source pouvant justifier un niveau `verified` ; c'est d'abord un sujet
  contractuel (opérateur), pas technique.
- **GEPIR / préfixe entreprise GS1** pourrait donner le **licencié** du préfixe (« Thule Group ») ;
  c'est un indice de marque, pas un nom de produit — à garder comme signal secondaire éventuel.

### Stratégie recommandée

1. **Cache Recall** (toujours en premier).
2. **Open Food Facts famille** (gratuit, sans secret) — pertinent pour l'alimentaire, le
   cosmétique et l'animalerie ; soumis au quota par IP, donc toujours derrière le cache, et 429 =
   source indisponible.
3. **Un fournisseur général commercial**, choisi après benchmark (tranche 17.3c), pour le
   non-alimentaire.
4. **Verified by GS1** si un accord est obtenu (niveau `verified`), sinon absent.
5. **Manuel** sinon.

Pour une V1 sans secret, OFF seul est livrable techniquement, mais n'apportera presque rien sur la
cible recall non alimentaire : il faut le dire honnêtement plutôt que de livrer une fausse
impression de couverture.

---

## 7. Resolver déterministe

```text
resolve(gtin14):
  0. parseGtin → invalide ou GTIN restreint ⇒ { status: 'not_eligible' } (pas d'appel)
  1. cache (fresh)                   ⇒ résultat immédiat (y compris négatif non expiré)
  2. sources de niveau 1 en PARALLÈLE, chacune avec timeout propre :
       OFF-famille (≤ 2 000 ms), fournisseur général P (≤ 2 500 ms)
  3. si aucune réponse positive et GS1 disponible : GS1 (≤ 2 000 ms)   [ou en parallèle si accord]
  4. combinaison selon §8 (jamais de fusion de champs entre sources)
  5. écriture cache par source (positif / négatif ; erreurs non cachées)
  6. budget total serveur dur : 4 000 ms → on renvoie ce qu'on a, sources manquantes = 'unavailable'
```

Propriétés :

- borné (nombre fixe d'appels, au plus 1 par source et par GTIN) ;
- chaque source peut être `found | not_found | unavailable(timeout|5xx|429|quota|parse_error)` ;
- une source indisponible n'empêche jamais une réponse ;
- ordre de priorité **fixe et documenté**, sans pondération opaque ;
- coalescence des requêtes concurrentes sur le même GTIN (une seule requête externe en vol) ;
- disjoncteur par source (ex. 5 échecs consécutifs ⇒ source ignorée 5 min) ;
- aucune IA, aucun appel à `_shared/nebius` (vérifié par test d'import).

---

## 8. Conflits entre sources

Comparaison sur des valeurs **normalisées** (NFKC, casse, ponctuation, espaces ; pour la marque,
suffixes légaux usuels `inc`, `llc`, `ltd`, `gmbh`, `sa`, `ab`, `co` retirés) — normalisation
déterministe, testée, réutilisant l'esprit de `_shared/matching/normalization.ts`.

| Classe              | Règle                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exact_agreement`   | ≥ 2 sources trouvées, marques normalisées égales **et** noms égaux ou ensembles de jetons égaux                                                                           |
| `partial_agreement` | marques égales mais noms différents (variante, contenance) ; ou une seule source a une marque et l'autre n'en a pas mais les noms sont compatibles (Jaccard jetons ≥ 0,5) |
| `conflict`          | marques présentes des deux côtés et différentes ; ou noms incompatibles (Jaccard < 0,2)                                                                                   |
| `single_source`     | une seule source trouvée                                                                                                                                                  |
| `unknown`           | aucune source trouvée                                                                                                                                                     |

Politique :

- **jamais** marque de A + nom de B : on présente **un enregistrement complet d'une seule source**
  (la plus prioritaire : GS1 > fournisseur général > OFF pour le non-alimentaire ; GS1 > OFF >
  fournisseur général si la catégorie OFF est alimentaire) ;
- `conflict` ⇒ écran « Les sources ne concordent pas », choix explicite parmi les propositions ou
  saisie manuelle, aucun pré-choix silencieux ; niveau plafonné (§10) ;
- les seuils sont des constantes nommées, testées, sans IA ;
- le conflit est conservé dans la provenance.

---

## 9. Provenance

Structure conceptuelle d'un résultat de lookup :

```text
lookup_result {
  canonical_gtin    : "00091021037090"
  raw_gtin          : "0091021037090"          # tel que scanné
  symbology         : "ean13" | "upc_e" | "qr_digital_link" | "manual" | …
  status            : found | partial | conflict | not_found | unavailable | not_eligible
  candidates[] {
    source            : "open_food_facts" | "<provider>" | "gs1" | "recall_cache"
    source_product_id : string | null
    looked_up_at      : timestamptz
    product_name      : string | null
    brand             : string | null
    category          : string | null            # libellé source, non normalisé
    image_url         : string | null            # non utilisé en V1
  }
  agreement         : exact_agreement | partial_agreement | conflict | single_source | unknown
  level             : §10
}
```

À conserver **durablement** :

- dans le **cache non personnel** : par `(canonical_gtin, source)` le candidat complet + statut +
  `fetched_at` + `expires_at` ;
- dans **`owned_products`** (privé propriétaire) : ce qui explique la valeur affichée —
  `identity_level`, `identity_source`, `identity_source_product_id`, `identity_looked_up_at`,
  `identity_user_edited` (bool), un **instantané** de la proposition (nom/marque proposés) pour
  pouvoir dire « modifié par vous » sans dépendre d'une ligne de cache expirée, plus
  `barcode_symbology`, `barcode_raw` (codes linéaires uniquement, jamais un QR brut) et
  `gtin14`.
- Forme recommandée : colonnes simples pour `gtin14` (générée, indexable) et `identity_level` ;
  le reste dans un `identity_provenance jsonb` **validé par fonction whitelist**, sur le modèle de
  `safety_attributes` (précédent existant, migration atomique, pas de réarmement du check).

À **ne pas** conserver : la réponse brute du fournisseur dans `owned_products`, l'URL d'un QR, les
en-têtes HTTP, quoi que ce soit lié à l'utilisateur dans le cache.

---

## 10. Niveaux de confiance

Pas de pourcentage. Niveaux textuels déterminés par des faits :

| Niveau          | Condition factuelle                                                                                    | Libellé UI                                        |
| --------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `verified`      | enregistrement GS1 (déclaré par le propriétaire de la marque) pour ce GTIN, confirmé par l'utilisateur | « Identifié (registre GS1) »                      |
| `corroborated`  | `exact_agreement` entre ≥ 2 sources indépendantes, confirmé par l'utilisateur                          | « Identifié (2 sources concordantes) »            |
| `single_source` | une source catalogue, ou `partial_agreement`, confirmé par l'utilisateur                               | « Identifié via <source> »                        |
| `user_selected` | `conflict`, l'utilisateur a choisi une proposition                                                     | « Choisi par vous parmi des sources divergentes » |
| `user_provided` | saisi ou modifié par l'utilisateur (nom ou marque différents de la proposition)                        | « Saisi par vous »                                |
| `unidentified`  | GTIN enregistré, aucune identité                                                                       | « Produit non identifié »                         |

Préconditions communes : GTIN syntaxiquement valide (mod-10). Un GTIN invalide n'atteint jamais
le lookup. Toute identité automatique exige une **confirmation utilisateur** avant persistance ; il
n'existe donc pas de niveau « automatique non confirmé » en base.
`identification_confidence` (numeric) reste `null` ; à terme, à documenter comme obsolète.

---

## 11. UX cible

États de l'écran après un scan GTIN valide :

```text
[Recherche du produit…]              ← spinner, ≤ 5 s ; bouton "Saisir manuellement" visible dès 1,5 s

CAS A — identifié clairement (single_source / corroborated / verified)
  Produit identifié
  <Nom du produit>
  Marque : <Marque>
  GTIN : 0091021037090      Source : <source> [· 2 sources concordantes]
  [Confirmer]  [Modifier]
  → formulaire prérempli (date d'achat, pays…) → Enregistrer
  → « Recall surveille maintenant ce produit. »

CAS B — partiel (marque manquante, ou partial_agreement)
  Produit probablement identifié
  <Nom>
  Marque : non indiquée par la source
  GTIN : …  Source : …
  [Confirmer]  [Modifier]

CAS B' — conflit
  Les sources ne concordent pas pour ce code
  ( ) <Nom A> — <Marque A>   (source A)
  ( ) <Nom B> — <Marque B>   (source B)
  [Utiliser la sélection]  [Saisir moi-même]

CAS C — aucune identification (unknown / unavailable / not_eligible)
  Produit non identifié
  Nous avons bien enregistré le code :
  GTIN 0091021037090
  Ajoutez :
   - nom du produit
   - marque (facultatif)
  [Continuer]
```

Règles de texte : jamais « Produit identifié » si `status ≠ found` ; « Source : » toujours visible
quand un nom est proposé ; jamais de nom ou marque préremplis en cas C ; erreurs réseau formulées
comme « identification indisponible pour le moment », pas « produit inconnu ».

`[Modifier]` ⇒ niveau `user_provided`, instantané de la proposition conservé.

---

## 12. Image produit

Recommandation V1 : **pas d'image catalogue**.

- non nécessaire au lookup, jamais une preuve d'identité ;
- OFF : CC BY-SA (attribution obligatoire, share-alike) ; commerciaux : licence d'affichage à
  vérifier ; GS1 : selon contrat ;
- si ajoutée plus tard : colonne/clé distincte `catalog_image_url` + attribution, **jamais** dans
  `image_path` (réservé à une photo utilisateur) ; placeholder en cas d'URL morte (pas d'erreur
  bloquante) ; pas de hotlink si la licence l'interdit (copie dans Storage seulement si autorisée).

---

## 13. Architecture

| Critère                   | A. Appel direct app                              | B. Edge Function                       | C. Edge Function + cache DB            |
| ------------------------- | ------------------------------------------------ | -------------------------------------- | -------------------------------------- |
| Clés API                  | **exposées** dans le bundle (`EXPO_PUBLIC_*`)    | secrets Supabase                       | secrets Supabase                       |
| Quotas                    | par appareil (OFF OK) mais clé payante abusable  | centralisés, mais chaque scan consomme | **centralisés + amortis**              |
| Cache                     | local par appareil seulement                     | non                                    | partagé non personnel                  |
| Observabilité             | nulle                                            | logs Edge                              | logs + taux de hit + statut par source |
| Changement de fournisseur | release app                                      | déploiement serveur                    | déploiement serveur                    |
| Confidentialité           | IP + appareil de l'utilisateur vers chaque tiers | seule l'IP Supabase sort               | idem                                   |
| Latence                   | 1 saut                                           | 2 sauts (+ cold start)                 | cache hit rapide                       |
| Résilience                | faible                                           | disjoncteur central                    | disjoncteur + cache                    |
| Kill switch               | release                                          | flag serveur                           | flag serveur                           |

**Recommandation : C**, cohérente avec l'existant :

- Edge Function `identify-product` (nom indicatif), `verify_jwt`, utilisateur `authenticated`
  requis (même schéma que `check-owned-product` / `_shared/productCheck/server.ts`) ;
- entrée : `{ gtin }` seulement ; revalidation serveur ; sortie : `lookup_result` (§9) ;
- **lecture seule vis-à-vis de `owned_products`** : la fonction n'écrit jamais un produit
  utilisateur ; seule l'app, après confirmation, écrit via RLS ;
- kill switch serveur par défaut **désactivé**, sur le modèle de
  `private.recall_automation_control.product_check_enabled` ; désactivé ⇒ cas C côté app ;
- modules partagés sous `supabase/functions/_shared/productIdentity/` (adapters par source,
  resolver, normalisation) — aucune dépendance à `_shared/matching` ni `_shared/nebius`.

Limite : OFF limite par IP ; derrière une Edge Function, tous les utilisateurs partagent l'IP de
sortie ⇒ le cache est indispensable, et OFF ne peut pas être la source primaire à l'échelle.

---

## 14. Cache

Table distincte, non personnelle, schéma `private`, service-only (pas de policy `authenticated`) :

```text
private.product_identity_cache
  canonical_gtin     text   (14 chiffres, CHECK)
  source             text   (CHECK liste)
  status             text   ('found' | 'not_found')
  source_product_id  text null
  product_name       text null (≤ 200)
  brand              text null (≤ 120)
  category           text null (≤ 120)
  image_url          text null (non utilisé V1)
  fetched_at         timestamptz
  expires_at         timestamptz
  primary key (canonical_gtin, source)
```

- TTL : `found` 90 jours, `not_found` 14 jours, erreurs **non cachées** ; paramètres par source ;
  rafraîchissement paresseux à l'expiration, ou forcé par « Réessayer l'identification » (limité) ;
- par source, un indicateur « cache autorisé » : si les conditions d'un fournisseur interdisent le
  stockage, ses réponses ne sont pas persistées (ou seulement le temps autorisé) ;
- OFF : ODbL ⇒ attribution affichée (« Source : Open Food Facts ») ; les lignes OFF restent
  séparables (par `source`) pour respecter le share-alike si la base devenait publique ;
- **aucun** `user_id`, compteur par utilisateur ou historique dans cette table ;
- jamais jointe à `owned_products` par une vue exposée.

Anti-abus (la fonction pourrait servir de proxy gratuit vers une API payante) : limitation par
utilisateur (ex. 30 lookups / heure) dans une table de compteurs séparée à rétention courte
(fenêtre glissante, purge), distincte du cache.

---

## 15. Privacy

Ce qui quitte Recall vers un tiers : **le GTIN** (et l'IP de sortie Supabase, plus le User-Agent
applicatif exigé par OFF contenant le contact **opérateur**, jamais un e-mail utilisateur).

Ne quittent jamais Recall : `user_id`, e-mail, jeton, inventaire, autres produits, pays d'achat,
dates, lot/série/modèle, contenu OCR, photos, URL de QR. Le lot/série d'un Digital Link n'est
jamais envoyé au lookup.

Côté Recall : le cache n'est pas personnel. Seule la limitation de débit voit `user_id`, avec
rétention courte. Les logs Edge ne doivent pas contenir `user_id` + GTIN ensemble au-delà du
nécessaire opérationnel.

À documenter dans la politique de confidentialité : « le code-barres scanné peut être transmis à
<sources> pour identifier le produit ».

---

## 16. Latence

| Étape                          | Budget                                                  |
| ------------------------------ | ------------------------------------------------------- |
| Parsing + validation locale    | < 5 ms                                                  |
| Appel Edge + cache hit         | p95 < 600 ms (cold start inclus hors pic)               |
| Source externe                 | 2 000–2 500 ms par source, en parallèle                 |
| Budget serveur total           | 4 000 ms (dur)                                          |
| Timeout client                 | 5 000 ms (`AbortController`) ⇒ cas C avec « Réessayer » |
| Bouton « Saisir manuellement » | visible dès 1 500 ms de chargement                      |

L'enregistrement n'attend jamais le lookup au-delà du timeout client.

---

## 17. Offline / erreur API

- Réseau absent ou lookup en échec ⇒ cas C, message « identification indisponible », GTIN
  conservé dans le formulaire.
- L'utilisateur peut enregistrer avec son propre nom. **Décision à prendre en 17.3e** : autoriser
  l'enregistrement **sans nom** (`product_name` est nullable en DB mais requis par le formulaire).
  Recommandation : l'autoriser pour un produit scanné (GTIN valide), affiché « Produit non
  identifié · GTIN … », niveau `unidentified` — le GTIN suffit au matching recall exact.
- Fiche produit : action « Réessayer l'identification » si niveau `unidentified` ; le résultat est
  **proposé**, jamais écrit sans confirmation (une mise à jour de nom/marque réarme le check 17.7,
  ce qui est voulu).
- Hors connexion totale, l'insertion elle-même échoue aujourd'hui (pas de file locale) : hors
  périmètre 17.3, à noter.

---

## 18. Frontière recall-safety

- L'identité catalogue **n'est jamais une preuve de rappel**.
- `product_name` / `brand` confirmés alimentent, comme aujourd'hui, la **génération de candidats**
  (FTS nom, égalité marque, garde Jaccard) et l'empreinte v2. Avec `evidence.ts`, nom/marque seuls
  ne produisent au mieux que `needs_review` (≤ 0,65), jamais `confirmed`.
- La confirmation reste régie par 17.7 / F-4 (identifiants exacts, conditions de scope, safe gate).
- L'Edge Function d'identité n'écrit ni `owned_products`, ni `recall_matches`, ni `alerts`, et
  n'importe pas `_shared/matching`.
- Tests dédiés : un nom/marque catalogue identique à un scope rappelé, sans GTIN/identifiant
  concordant, ne produit **aucune** alerte confirmée.
- Le GTIN reste l'identifiant d'article ; sa comparaison doit devenir canonique (17.3-S), ce qui
  **ne contourne pas** F-4 : un GTIN égal sur un scope avec conditions (lot, date) reste soumis à
  ces conditions.

---

## 19. Scénario Thule

Faits : avis CPSC 8877 / 20-164, GTIN publié `091021037090` (valide), produit utilisé en E2E 17.7.

Aujourd'hui :

- Android : stocké `091021037090` → match exact avec le scope → OK (vérifié en 17.7) ;
- iOS : stocké `0091021037090` → **pas** de match GTIN, voire GTIN « contradictoire » (D2).

Lookup (2026-10-04) : OFF, Open Products Facts, UPCitemdb trial — **aucun** ne connaît ce GTIN.
Le comportement correct avec ces seules sources est donc **cas C « Produit non identifié »**, pas
« Thule ». Afficher « Marque : Thule / Produit : … » exige qu'une source (fournisseur commercial
retenu, ou GS1) renvoie effectivement ce GTIN — ce sera un critère explicite du benchmark 17.3c.
Rien n'est codé en dur ; le nom de l'avis CPSC ne doit **pas** servir à identifier le produit (ce
serait utiliser l'avis de rappel comme catalogue, et donc biaiser le matching).

---

## 20. Matrice de tests

| #   | Cas                                                                | Couche                              | Attendu                                                                                         |
| --- | ------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| A   | EAN-13 valide connu                                                | unit resolver (fixture source) + UI | cas A, `single_source`, source affichée                                                         |
| B   | UPC-A connu                                                        | unit parse + resolver               | Android `upc_a` 12 et iOS `ean13` 13 ⇒ **même** `gtin14`, même résultat                         |
| C   | GTIN-14 connu (indicateur 0 et 1-8)                                | unit                                | indicateur conservé, pas de « conversion » vers l'unité                                         |
| D   | GTIN valide inconnu                                                | resolver                            | `not_found` caché 14 j, cas C                                                                   |
| E   | Check digit invalide                                               | unit + UI                           | aucun appel réseau, message invalide                                                            |
| F   | QR = GTIN brut                                                     | unit parseur QR                     | GTIN extrait, `qr_gtin`                                                                         |
| G   | QR GS1 Digital Link (`/01/`, `/gtin/`, avec `/10/`, `/21/`, query) | unit                                | GTIN-14 extrait, lot/série proposés, query ignorée, aucun fetch                                 |
| G'  | Digital Link avec GTIN invalide / compressé                        | unit                                | rejeté comme « pas un identifiant produit »                                                     |
| H   | QR URL sans GTIN                                                   | unit + UI                           | aucun « produit détecté », aucun fetch (espion `fetch` = 0)                                     |
| I   | QR texte arbitraire / > 2048 / contrôle                            | unit                                | rejet propre                                                                                    |
| J   | Source primaire timeout                                            | Deno (fetch simulé)                 | réponse dans le budget, source `unavailable`, autres sources utilisées                          |
| K   | Source primaire 500                                                | Deno                                | idem, pas mis en cache                                                                          |
| L   | Quota (429 / payload quota)                                        | Deno                                | `unavailable`, disjoncteur, pas de cache négatif                                                |
| M   | A/B concordantes                                                   | unit                                | `exact_agreement` ⇒ `corroborated`                                                              |
| N   | A/B contradictoires                                                | unit + UI                           | `conflict`, aucune fusion de champs, choix explicite                                            |
| O   | Offline                                                            | UI (réseau coupé)                   | cas C, GTIN conservé, save possible                                                             |
| P   | Identifié puis modifié                                             | unit + pgTAP                        | `user_provided`, instantané conservé, check réarmé (nom/marque)                                 |
| Q   | Rescan même GTIN                                                   | Deno                                | cache hit, 0 appel externe                                                                      |
| R   | Cache hit / expiré                                                 | Deno + pgTAP                        | frais ⇒ 0 appel ; expiré ⇒ rafraîchi                                                            |
| S   | Image absente                                                      | unit + UI                           | aucun impact sur statut ni niveau                                                               |
| T   | Aucune IA / aucune hallucination                                   | test statique d'imports + unit      | aucun import `nebius`/`matching` ; jamais de nom quand toutes les sources renvoient `not_found` |
| U   | UPC-E valide `04252614`                                            | unit                                | expansé `042100005264`, valide (corrige D1)                                                     |
| V   | GTIN restreint (02/04/2x)                                          | unit                                | pas de lookup externe                                                                           |
| W   | Kill switch désactivé                                              | Deno                                | aucun appel externe, cas C                                                                      |
| X   | Requête sans JWT / anon                                            | Deno                                | 401                                                                                             |
| Y   | Nom catalogue = nom d'un scope rappelé, sans GTIN concordant       | pgTAP + Deno matching               | aucune alerte confirmée                                                                         |
| Z   | Thule iOS `0091021037090` vs scope `091021037090` (après 17.3-S)   | pgTAP + Deno matching               | `confirmed` (soumis à F-4), plus de faux conflit                                                |
| AA  | Rate limit utilisateur                                             | Deno                                | 429 propre, cas C côté app                                                                      |
| AB  | Privacy                                                            | Deno (espion fetch)                 | requête sortante ne contient que le GTIN                                                        |

Tests appareil (manuels) : valeur et `type` réellement renvoyés pour UPC-A et UPC-E sur iPhone et
Android physiques, avant toute correction de D1/D2.

---

## 21. Risques

- **D2 (faux négatif recall iOS)** existe déjà en production ; sa correction modifie des
  confirmations ⇒ revue et rollout contrôlés.
- Couverture non alimentaire insuffisante sans fournisseur payant ⇒ UX « non identifié » fréquente.
- Conditions de cache des fournisseurs commerciaux inconnues ⇒ peut limiter le cache.
- Quota OFF par IP partagée.
- Données catalogue erronées (titres marketing, mauvaise marque) ⇒ confirmation utilisateur
  obligatoire, source toujours visible.
- Coût et dépendance fournisseur ⇒ abstraction d'adapters + kill switch par source.
- QR malveillant pointant vers un GTIN rappelé ⇒ au pire une alerte pour l'utilisateur lui-même ;
  aucune URL suivie.
- Nom catalogue élargissant la génération de candidats ⇒ plus de `needs_review` possibles (jamais
  de `confirmed`) — à surveiller.
- Enregistrement sans nom (si retenu) ⇒ listes avec « Produit non identifié ».

---

## 22. Découpage recommandé (adapté au code réel)

| Tranche                                          | Contenu                                                                                                                                                                                                                                                                                                                                                               | Prod                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **17.3-S** — GTIN equivalence in recall matching | Comparaison canonique GTIN-14 dans le SQL de récupération (expression index `lpad(...)`) et dans `_shared/matching` (`normalizeGtin` canonique côté comparaison) ; pgTAP + Deno ; recensement **lecture seule** en prod des `owned_products.gtin` de 13 chiffres commençant par `0` (après GO) ; vérification appareil iOS préalable. Touche 17.7/F-4 ⇒ revue dédiée. | migration + deploy contrôlés      |
| **17.3a** — Primitives locales                   | `parseGtin` (symbologie, UPC-E, gtin14, GTIN restreints), parseur QR / Digital Link pur, activation `qr` dans le scanner, correction D1 ; partage app/Edge ; tests A-I, U, V. Aucun réseau.                                                                                                                                                                           | app seulement                     |
| **17.3b** — Schéma                               | `private.product_identity_cache`, colonnes `owned_products` (`gtin14` générée, `identity_level`, `identity_provenance jsonb` validé, `barcode_symbology`, `barcode_raw`), compteurs de débit ; local + pgTAP.                                                                                                                                                         | migration (plus tard)             |
| **17.3c** — Benchmark puis premier fournisseur   | Benchmark de couverture sur GTIN publics des scopes (dont Thule) : OFF + 1-2 commerciaux en essai ; décision opérateur ; Edge Function `identify-product` + resolver + adapter OFF + adapter retenu, kill switch désactivé ; tests J-T, W-AB.                                                                                                                         | secret éventuel, deploy plus tard |
| **17.3d** — UX d'identification                  | États chargement, cas A/B/B'/C, confirmation, « Recall surveille maintenant ce produit ».                                                                                                                                                                                                                                                                             | app                               |
| **17.3e** — Fallback / manuel                    | Save sans nom (si validé), « Réessayer l'identification », édition ⇒ `user_provided`.                                                                                                                                                                                                                                                                                 | app                               |
| **17.3f** — Rollout production contrôlé          | Migration, deploy, secret, activation flag — chacun sur « GO <étape> » explicite.                                                                                                                                                                                                                                                                                     | oui                               |

Ordre conseillé : **17.3-S** (ou en parallèle de 17.3a) car c'est un défaut recall-safety déjà
présent ; puis 17.3a → 17.3b → 17.3c → 17.3d/e → 17.3f.

---

## Sources externes consultées (2026-10-04)

- Open Food Facts API : https://openfoodfacts.github.io/openfoodfacts-server/api/
- UPCitemdb limites : https://www.upcitemdb.com/wp/docs/main/development/api-rate-limits/
- Go-UPC API : https://go-upc.com/plans/api
- Barcode Lookup (tarifs via résultats de recherche ; page API inaccessible, 403) : https://www.barcodelookup.com/api
- Verified by GS1 : https://www.gs1us.org/industries-and-insights/by-topic/verified-by-gs1 ,
  https://gs1co.org/sites/default/files/libreria-archivos/en-verified-by-gs1.pdf
- Expo Camera 57.0.5 : code source local `node_modules/expo-camera`
