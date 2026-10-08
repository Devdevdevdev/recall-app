# Phase 17.3b — Product lookup (GTIN → nom + marque) — Discovery & benchmark fournisseurs

Statut : **CLOSED** (2026-10-08) — recherche, benchmark et design uniquement ; décisions produit de
clôture en §0. Aucune écriture production, aucune migration, aucun déploiement Edge, aucun changement app/runtime,
aucun secret, aucun compte, aucun achat, aucune build.

Baseline vérifiée : `HEAD` = `origin/main` = `6c3b2d40bf8281d64b0edc35d4208332b9641988`, ahead 0 /
behind 0, arbre propre. 17.3a = CLOSED (APK accepté `7720b0a8-…`, SHA-256 `6f40930b…`).

Artefacts :

| Fichier                                                    | Rôle                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tests/fixtures/phase-17-3b-product-lookup-benchmark.json` | dataset (48 cas), ground truth sourcée, revues manuelles                         |
| `scripts/bench-product-lookup.mjs`                         | `--run` (réseau, GTIN seul) et `--score` (hors ligne)                            |
| `docs/phase-17-3b-product-lookup-benchmark-results.json`   | 177 réponses brutes réduites aux champs d'identité (OFF : ODbL, © contributeurs) |

Reproduire le score (hors ligne, sur le run historique inchangé) :
`node scripts/bench-product-lookup.mjs --score`. Un nouveau run réseau exige un fichier neuf
(`--run --out <fichier>`), n'écrase jamais le run historique, et n'appelle plus aucun fournisseur
pour un RCN-8 sauf `--include-rcn` (le run consomme ~59 des 100 requêtes/jour gratuites UPCitemdb
et respecte 15 req/min pour OFF).

---

## 0. Décisions de clôture (2026-10-08)

| Sujet                            | Décision                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RCN-8                            | **pas de lookup produit automatique** : statut `not_eligible`, 0 appel fournisseur, 0 ligne de cache global ; nom/marque manuels autorisés ; scan valide, produit enregistrable, GTIN toujours disponible pour les mécanismes Recall existants (§3). Matching et F-4 inchangés |
| Fournisseur MVP                  | **Open Food Facts famille, API v3, `product_type=all`**                                                                                                                                                                                                                        |
| Fournisseur payant               | **NO-GO** actuellement                                                                                                                                                                                                                                                         |
| UPCitemdb                        | benchmark conservé, **non intégré** en 17.3c                                                                                                                                                                                                                                   |
| GS1                              | évaluation future / source de validation                                                                                                                                                                                                                                       |
| Tavily / recherche web générique | **NO-GO** pour le MVP                                                                                                                                                                                                                                                          |
| Fallback                         | saisie manuelle                                                                                                                                                                                                                                                                |
| User-Agent OFF                   | identifiant projet non personnel (§2)                                                                                                                                                                                                                                          |
| Cache OFF en production          | conformité ODbL : **REVIEW REQUIRED** (§10)                                                                                                                                                                                                                                    |
| Vérité terrain physique          | jamais confirmée par OFF ; `5400141472714` et `27044193` en attente de confirmation physique ; `7622202826269` exclu (§6.5)                                                                                                                                                    |

## 1. Invariant de sécurité — séparation lookup / rappel

Le lookup produit est une **aide à la saisie**, jamais une preuve.

```text
Nom/marque fournis par un catalogue  ≠  preuve qu'un produit est rappelé
Sécurité Recall = SOURCE OFFICIELLE DE RAPPEL + APPLICABILITÉ DÉTERMINISTE + F-4
```

Le lookup ne peut pas :

- créer une alerte ni rendre un rappel applicable ;
- contourner F-4 (aucune auto-confirmation, aucun relâchement modèle / date / lot / juridiction) ;
- fabriquer une preuve de modèle, date ou lot ;
- modifier une règle de rappel, un scope ou un GTIN de scope ;
- servir de catalogue inverse : le nom d'un avis de rappel ne sert jamais à « identifier » un scan.

Propriétés de conception pour 17.3c (testables) :

1. Le cache de lookup est une table distincte, **non lue** par le matching
   (`_shared/matching/*`, `process-recall-matches*`, `check-owned-product`) — test statique d'imports
   et pgTAP : aucune fonction de matching ne référence la table.
2. Le résultat ne fait que **pré-remplir** `ProductForm` ; rien n'est persisté sans action
   utilisateur ; nom et marque restent éditables.
3. Le matching continue de dépendre du GTIN (17.3-S), du modèle et des règles, quelle que soit
   l'origine du nom.
4. Le benchmark lui-même n'a lu aucune table de rappel et n'a rien écrit nulle part.

### Contrat de sécurité OFF

Open Food Facts ne constitue **jamais** : une preuve de rappel, une preuve d'applicabilité, une
preuve F-4, une preuve de modèle / date / lot, ni une source officielle de sécurité produit. OFF sert
**uniquement** à proposer `name` et `brand` dans `ProductForm` ; l'utilisateur reste libre de les
modifier.

Ground truth : les avis CPSC / Santé Canada / RappelConso servent **uniquement** de vérité terrain
indépendante pour le benchmark (publication officielle conjointe GTIN + nom + marque). Ils ne
deviennent pas une source de lookup.

## 2. Frontière de confidentialité

Seul le **GTIN** quitte Recall. Pendant le benchmark, chaque requête ne contenait qu'un GTIN dans
l'URL : pas de cookie, pas de clé, pas d'utilisateur, pas d'appareil, pas d'inventaire, pas de
lot / série / date.

Jamais transmis à un fournisseur : `user_id`, email, nom, pays du compte, inventaire, numéro de
série, lot, date d'achat, appareil, push token, historique de scans.

Points de conception :

- le lookup passe **par une Edge Function** : le fournisseur voit l'IP Supabase, pas celle de
  l'utilisateur, et ne peut pas reconstituer l'inventaire d'une personne ;
- l'email d'un utilisateur n'est **jamais** placé dans le User-Agent ni dans aucune requête.

### Politique User-Agent OFF

Une adresse email personnelle n'est **pas nécessaire**. Formulations officielles OFF relevées le
2026-10-08 :

- introduction de l'API ([openfoodfacts-server/api](https://openfoodfacts.github.io/openfoodfacts-server/api/)) :
  « The User-Agent should be in the form of `AppName/Version (ContactEmail)`. For example,
  `MyApp/1.0 (myapp@example.com)`. » ;
- tutoriel OFF ([comparing-sodas](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/comparing-sodas/)) :
  « add a `User-Agent` HTTP Header with the name of his app, the version, system and a url (if any) ».

Le but déclaré est d'identifier l'application (ne pas être pris pour un bot). Proposition 17.3c :
`Recall/<version> (https://github.com/Devdevdevdev/recall-app)` — dépôt **public** vérifié le
2026-10-08, à conserver tant qu'il reste l'URL publique officielle du projet. Si OFF demande un
contact email, utiliser une adresse **de projet** dédiée (non personnelle), jamais celle d'un
utilisateur. Le script de benchmark utilise désormais
`RecallProductLookupBenchmark/0.1 (https://github.com/Devdevdevdev/recall-app)`.

Écart du benchmark (pas un incident de production) : avant l'écriture du script, deux requêtes
manuelles de sonde (1 OFF, 1 UPCitemdb) ont porté l'adresse email **de l'opérateur** dans le
User-Agent. Aucune donnée utilisateur Recall n'a été transmise ; aucune autre requête n'a contenu
d'email (le run historique utilisait `RecallProductLookupBenchmark/0.1 (research benchmark)`).

## 3. Identité d'entrée (contrat 17.3a)

Les entrées fournisseur dérivent exclusivement de `toScannedBarcode(symbology, raw)` :
`{ matchingGtin, canonicalGtin14, scan: { rawValue, symbology } | null }`.

| Contrôle                   | Résultat                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| UPC-E explicite `04252614` | entrée fournisseur `042100005264`, canonique `00042100005264` — **PASS** (local, aucun appel) |
| EAN-8 `27044193`           | reste EAN-8, canonique `00000027044193`, aucune expansion — **PASS**                          |
| 8 chiffres sans symbologie | toujours GTIN-8, jamais UPC-E (règle 17.3a inchangée)                                         |

`04252614` est le GENERATED UPC-E TEST : jamais envoyé à un fournisseur, jamais traité comme produit.

### Représentations acceptées par fournisseur

| Fournisseur | raw    | matchingGtin | GTIN-13 (UPC-A + `0`) | canonicalGtin14 | Accord avec matchingGtin               |
| ----------- | ------ | ------------ | --------------------- | --------------- | -------------------------------------- |
| OFF v3      | 47 req | 47 req       | 24 req                | 47 req          | **100 %** (OFF normalise côté serveur) |
| UPCitemdb   | 47 req | 47 req       | 4 req                 | 8 req           | **100 %** sur l'échantillon testé      |

Aucune représentation rejetée (0 `INVALID_UPC`). Recommandation adapter : envoyer
**`matchingGtin`** (forme la plus courte, celle stockée), garder `canonicalGtin14` comme clé de cache.
Le choix reste par adapter : un futur fournisseur n'acceptant pas le GTIN-14 sera géré dans son
adapter, pas dans l'app.

### Numéros à circulation restreinte (RCN) — décision

**Règle GS1 retenue (RCN-8)** : un GTIN-8 dont le préfixe GS1-8 commence par `0` ou `2` est un
Restricted Circulation Number (RCN-8). Un RCN est attribué localement (au sein d'une entreprise ou
par l'organisation GS1 locale) et **n'est pas garanti unique mondialement**.

Sources :

- GS1 General Specifications, §2.1.11–2.1.12 (numéros à circulation restreinte) ;
- GS1 Standards Change Notice
  [GSCN 23-006 « RCN »](https://www.gs1.org/docs/barcodes/GSCN-23-006-RCN.pdf) : « RCN-8 is an
  8-digit Restricted Circulation Number beginning with GS1-8 Prefix 0 or 2 » (lu via l'index de
  recherche ; le PDF gs1.org renvoie 403 depuis cet environnement) ;
- [biip — RCN reference](https://biip.readthedocs.io/stable/reference/rcn/) (bibliothèque tierce
  citant GS1 General Specifications §2.1.11–2.1.12) : RCN-8 = « prefix 0 or 2 ».

Le texte primaire GS1 n'a pas pu être téléchargé ici (403) : la règle est corroborée par deux
lectures secondaires concordantes ; relire le texte primaire lors de 17.3c.

Détection (script, futur adapter) : sur le **GTIN de matching** de 8 chiffres (jamais sur le GTIN-14
complété de zéros, qui ne distingue pas un GTIN-8 d'un GTIN-12 commençant par des zéros) :
`/^[02]/`. Un UPC-E développé (12 chiffres) n'est jamais un RCN-8.

**Décision** : RCN-8 ⇒ statut de lookup **`not_eligible`**, **0** appel fournisseur, **0** ligne
de cache global, nom/marque **manuels autorisés**. Le scan reste valide, le produit peut être
enregistré, le code reste disponible pour les mécanismes Recall existants (17.3a/17.3-S). Le
matching de rappel et F-4 ne changent **pas** dans cette phase.

Cas benchmarké : `27044193` ⇒ **RCN-8**. La réponse historique OFF `Regalo | Citroensap` reste dans
le run historique comme **« provider found »**, mais n'est **pas** une identification
automatiquement utilisable par Recall (« Recall-eligible » = non) — voir §6.0.

RCN-12/13 (préfixes `02`, `04`, `20–29`) : seulement signalés par le script (`RCN-12/13`) ; aucune
politique décidée dans cette phase, aucun cas dans le dataset.

## 4. Dataset & ground truth

48 cas, aucune donnée utilisateur :

| Groupe                                | Cas | Ground truth                                                         | Scoring                                                           |
| ------------------------------------- | --- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Avis officiels CPSC (US)              | 16  | SaferProducts.gov API / cpsc.gov (GTIN + nom + marque publiés)       | 15 SCORED + 1 BRAND_ONLY (Sloosh)                                 |
| Avis officiels Santé Canada           | 8   | recalls-rappels.canada.ca                                            | SCORED                                                            |
| Avis officiels RappelConso (FR/BE/EU) | 17  | open data `rappelconso-v2-gtin-espaces`                              | 16 SCORED + 1 BRAND_ONLY (Søstrene Grene)                         |
| Grand public (retailer / marque)      | 3   | Auchan (Nutella), fiche One Stop (Coca-Cola), Salsify marque (Kraft) | SCORED                                                            |
| Physiques 17.3a                       | 3   | **emballage non consigné** dans le dépôt                             | 2 PENDING_PHYSICAL_USER_CONFIRMATION + 1 EXCLUDED_NO_GROUND_TRUTH |
| Généré UPC-E                          | 1   | —                                                                    | NORMALIZATION_ONLY                                                |

**44 cas notés** (42 SCORED + 2 BRAND_ONLY). Régions notées : BE 5, EU 14, US 17, CA 8.
Catégories : alimentation 12, ménager 7, électroménager 5, jouets 5, batteries/électronique 5,
autres 4, puériculture 3, cosmétique 3.

Biais assumé : 41/44 cas viennent d'avis de rappel. C'est la population qui compte pour Recall
(produits non alimentaires des scopes CPSC/Santé Canada), mais ce sont souvent des produits de niche
ou retirés. La couverture « grand public » réelle sera plus élevée en alimentaire (3/3 trouvés
par OFF) ; elle ne l'est pas en non-alimentaire européen (voir §6).

Écarté : Duracell `5000394017641` (page retailer inaccessible, 403 → ground truth non vérifiée).

## 5. Méthode de scoring

- `brandAliases` : marque normalisée (casse, accents, ponctuation, `ø→o`) ; un champ marque multiple
  (`Nutella, Ferrero`) est EXACT si une partie correspond ; ACCEPTABLE si l'une contient l'autre
  (`COCA-COLA SERVICES SA/NV`) ; placeholders (`unknown`, `n/a`, `generic`…) = MISSING.
- `nameGroups` : tous les groupes doivent apparaître dans le nom (alternatives multilingues) ⇒
  ACCEPTABLE ; une partie ⇒ PARTIAL ; aucune ⇒ WRONG.
- Verdict : marque ou nom WRONG ⇒ **WRONG** ; nom et marque bons ⇒ EXACT/ACCEPTABLE ; sinon PARTIAL ;
  plusieurs items aux marques divergentes ⇒ CONFLICT ; fiche existante sans nom ni marque ⇒
  NOT_FOUND (« empty record »).
- **Chaque réponse trouvée a été relue à la main.** 4 corrections documentées dans le fixture
  (`manualReviews`), aucune ne transforme un produit/variante/conditionnement faux en correct :
  - OFF Nutraphase : marque = gamme « Clean Beans » imprimée sur le pack ⇒ ACCEPTABLE (signalé sous-marque) ;
  - OFF Chatka : le champ nom contient seulement la marque ⇒ PARTIAL ;
  - UPCitemdb Coca-Cola : titre marketplace « 2 Packs Of 24 X 330ml » sur le GTIN d'une canette ⇒ PARTIAL ;
  - UPCitemdb Lil' Buddies : titre grossiste « (24-Pack) … Wholesale » ⇒ PARTIAL.
- La seule réponse WRONG retenue : UPCitemdb Woolite, marque `AmazonUs/RECAS` (vendeur, pas marque).

## 6. Résultats

### 6.0 RAW BENCHMARK RESULT vs RECALL-ELIGIBLE RESULT

Le run historique (2026-10-08, avant la décision RCN, 177 requêtes) est **conservé tel quel** dans
`docs/phase-17-3b-product-lookup-benchmark-results.json`. Le score est recalculé hors ligne avec les
règles de clôture : vérité terrain non confirmée exclue, RCN identifié séparément.

| Vue                    | Définition                                                         |
| ---------------------- | ------------------------------------------------------------------ |
| RAW BENCHMARK RESULT   | toutes les réponses du run historique, y compris le RCN-8          |
| RECALL-ELIGIBLE RESULT | uniquement les GTIN éligibles au lookup automatique (RCN-8 exclus) |

« Provider found » (un catalogue a répondu) vs éligibles (entrée `matchingGtin`, 47 cas interrogés) :

| Fournisseur | RAW : provider found | RECALL-ELIGIBLE : found utilisable | Found mais non éligible                                                                                |
| ----------- | -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| OFF         | 15 / 47              | 14 / 46                            | `27044193` (RCN-8) → `Regalo \| Citroensap` : aucun usage Recall (ni pré-remplissage, ni cache global) |
| UPCitemdb   | 14 / 47              | 14 / 46                            | —                                                                                                      |

Scores d'exactitude (44 cas à vérité terrain confirmée) : **identiques dans les deux vues**, car le
RCN-8 n'a jamais eu de vérité terrain confirmée et n'était donc pas noté. Seul le nombre de requêtes
de latence change (OFF 118 → 116, UPCitemdb 59 → 57), sans effet sur p50 / p95 / max.

| Métrique (44 cas notés) | OFF RAW = ELIGIBLE | UPCitemdb RAW = ELIGIBLE | Chaîne RAW = ELIGIBLE |
| ----------------------- | ------------------ | ------------------------ | --------------------- |
| coverage                | 25.0 %             | 31.8 %                   | 47.7 %                |
| correct-both            | 18.2 %             | 22.7 %                   | 34.1 %                |
| wrong-positive          | 0.0 %              | 2.3 %                    | 2.3 %                 |

### 6.1 Synthèse (44 cas notés, entrée `matchingGtin`) — chiffres du run historique

| Métrique                                            | OFF famille (v3)              | UPCitemdb (trial)           | Chaîne OFF → UPCitemdb |
| --------------------------------------------------- | ----------------------------- | --------------------------- | ---------------------- |
| attempts                                            | 44                            | 44                          | 44                     |
| HTTP success                                        | 44                            | 44                          | 44                     |
| found                                               | 11                            | 14                          | 21                     |
| not found                                           | 33 (dont 1 empty record)      | 30                          | 23                     |
| errors                                              | 0                             | 0                           | 0                      |
| NAME exact / acceptable / partial / wrong / missing | 0 / 9 / 2 / 0 / 0             | 0 / 11 / 2 / 0 / 0          | 0 / 17 / 3 / 0 / 0     |
| BRAND exact / acceptable / wrong / missing          | 7 / 2 / 0 / 2                 | 10 / 1 / 1 / 2              | 14 / 3 / 1 / 3         |
| **coverage**                                        | **25.0 %**                    | **31.8 %**                  | **47.7 %**             |
| **correct-both**                                    | **18.2 %** (8)                | **22.7 %** (10)             | **34.1 %** (15)        |
| **wrong-positive**                                  | **0.0 %**                     | **2.3 %** (1)               | **2.3 %**              |
| partial                                             | 6.8 %                         | 6.8 %                       | 11.4 %                 |
| conflict                                            | 0 %                           | 0 %                         | 0 %                    |
| not-found                                           | 75.0 %                        | 68.2 %                      | 52.3 %                 |
| error                                               | 0 %                           | 0 %                         | 0 %                    |
| réponses multiples                                  | 0                             | 0                           | 0                      |
| image dispo (sur trouvés)                           | 8/11                          | 13/14                       | —                      |
| catégorie dispo (sur trouvés)                       | 6/11                          | 9/14                        | —                      |
| latence p50 / p95 / max (toutes requêtes)           | 89 / 159 / 1 575 ms (118 req) | 329 / 421 / 588 ms (59 req) | ≤ somme                |

« Exact » strict = 0 partout : aucun fournisseur ne reproduit mot pour mot le libellé de la vérité
terrain (attendu ; c'est pourquoi le scoring utilise ACCEPTABLE).

### 6.2 Par région

| Région                 | OFF : coverage / correct / wrong | UPCitemdb : coverage / correct / wrong |
| ---------------------- | -------------------------------- | -------------------------------------- |
| Belgique / Europe (19) | 31.6 % / 21.1 % / 0 %            | 10.5 % / 5.3 % / 0 %                   |
| US / Canada (25)       | 20.0 % / 16.0 % / 0 %            | 48.0 % / 36.0 % / 4.0 %                |

### 6.3 Par catégorie (trouvés / corrects)

| Catégorie              | n   | OFF                           | UPCitemdb       |
| ---------------------- | --- | ----------------------------- | --------------- |
| alimentation           | 12  | 10 / 7                        | 4 / 3           |
| cosmétique             | 3   | 1 / 1 (via Open Beauty Facts) | 0 / 0           |
| ménager                | 7   | 0 / 0                         | 2 / 1 (1 WRONG) |
| électroménager         | 5   | 0 / 0                         | 2 / 1           |
| jouets                 | 5   | 0 / 0                         | 3 / 2           |
| batteries/électronique | 5   | 0 / 0                         | 1 / 1           |
| puériculture           | 3   | 0 / 0                         | 0 / 0           |
| autres                 | 4   | 0 / 0                         | 2 / 2           |

**Trou structurel : non-alimentaire européen = 1/13 chez OFF (Activilong, via Open Beauty Facts)
et 0/13 chez UPCitemdb ; hors cosmétique : 0/10 partout** (Brabantia, Zwilling, Legrand, Sophie la
girafe, Quechua, Westmark, Nicer Dicer, Berjuan, Da Vinci, Søstrene Grene). Open Products Facts n'a rien trouvé (0 redirection vers
`openproductsfacts.org`) ; son produit le plus scanné s'appelle `gff` (Marlboro) — illustration du
risque qualité communautaire hors alimentaire.

Thule `091021037090` : toujours introuvable (OFF, UPCitemdb), comme au 2026-10-04.

### 6.4 Détail des réponses trouvées

| Cas                         | OFF                                                                            | UPCitemdb                                                                            |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Nutella 400 g               | ACCEPTABLE `Nutella, Ferrero \| Nutella`                                       | —                                                                                    |
| Coca-Cola 330 ml (BE)       | ACCEPTABLE `COCA-COLA SERVICES SA/NV \| Coca-Cola Original`                    | PARTIAL `∅ \| 2 Packs Of 24 X 330ml Coke Cans`                                       |
| Kraft Mac & Cheese          | ACCEPTABLE `Kraft \| mac & cheese`                                             | ACCEPTABLE `Kraft \| Kraft Original Mac and Cheese Dinner - 7.25oz`                  |
| So Delicious salted caramel | PARTIAL `SO DELICIOUS \| CASHEW BASE NON-DAIRY FROZEN DESSERT` (parfum absent) | ACCEPTABLE `So Delicious \| … Salted Caramel Cluster … Cashew Frozen Dessert 500 Ml` |
| Compliments chicken burgers | ACCEPTABLE                                                                     | —                                                                                    |
| Nutraphase Clean Beans      | ACCEPTABLE (sous-marque)                                                       | —                                                                                    |
| Olymel chicken strips       | ACCEPTABLE `Olymel \| Lanieres de poitrines de poulet`                         | —                                                                                    |
| Lima galettes de riz        | ACCEPTABLE `Lima \| Galettes de riz complet`                                   | ACCEPTABLE `LIMA \| Lima - Rice Cakes With Salt \| 100g`                             |
| Isali tikka massala         | NOT_FOUND (fiche vide)                                                         | —                                                                                    |
| Nollens aiguillettes        | PARTIAL `∅ \| Aiguillettes de poulet`                                          | —                                                                                    |
| Chatka crabe                | PARTIAL `∅ \| Chatka`                                                          | —                                                                                    |
| Activilong shampooing       | ACCEPTABLE (Open Beauty Facts)                                                 | —                                                                                    |
| Hampton Bay Halwin          | —                                                                              | PARTIAL `unknown \| Hampton Bay Halwin 52in Matte Black …`                           |
| Lil' Buddies laser          | —                                                                              | PARTIAL (titre grossiste 24-pack)                                                    |
| Granitestone                | —                                                                              | ACCEPTABLE                                                                           |
| Bazic glue                  | —                                                                              | ACCEPTABLE `BAZIC Products \| BAZIC Silicone Glue 3.38Oz`                            |
| Woolite Delicates           | —                                                                              | **WRONG** `AmazonUs/RECAS \| Woolite Delicates … (B08P3FW3N8)`                       |
| Pearhead learning set       | —                                                                              | ACCEPTABLE                                                                           |
| CRAFTSMAN tiller            | —                                                                              | ACCEPTABLE                                                                           |
| FURminator conditioner      | —                                                                              | ACCEPTABLE                                                                           |
| BLACK+DECKER HGS011         | —                                                                              | ACCEPTABLE `… Easy Garment Steamer HGS011F`                                          |
| Sloosh (marque seule)       | —                                                                              | ACCEPTABLE `Joyin` (propriétaire de la marque Sloosh)                                |

Qualité UPCitemdb : titres marketplace (ASIN, « Cheap Wholesale », quantités de lot), vendeur dans
le champ marque. Un adapter devra nettoyer (ASIN entre parenthèses) mais **ne pourra jamais
corriger** un mauvais conditionnement : l'utilisateur doit confirmer.

### 6.5 Produits physiques — vérité terrain

OFF n'est **pas** utilisé pour confirmer ces produits : une réponse fournisseur n'est jamais la
vérité terrain. Les réponses historiques ci-dessous ne sont que des « provider found ».

| GTIN            | Réponse historique OFF (non vérifiée)               | UPCitemdb | Statut                                                                                                                                          |
| --------------- | --------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `5400141472714` | `boni selection \| Light margarine`                 | not found | **PENDING PHYSICAL USER CONFIRMATION**                                                                                                          |
| `27044193`      | `Regalo \| Citroensap`                              | not found | **PENDING PHYSICAL USER CONFIRMATION** + **RCN-8** : exclu du scoring de lookup automatique, même après confirmation                            |
| `7622202826269` | `PHILADELPHIA \| PHILADELPHIA Mediteraanse kruiden` | not found | **EXCLUDE FROM SCORED GROUND TRUTH** : emballage plus disponible, aucune source fabricant/distributeur indépendante établie ; rien n'est inféré |

## 7. Fournisseurs — conditions vérifiées (2026-10-08)

|                             | A. Open Food Facts (+ Beauty / Pet Food / Products)                                                                                                                                                                                                      | C. UPCitemdb                                                                                                                                                      | D. Verified by GS1                                                                                                                                              | E. Barcode Lookup                                                         | F1. Go-UPC                                                    | F2. EAN-Search.org                                                         | G. Web / Tavily                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Docs officielles            | [API](https://openfoodfacts.github.io/openfoodfacts-server/api/), [terms](https://world.openfoodfacts.org/terms-of-use)                                                                                                                                  | [devs](https://devs.upcitemdb.com/), [rate limits](https://www.upcitemdb.com/wp/docs/main/development/api-rate-limits/), [terms](https://www.upcitemdb.com/terms) | [support GS1](https://support.gs1.org/support/solutions/articles/43000734075-how-many-queries-can-a-user-perform-using-the-verified-by-gs1-service-on-gs1-org-) | barcodelookup.com/api (**403**)                                           | [plans](https://go-upc.com/plans/api)                         | [API](https://www.ean-search.org/ean-database-api.html)                    | [pricing](https://www.tavily.com/pricing), [credits](https://docs.tavily.com/documentation/api-credits.md) |
| Endpoint                    | `GET /api/v3/product/{code}?product_type=all` (v3 = courant, v2 = **déprécié**) ; `product_type=all` **redirige (302)** vers la base sœur                                                                                                                | `/prod/trial/lookup` (gratuit), `/prod/v1/lookup` (payant)                                                                                                        | interface web publique ; API via organisation membre GS1                                                                                                        | REST + clé                                                                | REST + clé                                                    | REST + token                                                               | search API + clé                                                                                           |
| Auth                        | aucune en lecture ; User-Agent personnalisé **obligatoire** (identifiant d'application, §2)                                                                                                                                                              | aucune (trial) ; `user_key` + `key_type` (payant)                                                                                                                 | compte / contrat MO                                                                                                                                             | clé                                                                       | clé (trial « sur demande »)                                   | token                                                                      | clé                                                                                                        |
| Free tier                   | gratuit                                                                                                                                                                                                                                                  | 100 requêtes combinées/jour, sans inscription                                                                                                                     | 30 requêtes GTIN / 24 h (web)                                                                                                                                   | UNCONFIRMED                                                               | trial sur demande                                             | Trial 100 req/mois (1 € puis 9 €/mois)                                     | 1 000 crédits/mois                                                                                         |
| Prix                        | 0                                                                                                                                                                                                                                                        | DEV 99 $/mois (20 000 lookup/j, overage 0,04 $/100) ; PRO 699 $/mois (150 000/j)                                                                                  | adhésion GS1 / contrat MO — **non publié**                                                                                                                      | UNCONFIRMED (ancienne observation non officielle : 99 $ / 5 000 par mois) | 74,95 $ / 5 000 ; 245 $ / 45 000 ; 795 $ / 450 000 (par mois) | 19 € / 5 000 ; 39 € / 50 000 ; 99 € / 150 000 ; 149 € / 300 000 (par mois) | 0,008 $/crédit PAYG ; 30 $/4 000 ; 1 crédit = recherche basique                                            |
| Rate limit                  | **15 req/min/IP** lecture produit ; 10/min recherche                                                                                                                                                                                                     | trial : **6 req/min/IP** ; payant par application                                                                                                                 | 30/jour                                                                                                                                                         | UNCONFIRMED                                                               | UNCONFIRMED                                                   | UNCONFIRMED                                                                | selon plan                                                                                                 |
| Licence                     | données **ODbL**, contenu DbCL, images **CC BY-SA**                                                                                                                                                                                                      | « limited, non-exclusive, non-transferable … solely for Customer's operations » ; aucune garantie                                                                 | contrat GS1 ; CGU publiques **UNCONFIRMED** (PDF 403)                                                                                                           | UNCONFIRMED                                                               | UNCONFIRMED                                                   | UNCONFIRMED                                                                | contenu tiers (sites marchands)                                                                            |
| Usage commercial            | **oui**, sous conditions (attribution, share-alike)                                                                                                                                                                                                      | implicite pour « Customer's operations » ; à confirmer par écrit                                                                                                  | via contrat                                                                                                                                                     | UNCONFIRMED                                                               | UNCONFIRMED                                                   | UNCONFIRMED                                                                | dépend de chaque site source                                                                               |
| Attribution                 | **requise** (« Open Food Facts », lien)                                                                                                                                                                                                                  | non mentionnée                                                                                                                                                    | contrat                                                                                                                                                         | UNCONFIRMED                                                               | UNCONFIRMED                                                   | UNCONFIRMED                                                                | provenance par URL obligatoire (règle Recall)                                                              |
| Cache / stockage name+brand | réutilisation permise par ODbL **sous conditions** (attribution ; share-alike d'une base dérivée utilisée publiquement) ; conformité d'un cache de production : **REVIEW REQUIRED** ; > quelques centaines de produits ⇒ OFF demande d'utiliser l'export | **non mentionné** ⇒ UNCONFIRMED                                                                                                                                   | contrat                                                                                                                                                         | UNCONFIRMED                                                               | UNCONFIRMED                                                   | UNCONFIRMED                                                                | faible / risqué                                                                                            |
| Champs                      | nom, marques, quantité, catégories, images, type                                                                                                                                                                                                         | title, brand, category, model, ean/upc, images, offers                                                                                                            | GTIN, marque, description, URL image, catégorie GPC, contenu net, pays de vente (7 core attributes), licencié                                                   | UNCONFIRMED                                                               | nom, description, image, marque                               | nom, catégorie                                                             | texte libre                                                                                                |
| GTIN acceptés               | 8/12/13/14 (normalisés, mesuré)                                                                                                                                                                                                                          | 8/12/13/14 (mesuré, 0 rejet)                                                                                                                                      | GTIN                                                                                                                                                            | UNCONFIRMED                                                               | UNCONFIRMED                                                   | EAN/UPC                                                                    | n/a                                                                                                        |
| Couverture annoncée         | communautaire ; OPF ≈ 46 651 produits                                                                                                                                                                                                                    | « largest online UPC database » (non chiffré)                                                                                                                     | > 300 M produits (déclarés par les marques)                                                                                                                     | UNCONFIRMED                                                               | « 500 M+ »                                                    | « 1,3 milliard »                                                           | n/a                                                                                                        |
| Benchmark                   | **exécuté**                                                                                                                                                                                                                                              | **exécuté**                                                                                                                                                       | **BLOCKED — MEMBERSHIP / API ACCESS REQUIRED** (interface web non automatisée, aucun contournement)                                                             | **BLOCKED — API KEY REQUIRED**                                            | **BLOCKED — API KEY REQUIRED**                                | **BLOCKED — API KEY REQUIRED** (+ paiement 1 €)                            | **Tavily : BLOCKED — API KEY REQUIRED** ; proxy WebSearch exécuté                                          |

### Web search / Tavily (G) — sonde proxy

Tavily n'a pas pu être testé (clé requise). Sonde proxy avec un moteur de recherche web générique,
requête = GTIN exact entre guillemets, jugement **uniquement sur les titres/URL des résultats**
(jamais sur un résumé généré) :

| Échantillon                                                                                | Résultats utilisables |
| ------------------------------------------------------------------------------------------ | --------------------- |
| 8 GTIN de rappels (Thule, Hampton Bay, Lima, Isali, Zwilling, Gobi Heat, Brabantia, Bazic) | **0/8**               |
| 3 GTIN grand public (Nutella, Kraft, physique BE `5400141472714`)                          | **0/3**               |

Les résultats étaient du bruit numérique (tuiles satellite, suites OEIS, pièces de barbecue Kenmore,
plages IP) : coverage 0 %, et **risque de wrong-positive élevé** si une extraction automatique
choisissait « le meilleur » résultat. Latence et coût Tavily réels : UNCONFIRMED (0,008 $ par
recherche basique). Conclusion : **pas de fallback web dans le MVP** ; à réévaluer seulement avec
un test Tavily sous clé (GO séparé), extraction attachée à une URL source et jamais par LLM libre.

## 8. Scores fournisseurs

Notes /10 sur mesures du benchmark ; « — » = non mesurable (accès bloqué). Total non pondéré /100,
puis un score pondéré **explicite** (poids ci-dessous, somme 100).

| Critère (poids)            | OFF                              | UPCitemdb | GS1                                        | Barcode Lookup | Go-UPC          | EAN-Search      | Web/Tavily         |
| -------------------------- | -------------------------------- | --------- | ------------------------------------------ | -------------- | --------------- | --------------- | ------------------ |
| Coverage globale (15)      | 3                                | 3         | —                                          | —              | —               | —               | 0                  |
| Belgique/Europe (10)       | 4                                | 1         | —                                          | —              | —               | —               | 0                  |
| US/Canada (10)             | 2                                | 5         | —                                          | —              | —               | —               | 0                  |
| Exactitude (15)            | 7                                | 6         | — (attendue la meilleure : données marque) | —              | —               | —               | —                  |
| Wrong-positive safety (20) | 9                                | 6         | —                                          | —              | —               | —               | 2                  |
| Latence (5)                | 10                               | 9         | —                                          | —              | —               | —               | —                  |
| Coût (5)                   | 10                               | 7         | 3 (contrat)                                | —              | 6               | 8               | 6                  |
| Licence commerciale (10)   | 7                                | 5         | —                                          | 2 (illisible)  | 2 (non publiée) | 2 (non publiée) | 2                  |
| Cacheability (5)           | 9 (sous réserve REVIEW REQUIRED) | 3         | —                                          | —              | —               | —               | 2                  |
| Facilité d'intégration (5) | 8                                | 8         | 2                                          | —              | —               | —               | 2                  |
| **TOTAL non pondéré /100** | **69**                           | **53**    | n/a                                        | n/a            | n/a             | n/a             | n/a (≤ 14 mesurés) |
| **Score pondéré /100**     | **64,5**                         | **50,5**  | n/a                                        | n/a            | n/a             | n/a             | n/a                |

Justifications courtes : OFF 0 wrong positive, mais 0 non-alimentaire ; UPCitemdb meilleur US
non-alimentaire, un WRONG (vendeur comme marque) et des titres marketplace, conditions de cache non
écrites ; GS1 et fournisseurs à clé non notés faute d'accès — aucune note inventée.

## 9. Recommandations

Les rôles ci-dessous sont les constats du benchmark ; les **décisions** de clôture sont en §0 (OFF
seul pour le MVP, aucun fournisseur payant, UPCitemdb non intégré, Tavily/web NO-GO).

| Rôle                     | Choix                                                     | Pourquoi                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| best structured provider | **OFF famille** (pour son domaine)                        | 0 % wrong positive, licence claire, gratuit, rapide                                                                                                                                    |
| best free provider       | **OFF famille**                                           | UPCitemdb trial = 100/j/IP, non production                                                                                                                                             |
| best paid provider       | **non déterminé** — UPCitemdb DEV seul candidat mesuré    | 48 % coverage US/CA mais 1 WRONG, Europe 10 %, cache non confirmé                                                                                                                      |
| best Belgium provider    | **OFF** (alimentaire) ; **aucun** pour le non-alimentaire | non-alimentaire EU hors cosmétique : 0/10 partout                                                                                                                                      |
| best US/Canada provider  | **UPCitemdb** (mesuré)                                    | 48 % coverage, 36 % correct                                                                                                                                                            |
| best fallback            | **saisie manuelle**                                       | toujours disponible, aucun risque                                                                                                                                                      |
| GS1 role                 | **cible « verified » à moyen terme**, pas MVP             | seule source de marque déclarée par le propriétaire ; API réservée aux membres via l'organisation GS1 ; interface publique 30/j non automatisable ; contacter GS1 Belgium & Luxembourg |
| Tavily/web role          | **aucun dans le MVP**                                     | 0/11 en proxy, bruit élevé ; réévaluation possible sous clé                                                                                                                            |

### Chaîne recommandée (17.3c)

```text
0. parse 17.3a → invalide ⇒ invalid ; RCN-8 ⇒ not_eligible (0 appel, 0 cache global)
1. cache Recall (canonical GTIN-14)            ⇒ réponse immédiate (positif ou négatif frais)
2. OFF v3 product_type=all (timeout 1 500 ms)   ⇒ found non vide ⇒ résultat
3. sinon unidentified ⇒ saisie manuelle
Budget serveur dur 4 000 ms ; budget client 5 000 ms.
```

Aucun fournisseur payant en 17.3c. Une fiche OFF **vide** est traitée comme `not_found`. Une
réponse OFF **partielle** (marque absente) pré-remplit seulement le champ trouvé. Un fournisseur
supplémentaire éventuel (après une évaluation future sous GO séparé) s'ajouterait comme adapter
derrière OFF, sans jamais fusionner des champs entre sources (§11).

## 10. Cache (non personnel)

| Élément                  | Proposition                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clé                      | `canonical_gtin14` + `provider` (une ligne par source)                                                                                                                                                      |
| Métadonnées obligatoires | `provider`, `license` (ODbL données / CC BY-SA images), `source_url` + métadonnées d'attribution, `fetched_at`, `expires_at`, `status`                                                                      |
| Contenu                  | `name`, `brand`, `quantity?`, `image_url?` (URL, jamais l'image)                                                                                                                                            |
| Positif TTL (proposé)    | OFF 30 jours                                                                                                                                                                                                |
| Négatif TTL (proposé)    | 7 jours (OFF grandit ; nouveaux produits)                                                                                                                                                                   |
| Erreurs / timeouts / 429 | **jamais** mis en cache ; disjoncteur 5 min par fournisseur                                                                                                                                                 |
| RCN-8 / invalide         | **0** appel, **0** ligne de cache global                                                                                                                                                                    |
| Réponse brute OFF        | **non stockée** par défaut                                                                                                                                                                                  |
| Données personnelles     | aucune : pas de `user_id` ; le compteur de rate-limit par utilisateur vit dans une table séparée à rétention courte                                                                                         |
| Licence                  | lignes OFF séparables (`provider='open_food_facts'`) ; attribution affichée. **ODbL production cache compliance = REVIEW REQUIRED** : aucune stratégie de cache n'est présentée comme juridiquement validée |

Lookup **par nouveau GTIN**, pas par scan : un rescan du même produit (même utilisateur ou un autre)
est un cache hit et ne coûte rien.

## 11. Conflits

- Deux sources dont les marques normalisées diffèrent (après alias) ⇒ `conflict` ; les deux
  propositions sont montrées avec leur source ; l'utilisateur choisit ou saisit.
- Même marque, noms différents ⇒ la source prioritaire est proposée, l'autre ignorée (pas de fusion).
- Jamais : nom de A + marque de B ; « vote » ; LLM pour départager.
- Nom et marque restent toujours éditables ; la saisie utilisateur prime et n'est jamais écrasée.

## 12. Architecture cible (proposée, non codée)

```text
App (ProductForm)
  → identify-product (Edge Function, JWT, kill switch, rate limit utilisateur)
      → parse 17.3a + éligibilité (RCN, invalide)
      → cache Recall (table dédiée, non lue par le matching)
      → provider chain (adapters : off, [p]) — entrée = matchingGtin seul
      → normalisation (trim, ASIN/bruit marketplace, placeholders ⇒ vide)
  ← { status, matchingGtin, canonicalGtin14, name, brand, source, sourceUrl, confidence }
```

`status ∈ identified | partial | conflict | unidentified | not_eligible | unavailable`
(`unavailable` = timeouts/quota, distinct d'un vrai `unidentified`). Schéma non figé : la colonne
`confidence` ne doit pas exprimer plus que « source unique » / « deux sources concordantes » tant que
GS1 n'est pas disponible.

## 13. UX cible (proposée, non codée)

```text
SCAN → identité GTIN (immédiate) → ProductForm ouvert tout de suite, champs éditables
     → « Recherche du produit… » (non bloquant)
     → Produit identifié        : nom + marque pré-remplis, « Source : Open Food Facts »
     → Identification partielle : champ(s) trouvés pré-remplis, le reste à saisir
     → Informations contradictoires : deux propositions, choix explicite
     → Produit non trouvé       : saisie manuelle (aucune attente supplémentaire)
```

Le pré-remplissage ne remplace jamais une valeur déjà tapée par l'utilisateur. Aucun état
n'empêche d'enregistrer.

## 14. Latence

| Mesure (poste opérateur, pas la région Edge) | p50    | p95    | max      |
| -------------------------------------------- | ------ | ------ | -------- |
| OFF v3 (118 req, redirections comprises)     | 89 ms  | 159 ms | 1 575 ms |
| UPCitemdb trial (59 req)                     | 329 ms | 421 ms | 588 ms   |

Budget envisagé : cache quasi immédiat ✔ ; fournisseur 1–2 s ✔ réaliste (marge large) ; plafond
total ~5 s ✔. Latence depuis la région Supabase Edge : **UNCONFIRMED**, à mesurer en 17.3c.

## 15. Fail closed

Aucun fournisseur ⇒ nom = manuel, marque = manuel. Le scan reste valide, le GTIN est conservé,
l'ajout du produit et le monitoring Recall ne dépendent jamais du lookup (réseau absent, quota,
timeout, kill switch : même comportement).

Pas d'IA inventive : aucun LLM ne produit de nom ou de marque à partir d'un GTIN ; toute valeur
proposée est attachée à une source et une URL ; en cas de doute ⇒ manuel / conflit.

## 16. Coût estimé (par mois)

Décision de clôture : MVP **OFF seul**, coût fournisseur = **0** (hors miroir de l'export OFF à
grande échelle). Le tableau ci-dessous reste une estimation pour une éventuelle évaluation future
d'un fournisseur payant (NO-GO actuellement).

Hypothèses : `L` = lookups/mois (scans d'un GTIN non encore connu de l'utilisateur) ; `h` = taux de
cache hit ; appels fournisseurs `M = L × (1 − h)` ; OFF en premier (gratuit) ; part transmise au
payant `f = 75 %` (taux not-found OFF mesuré, prudent pour une population non alimentaire).

| L         | h = 50 % : OFF / payant | h = 75 %          | h = 90 %         | UPCitemdb                           | Go-UPC  | EAN-Search                                        |
| --------- | ----------------------- | ----------------- | ---------------- | ----------------------------------- | ------- | ------------------------------------------------- |
| 1 000     | 500 / 375               | 250 / 188         | 100 / 75         | 0 $ (trial, non production) ou 99 $ | 74,95 $ | 19 €                                              |
| 10 000    | 5 000 / 3 750           | 2 500 / 1 875     | 1 000 / 750      | 99 $                                | 74,95 $ | 19 €                                              |
| 100 000   | 50 000 / 37 500         | 25 000 / 18 750   | 10 000 / 7 500   | 99 $                                | 245 $   | 39 €                                              |
| 1 000 000 | 500 000 / 375 000       | 250 000 / 187 500 | 100 000 / 75 000 | 99 $ (≤ 20 000/j)                   | 795 $   | sur devis (h = 50 %) / 149 € (75 %) / 99 € (90 %) |

Remarques :

- OFF est gratuit mais limité à 15 req/min/IP (≈ 650 000/mois théoriques, pics exclus) : au-delà
  d'environ 100 000 lookups/mois, **miroir local de l'export OFF** (recommandé par OFF lui-même) au
  lieu de l'API.
- **Sans cache (requête par scan)** : 1 M scans ⇒ 1 M appels OFF (impossible sous 15/min) et
  750 000 appels payants (UPCitemdb PRO 699 $). Le cache partagé par GTIN est donc obligatoire.
- Prix concurrents = grilles publiques ; leur couverture n'est **pas mesurée**.
- Tavily (si un jour retenu) : ≈ 0,008 $ × appels résiduels, pour une couverture mesurée nulle.

## 17. Points ouverts pour 17.3c

Résolus à la clôture : politique RCN-8 (§3), choix du fournisseur (§0), politique User-Agent (§2).

1. **Revue ODbL** du cache de production : REVIEW REQUIRED (attribution affichée ; obligations
   share-alike d'un cache dérivé).
2. **Vérité terrain physique** : `5400141472714` et `27044193` en attente de confirmation sur
   emballage ; non bloquant pour 17.3c.
3. Migration (table cache + compteurs) et Edge Function `identify-product` : GO séparés, avec
   l'ordre migration → Edge → app (l'app de dev vise la production).
4. Latence depuis la région Edge et comportement des IP sortantes partagées vis-à-vis de la limite
   OFF par IP : UNCONFIRMED.
5. Relire le texte primaire GS1 (§2.1.11–2.1.12) pour la règle RCN-8 ; politique RCN-12/13 non
   décidée.
6. Hors 17.3c : évaluation future GS1 (GS1 Belgium & Luxembourg) ; un éventuel fournisseur payant
   exigerait un benchmark sous clés et des droits de cache écrits, sous GO séparé.

## 18. Décision

**Phase 17.3b : CLOSED.**

**GO 17.3c — OFF-ONLY PRODUCT LOOKUP** : Edge Function `identify-product`, cache non personnel
(métadonnées de licence et d'attribution, sans réponse brute), adapter OFF famille (v3,
`product_type=all`), RCN-8 `not_eligible`, UX non bloquante et fail closed, kill switch, tests de
séparation matching/lookup. Ce périmètre ne dépend d'aucun secret payant et a montré 0 wrong
positive. Chaque écriture production (migration, Edge, app) reste soumise à son propre GO.

**NO-GO** : fournisseur payant, UPCitemdb en production, Tavily / recherche web générique.

Attente honnête : avec OFF seul, la plupart des produits non alimentaires (cœur des rappels CPSC /
Santé Canada) resteront « Produit non trouvé » ⇒ saisie manuelle.
