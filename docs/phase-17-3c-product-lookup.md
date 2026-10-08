# Phase 17.3c — Product lookup OFF-only (nom + marque suggérés dans ProductForm)

Statut : **CLOSED** (2026-10-08) — implémentation locale, tests, documentation. Aucune écriture
production, aucune migration, aucun déploiement Edge, aucun secret créé, aucun fournisseur payant,
aucune build.

Baseline : `HEAD` = `origin/main` = `2b4deb0` (17.3b CLOSED), arbre propre. Décisions 17.3b
reprises sans modification (§0 de `docs/phase-17-3b-product-lookup-benchmark.md`).

## 1. Scope

Le lookup produit **suggère** `name` et `brand` dans `ProductForm` après le scan d'un GTIN
éligible. C'est une aide à la saisie, jamais une preuve.

Open Food Facts n'est **jamais** utilisé comme preuve de : rappel, applicabilité d'un rappel, F-4,
modèle, date, lot, variante, possession, ni pour une décision de sécurité. Le moteur de matching,
F-4, les règles, les scopes et les migrations ne sont **pas modifiés**.

Hors scope : images OFF, catégorie, quantité, autre fournisseur (UPCitemdb, GS1, Tavily, web),
fournisseur payant, cache durable partagé (table), déploiement.

## 2. Architecture

```text
ScanScreen ─(raw + symbology)→ /products/new
  NewProductScreen
    toScannedBarcode()  (17.3a, inchangé)   → matchingGtin, canonicalGtin14
    useProductLookup(matchingGtin)          → idle | loading | found | partial | not_found
                                              | not_eligible | unavailable
      productLookupEligibility()            → RCN-8 / invalide : décidé localement, 0 requête
      lookupProduct()  [cache appareil]     → hit : 0 requête
        └─ functions.invoke('identify-product', { gtin: matchingGtin }, timeout 5 000 ms)
             Edge identify-product (JWT vérifié, kill switch, UA configuré)
               lookupProduct()  [cache mémoire isolate]
                 └─ OFF v3  GET /api/v3/product/{matchingGtin}?product_type=all&fields=…
                            timeout 1 500 ms, 1 tentative, disjoncteur 5 min
  ProductForm
    applyLookupSuggestion()  règle « user input wins »
    notice : chargement / attribution OFF (ODbL + lien) / non trouvé / non éligible / indisponible
```

Un seul orchestrateur (`lookupProduct`) sert aux deux niveaux : côté app avec le cache appareil et
l'Edge comme « fournisseur », côté Edge avec un cache mémoire et l'adapter OFF.

| Fichier                                                       | Rôle                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `supabase/functions/_shared/productLookup/types.ts`           | contrat (statuts, entrée de cache, attribution, licence)             |
| `supabase/functions/_shared/productLookup/eligibility.ts`     | éligibilité, RCN-8, clé de cache                                     |
| `supabase/functions/_shared/productLookup/quality.ts`         | règles qualité nom/marque, hôtes OFF autorisés, attribution          |
| `supabase/functions/_shared/productLookup/openFoodFacts.ts`   | adapter OFF v3, User-Agent, timeout, disjoncteur                     |
| `supabase/functions/_shared/productLookup/cache.ts`           | TTL, validation stricte des entrées, cache mémoire, cache clé-valeur |
| `supabase/functions/_shared/productLookup/lookup.ts`          | orchestrateur + revalidation d'une réponse réseau                    |
| `supabase/functions/_shared/productLookup/handler.ts`         | handler HTTP `identify-product`                                      |
| `supabase/functions/identify-product/index.ts`                | point d'entrée Edge (**non déployé**)                                |
| `src/services/productLookup/index.ts`                         | transport app → Edge, cache appareil, purge à la déconnexion         |
| `src/features/products/productLookupPrefill.ts`               | fusion déterministe dans le formulaire, messages UI                  |
| `src/features/products/ProductForm.tsx`, `ProductScreens.tsx` | intégration UI non bloquante                                         |

### Pourquoi une Edge Function, et pourquoi sans migration

- **Edge** : 17.3b §2 fixe la frontière de confidentialité — OFF voit l'IP Supabase et le GTIN,
  jamais l'IP ni l'inventaire d'un utilisateur. Un appel direct app → OFF aurait exposé l'IP de
  chaque utilisateur avec la liste des GTIN scannés ; cette voie a été écartée. Le code de la
  fonction est écrit et testé ; son déploiement reste un GO séparé.
- **Sans migration** : la table de cache global durable (17.3b §10) n'est pas nécessaire pour
  livrer la fonctionnalité. 17.3c utilise un cache appareil (durable, par appareil) et un cache
  mémoire d'isolate Edge (non durable, partagé entre utilisateurs d'un même isolate). La table
  durable reste une évolution sous GO dédié (§13).

### Séparation lookup / matching (testée)

- aucun fichier de `_shared/matching`, `_shared/recallMatching`, `_shared/productCheck`,
  `_shared/automation`, `process-recall-matches*`, `check-owned-product`,
  `process-owned-product-checks` ni aucune migration ne référence `productLookup`,
  `identify-product` ou `open_food_facts` ;
- `productLookup` n'importe du matching que la primitive GTIN 17.3-S (`matching/gtin.ts`) ;
- rien du lookup n'est persisté avec le produit (`ownedProductsMappers.ts` inchangé) : seules les
  valeurs `name` / `brand` finalement saisies ou acceptées par l'utilisateur sont enregistrées,
  comme avant.

## 3. Fournisseur et API

| Élément        | Valeur                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Fournisseur    | Open Food Facts famille (OFF, Open Beauty Facts, Open Pet Food Facts, Open Products Facts)                          |
| API            | v3 — `GET https://world.openfoodfacts.org/api/v3/product/{gtin}`                                                    |
| `product_type` | `all` (peut rediriger vers la base sœur ; seuls les 4 hôtes `world.open*facts.org` sont acceptés après redirection) |
| `fields`       | `code,product_name,product_name_en,product_name_fr,brands`                                                          |
| Auth           | aucune (lecture) ; pas de cookie, pas de clé                                                                        |
| Timeout        | 1 500 ms côté Edge ; 5 000 ms côté app                                                                              |
| Retry          | aucun ; 1 tentative par lookup                                                                                      |
| Disjoncteur    | 429 ⇒ OFF non appelé pendant 5 min ; 3 échecs consécutifs ⇒ idem                                                    |
| Fallback       | saisie manuelle uniquement ; aucun autre fournisseur                                                                |

## 4. Éligibilité et RCN

Entrée : `ScannedBarcode.matchingGtin` (17.3a), exactement 8, 12, 13 ou 14 chiffres ASCII avec
clé de contrôle valide ; rien n'est tronqué ni complété.

| Cas                                 | Statut                        | Appel OFF | Cache (lecture / écriture)   |
| ----------------------------------- | ----------------------------- | --------- | ---------------------------- |
| GTIN invalide                       | `not_eligible` `invalid_gtin` | 0         | 0 / 0                        |
| **RCN-8** (8 chiffres, préfixe 0/2) | `not_eligible` `rcn_8`        | **0**     | **0 / 0** (appareil et Edge) |
| GTIN-8 hors RCN, GTIN-12/13/14      | éligible                      | ≤ 1       | oui                          |

**`27044193`** (EAN-8 scanné) : `matchingGtin` `27044193`, canonique `00000027044193`, statut
`not_eligible` / `rcn_8`, **0** appel fournisseur, **0** écriture de cache (ni appareil, ni Edge).
Le formulaire affiche « Store-specific barcodes are not looked up. Enter the name and brand
yourself. » ; le GTIN reste dans le formulaire, le produit est enregistrable avec nom/marque
manuels, et le GTIN reste disponible pour les mécanismes Recall existants (17.3a/17.3-S). Le serveur
applique la même règle (défense en profondeur).

La détection se fait sur le GTIN de matching à 8 chiffres, **jamais** sur le GTIN-14 complété de
zéros (décision 17.3b inchangée).

### Relecture du texte primaire GS1 (point ouvert 17.3b §17.5)

GS1 General Specifications, **Release 26.0, ratifiée janv. 2026** (`ref.gs1.org/standards/genspecs`,
PDF lu le 2026-10-08) :

- §1.2.2.2.1 : « RCN-8 is an 8-digit Restricted Circulation Number » ; les RCN « SHALL NOT be used
  globally or in open environments » ;
- Table 1-5 (GS1-8 Prefixes) : `000 – 099` et `200 – 299` = « Used to issue Restricted Circulation
  Numbers within a company » ⇒ la règle `/^[02]/` sur 8 chiffres est **confirmée** ;
- Table 1-4 (GS1 Prefix) : `0000001 – 0000099` = « Unused to avoid collision with GTIN-8 ».

Observation (pas une erreur de 17.3b, aucune décision modifiée) : d'après la Table 1-4, un
GTIN-12/13 alloué correctement ne commence jamais par ces préfixes ; la règle 17.3b (ne pas inférer
depuis le GTIN-14) est donc conservatrice. Une représentation 12/13/14 chiffres équivalente à un
RCN-8 (ex. `00000027044193` saisi tel quel) reste éligible ; elle ne provient pas d'un scan EAN-8
et ne correspond à aucune allocation valide. Durcissement possible plus tard, sous décision
explicite. Politique RCN-12/13 : toujours non décidée.

## 5. Flux

1. Scan valide ⇒ `ProductForm` s'ouvre immédiatement, champs éditables (rien n'attend le lookup).
2. Éligibilité locale (RCN-8 / invalide ⇒ fin, 0 requête).
3. Cache appareil frais ⇒ résultat, **0** appel réseau.
4. Sinon `identify-product` (Edge) : éligibilité serveur ⇒ cache isolate frais ⇒ sinon OFF.
5. `found` (nom + marque) ou `partial` (un seul champ) ⇒ suggestion ; `not_found` ⇒ manuel ;
   `unavailable` ⇒ manuel.
6. L'utilisateur peut modifier, effacer, remplacer, et enregistrer dans tous les cas.

## 6. ProductForm et règle « user input wins »

Règle déterministe (`applyLookupSuggestion`) : une valeur suggérée remplit un champ **seulement
si** :

1. le lookup l'a trouvée (`found` / `partial`, jamais un champ absent) ;
2. le GTIN du formulaire est toujours le GTIN recherché (même GTIN-14 canonique) ;
3. l'utilisateur n'a **pas** touché ce champ depuis l'ouverture du formulaire — même pour le vider ;
4. le champ est vide.

Sinon le champ reste exactement tel quel, quel que soit le moment où la réponse arrive. La fusion
s'exécute dans un updater React (`setValues(current => …)`), donc évaluée contre la dernière valeur,
y compris une frappe encore en file. Elle est idempotente.

Scénario protégé (test I) : scan → lookup lancé → l'utilisateur tape un nom → OFF répond ⇒ le nom
tapé est conservé ; seule la marque, jamais touchée et vide, est suggérée.

UI (une seule ligne sous « Product », aucun écran supplémentaire) :

| État                 | Message                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loading              | « Looking up the product name and brand… »                                                                                                                                             |
| found / partial      | « Suggested from **Open Food Facts** (ODbL). Community data: check it matches your product. » (lien vers la fiche) — affiché tant qu'une valeur suggérée est encore dans le formulaire |
| not_found            | « No product details found for this barcode. Enter the name and brand yourself. »                                                                                                      |
| not_eligible (RCN-8) | « Store-specific barcodes are not looked up. Enter the name and brand yourself. »                                                                                                      |
| unavailable          | « Product lookup is unavailable right now. Enter the name and brand yourself. »                                                                                                        |

La formulation ne présente jamais la donnée comme certaine ni officielle. Le lookup ne concerne que
la création depuis un scan (pas l'édition, pas la saisie manuelle, pas l'OCR).

## 7. Qualité des données

Une réponse OFF n'est utilisée que si :

- HTTP 200, JSON valide, objet `product` présent ;
- le `code` renvoyé a le **même GTIN-14 canonique** que le GTIN demandé ;
- l'hôte final (après redirection `product_type=all`) est l'un des 4 hôtes OFF famille.

Valeur suggérée (nom : `product_name`, puis `_en`, puis `_fr` ; marque : première entrée
utilisable de `brands`) : caractères de contrôle et espaces multiples réduits, 2..200 caractères
(nom) / 2..120 (marque), au moins une lettre, pas un placeholder (`unknown`, `n/a`, `generic`,
`sans marque`…). Jamais tronquée, réparée, fusionnée entre sources ni inventée.

Nom seul ⇒ nom seul ; marque seule ⇒ marque seule ; fiche vide ou placeholders ⇒ `not_found`.
`generic_name` (description, pas un nom) n'est pas utilisé.

## 8. Cache

| Élément              | Valeur                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Clé                  | **GTIN-14 canonique** (`canonicalGtin14`, 17.3-S) + `provider`                                     |
| Contenu              | `schema`, `key`, `provider`, `status`, `name`, `brand`, `attribution`, `fetchedAt`, `expiresAt`    |
| Attribution          | `provider`, `database`, `sourceName`, `sourceUrl` (fiche produit), `license`                       |
| Licence              | `ODbL-1.0` (base), `DbCL-1.0` (contenus), `CC-BY-SA-3.0` (images)                                  |
| TTL                  | positif **30 j**, négatif **7 j**                                                                  |
| Jamais en cache      | timeouts, réseau, HTTP, 429, réponse invalide, kill switch, UA absent, RCN-8, GTIN invalide        |
| Réponse brute OFF    | **non stockée**                                                                                    |
| Données personnelles | aucune : pas de `user_id`, pas de payload ni symbologie de scan                                    |
| Niveau appareil      | `localStorage` (expo-sqlite), clé `recall.productLookup.v1`, ≤ 200 entrées, purgé à la déconnexion |
| Niveau Edge          | mémoire d'isolate, ≤ 500 entrées, non durable                                                      |
| Validation           | toute entrée relue est revalidée (schéma, qualité, attribution) ; invalide ⇒ miss                  |

Choix de clé : 17.3b §3 recommande d'envoyer `matchingGtin` au fournisseur et de garder
`canonicalGtin14` comme clé. `matchingGtin` est ce que Recall stocke (UPC-E déjà développé) ;
`canonicalGtin14` est la primitive d'équivalence unique 17.3-S (app, Edge, SQL). Ainsi un même
produit scanné en EAN-13 ou UPC-A partage la même entrée, et scan → cache → OFF dérivent tous de
`toScannedBarcode()` sans nouvelle normalisation. Le moteur de matching n'est pas modifié.

Un cache appareil purgé à la déconnexion : il ne contient aucune donnée de compte, mais ses clés
révèlent quels codes ont été recherchés depuis l'appareil.

## 9. Modes de défaillance

| Cas                                     | Résultat                                         | Cache | Création produit |
| --------------------------------------- | ------------------------------------------------ | ----- | ---------------- |
| timeout (1,5 s Edge / 5 s app)          | `unavailable` `timeout`/`network`                | non   | possible         |
| DNS / réseau                            | `unavailable` `network`                          | non   | possible         |
| HTTP 5xx / autre                        | `unavailable` `http_error`                       | non   | possible         |
| 429                                     | `unavailable` `rate_limited` + disjoncteur 5 min | non   | possible         |
| JSON invalide, `product` absent, code ≠ | `unavailable` `invalid_response`                 | non   | possible         |
| redirection hors famille OFF            | `unavailable` `invalid_response`                 | non   | possible         |
| 404 / `product_not_found` / fiche vide  | `not_found`                                      | 7 j   | possible         |
| données partielles                      | `partial`                                        | 30 j  | possible         |
| kill switch / UA non configuré          | `unavailable` `disabled`/`not_configured`        | non   | possible         |
| Edge non déployée (état actuel en prod) | `unavailable` `network`                          | non   | possible         |
| exception inattendue                    | `unavailable`                                    | non   | possible         |

Aucun chemin ne lève d'exception vers l'UI ; aucune boucle de retry ; aucun fallback fournisseur.

## 10. User-Agent OFF

Source officielle retenue : introduction de l'API OFF
([openfoodfacts.github.io/openfoodfacts-server/api](https://openfoodfacts.github.io/openfoodfacts-server/api/),
relue le 2026-10-08) : « We ask you to always use a custom User-Agent to identify your app »,
« The User-Agent should be in the form of `AppName/Version (ContactEmail)` ». La même page indique
que les lectures n'exigent pas d'autre authentification, 15 req/min/IP en lecture produit, et v3
« recommended for all new integrations ».

Le tutoriel (URL « if any ») relevé en 17.3b est secondaire ; 17.3c suit la page de référence de
l'API. La proposition 17.3b (`Recall/<version> (https://github.com/…)`) n'est donc pas appliquée
telle quelle ; 17.3b prévoyait déjà « Si OFF demande un contact email, utiliser une adresse de
projet dédiée ».

Implémentation :

- format `Recall/1.0.0 (<contact>)` construit par `offUserAgent()` ;
- `<contact>` = secret Edge `OFF_USER_AGENT_CONTACT` ; **aucune adresse n'est inventée ni
  versionnée** ;
- contact absent, mal formé ou de domaine réservé (`example.*`, `.invalid`, `.test`, `.example`,
  `localhost`) ⇒ UA nul ⇒ OFF **jamais appelé** (`not_configured`) ;
- les tests utilisent `product-lookup-tests@example.invalid`, placeholder volontairement **non
  déployable** (refusé par `offUserAgent`) ;
- jamais l'adresse d'un utilisateur ; aucune donnée Recall dans l'UA.

**Décision requise avant le déploiement Edge** : choisir une adresse de contact **de projet**
(non personnelle) et la poser en secret.

## 11. ODbL et attribution

- Base OFF : ODbL 1.0 ; contenus : DbCL 1.0 ; images : CC BY-SA 3.0
  ([terms-of-use](https://world.openfoodfacts.org/terms-of-use), relu le 2026-10-08). Les CGU
  demandent de mentionner la licence et d'attribuer à Open Food Facts avec un lien vers
  openfoodfacts.org ou la fiche produit.
- Affichage : dans `ProductForm`, « Suggested from Open Food Facts (ODbL) » avec lien vers la fiche
  produit de la base qui a répondu, tant qu'une valeur suggérée est présente.
- Les métadonnées nécessaires (base, nom de source, URL, licences) sont conservées dans chaque
  entrée de cache positive.
- Aucune image OFF n'est utilisée ; si un jour elles l'étaient, attribution CC BY-SA 3.0 requise.
- Non traité ici : afficher la provenance OFF sur la fiche produit enregistrée (nécessiterait une
  colonne de provenance, donc une migration) ; aujourd'hui la valeur enregistrée est celle que
  l'utilisateur a confirmée.

**ODbL production cache compliance = REVIEW REQUIRED.** Cette implémentation n'est pas une
validation juridique (obligations share-alike d'une base dérivée, cache durable partagé).

## 12. Confidentialité et observabilité

- Vers OFF : uniquement le GTIN dans l'URL + `Accept` + `User-Agent` projet. Pas de cookie, de
  clé, d'utilisateur, d'appareil, d'inventaire, de lot, de série, de date (testé).
- Vers l'Edge : `{ "gtin": "<matchingGtin>" }` exactement (toute autre clé ⇒ 400) + JWT de session.
  Le JWT sert uniquement à refuser les appelants anonymes ; l'identifiant utilisateur n'est ni
  utilisé, ni stocké, ni journalisé, ni transmis (testé).
- Aucun log ajouté (ni app, ni Edge).
- Cache appareil purgé à la déconnexion.

## 13. Déploiement (non effectué) et suites

État production : **inchangé**. Tant que l'Edge n'est pas déployée, un build servant ce JS
afficherait « Product lookup is unavailable right now » après un scan éligible ; la création de
produit fonctionne normalement (aucune dépendance base de données).

Ordre recommandé, chaque étape sous son propre GO :

1. décider l'adresse de contact projet (UA) ;
2. secrets Edge `OFF_USER_AGENT_CONTACT`, puis `PRODUCT_LOOKUP_ENABLED=true` ;
3. déployer `identify-product` ; mesurer la latence depuis la région Edge (17.3b §17.4) ;
4. servir le JS app.

Évolutions sous GO séparé : table de cache durable partagée (+ RLS, rétention, revue ODbL) ;
limitation de débit par utilisateur (compteurs) ; politique RCN-12/13.

## 14. Tests

`npm run test:phase-17-3c` (inclus dans `test:node` / `test:deno`, donc dans `check:all`) :

| Test                    | Couvre                                                                            |
| ----------------------- | --------------------------------------------------------------------------------- |
| A found                 | nom + marque suggérés, attribution, requête OFF exacte (GTIN + UA seuls)          |
| A redirect / UPC-E      | base sœur attribuée ; UPC-E ⇒ UPC-A envoyé, clé GTIN-14                           |
| B not found             | 404 / fiche vide / placeholders ⇒ `not_found`, cache négatif 7 j, manuel          |
| C failures              | 9 modes ⇒ `unavailable`, jamais en cache, jamais levé ; produit enregistrable     |
| C circuit               | 1 tentative ; 429 ou 3 échecs ⇒ 5 min sans appel                                  |
| D cache hit             | 0 appel OFF (positif, négatif) ; cache appareil, entrées corrompues, borne, purge |
| E expired               | 30 j / 7 j ⇒ nouvel appel autorisé                                                |
| F RCN-8 `27044193`      | `not_eligible`, 0 appel, 0 lecture/écriture cache (app et Edge), saisie manuelle  |
| F représentation        | RCN décidé sur 8 chiffres, jamais sur GTIN-14                                     |
| G partiel / qualité     | nom seul, marque seule ; règles qualité                                           |
| H édition utilisateur   | jamais réécrite, même vidée ; attribution retirée                                 |
| I async                 | réponse après saisie ⇒ saisie conservée ; GTIN changé ⇒ rien appliqué             |
| Edge handler            | 405/401/400, kill switch, UA absent, aucune donnée utilisateur vers OFF           |
| User-Agent              | format ; refus des contacts absents/réservés/URL                                  |
| Séparation              | matching / productCheck / automation / SQL ne référencent pas le lookup           |
| Deno `identify-product` | point d'entrée : POST + bearer, aucun appel OFF sans configuration                |

## 15. Limites connues

- Couverture OFF faible hors alimentaire (17.3b : 0/10 non-alimentaire EU hors cosmétique) : la
  plupart des produits des scopes de rappel resteront « non trouvé » ⇒ saisie manuelle.
- Pas de cache durable partagé : chaque appareil et chaque isolate Edge ont le leur ; limite OFF de
  15 req/min par IP de sortie Edge, partagée entre utilisateurs (comportement des IP sortantes :
  UNCONFIRMED).
- Pas de limitation de débit par utilisateur (nécessiterait une table).
- Représentations 12/13/14 chiffres équivalentes à un RCN-8 non classées RCN (§4).
- Vérité terrain physique `5400141472714` / `27044193` toujours en attente (17.3b).
- Fonctionnalité inactive en production jusqu'au GO de déploiement Edge.
