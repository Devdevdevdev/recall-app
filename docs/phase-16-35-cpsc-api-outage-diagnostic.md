# Phase 16.35 — CPSC API outage diagnostic

Date : 2026-10-02 (tests entre 18:35:55 et 18:41:27 UTC)
Périmètre : diagnostic **entièrement en lecture seule**. Aucune écriture Supabase, aucun tick, aucun appel à nos Edge Functions, aucun deploy, aucun changement de secret ou de watermark, aucun commit.

Légende : **[FAIT]** observé directement · **[HYPOTHÈSE]** non démontrée · **[CONCLUSION]** déduite des faits cités.

## Executive summary

- **[FAIT]** Depuis ce poste, toute requête `RestWebServices/Recall` qui contient un **paramètre de date** (`LastPublishDateStart/End` ou `RecallDateStart/End`) reçoit un **HTTP 503** sous la forme d'une page statique « Page Unavailable » servie par **`AkamaiNetStorage`**. C'est vrai sur toutes les fenêtres testées, y compris janvier 2024, en IPv4 comme en IPv6, en JSON comme en XML, et même avec une valeur de date invalide.
- **[FAIT]** Le même endpoint **sans** paramètre de date répond **200** depuis l'origine (`Microsoft-IIS/10.0`) : jeu complet, `RecallNumber=`, `RecallTitle=`. La page d'aide et les fichiers statiques répondent aussi.
- **[FAIT]** Le `source_http_502` enregistré dans `recall_source_sync_state` est **notre propre code de statut** : `ingest-recall-source` renvoie 502 pour _tout_ échec de récupération, et `ingest-recall-sources` enregistre ce statut. Ce n'est pas le statut renvoyé par CPSC.
- **[CONCLUSION]** La cause la plus probable est une **panne partielle côté CPSC** : le chemin des filtres de date de l'API est cassé, que ce soit à l'origine ou par une règle Akamai. Ce n'est ni une panne générale, ni un blocage propre aux IP Supabase, ni un défaut de notre client. Confiance : **élevée**.
- **[FAIT]** Le jeu complet CPSC lu à 18:41 UTC contient 10 027 recalls, dont la `LastPublishDate` la plus récente est le **2026-09-24**, et **0** recall a une `LastPublishDate` ≥ 2026-09-29. **Aucun recall CPSC n'est donc manqué à ce stade.**
- **[CONCLUSION]** Le code de Recall n'est pas la cause, mais trois **défauts latents** apparaissent :
  1. Le statut amont est masqué.
  2. Un backlog qui dépasse la limite de 50 enregistrements par source bloque CPSC en échec, avec le même code d'erreur.
  3. La fenêtre plafonnée à 31 jours crée une **perte silencieuse** si la panne dure au-delà du 2026-10-31.

## Timeline

| UTC                 | Événement                                                                          | Source             |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| 2026-09-24          | Dernière `LastPublishDate` présente dans le jeu CPSC (11 recalls)                  | GET complet 18:41  |
| 2026-10-01 (jeudi)  | Jour de publication hebdomadaire habituel ; **aucun** recall daté du 01/10 visible | GET complet 18:41  |
| 2026-10-02 00:17:03 | Dernier succès CPSC : `ingest-recall-source` 200 en 663 ms, fenêtre 09-29 → 10-02  | edge logs + DB     |
| 2026-10-02 06:17:05 | `ingest-recall-source` **502** en 1 818 ms ; Health Canada 200                     | edge logs          |
| 2026-10-02 12:17:07 | `ingest-recall-source` **502** en 1 706 ms ; Health Canada 200                     | edge logs          |
| 2026-10-02 18:17:03 | `ingest-recall-source` **502** en 801 ms ; Health Canada 200 (10 insérés)          | edge logs + DB     |
| 2026-10-02 18:35:55 | Premier GET local avec filtre de date : 503 Akamai                                 | matrice ci-dessous |
| 2026-10-02 18:41:27 | GET complet sans filtre : 200, 27,7 Mo, 10 027 recalls                             | matrice ci-dessous |

**[HYPOTHÈSE]** La panne du filtre de date a commencé entre 00:17 et 06:17 UTC le 02/10. Cela repose uniquement sur nos runs, et rien ne prouve que l'échec de 06:17 avait exactement la même forme qu'aujourd'hui.

## Recall CPSC request contract

Code déployé lu en lecture seule avec `get_edge_function` : `ingest-recall-source` v15 et `ingest-recall-sources` v12. **[FAIT]** `cpsc/client.ts`, `cpsc/adapter.ts` et `cpsc/validation.ts` déployés sont **identiques octet pour octet** à la copie locale. Les seuls écarts concernent `ingest-recall-source/index.ts` et `recallSources/validation.ts` (garde de watermark, Phase 16.17) et ne touchent pas la récupération.

| Élément             | Valeur exacte                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint            | `https://www.saferproducts.gov/RestWebServices/Recall` (`CPSC_API_ROOT`)                                                                         |
| Méthode             | `GET` (défaut de `fetch`)                                                                                                                        |
| Paramètres          | `format=json`, `LastPublishDateStart=<startDate>`, `LastPublishDateEnd=<endDate>` (YYYY-MM-DD)                                                   |
| Headers             | `accept: application/json` uniquement (User-Agent par défaut de Deno)                                                                            |
| Timeout             | 15 000 ms (`AbortController`) → `CPSC request timed out.`                                                                                        |
| Redirects           | Comportement par défaut de `fetch` : `redirect: 'follow'` (aucun redirect observé)                                                               |
| Taille max          | 8 Mio (`content-length`, puis taille réelle) → `CPSC response exceeded the allowed size.`                                                        |
| Non-2xx             | `throw new Error('CPSC returned HTTP <status>.')`                                                                                                |
| Forme               | Doit être un tableau JSON, sinon erreur                                                                                                          |
| Limite d'adaptateur | `records.length > maxRecords` → `CPSC response exceeds the bounded automation record limit.`                                                     |
| Mapping HTTP        | **Toute** exception de `adapter.retrieve` → `ingest-recall-source` répond **502** `{error: <message>}` et enregistre `retrieval_failed`          |
| Mapping parent      | `ingest-recall-sources` ignore le corps et enregistre `source_http_${status de l'enfant}` = **`source_http_502`**, qui écrase `retrieval_failed` |

Fenêtre réellement demandée (`ingest-recall-sources` v12) :

- `endDate` = `window_end` du run = `least(today, global_watermark + catch_up_days)` = **2026-10-02**.
- `startDate` = `max(endDate − 30, cpsc_watermark − 2)` = `max(2026-09-02, 2026-09-30)` = **2026-09-30**.
- `maxRecords` CPSC = `floor(max_recalls / sources actives)` = `floor(100 / 2)` = **50**.

**[FAIT]** La requête réelle des trois échecs était donc `LastPublishDateStart=2026-09-30&LastPublishDateEnd=2026-10-02`, et non 10-02 → 10-02. Les deux variantes ont été testées.

## External test matrix

Depuis ce poste, curl, un seul GET par ligne, sans retry. Les edges Akamai résolus sont `e2435.dscb.akamaiedge.net` → `2a02:26f0:3900:583::983`, `2a02:26f0:3900:587::983` et `23.216.248.12`.

| #   | UTC      | Requête (`/RestWebServices/...`)                                     | HTTP    | Server             | Content-Type     | Taille         | Durée  |
| --- | -------- | -------------------------------------------------------------------- | ------- | ------------------ | ---------------- | -------------- | ------ |
| A   | 18:35:55 | `/` (page d'aide)                                                    | 200     | Microsoft-IIS/10.0 | text/html        | 21 007         | 0,77 s |
| B   | 18:36:17 | `Recall?format=json`                                                 | 200     | Microsoft-IIS/10.0 | application/json | tronqué à 2 Mo | 0,59 s |
| B'  | 18:41:27 | `Recall?format=json` (complet)                                       | 200     | Microsoft-IIS/10.0 | application/json | 27 696 520     | 2,05 s |
| C   | 18:35:55 | `Recall?format=json&LastPublishDateStart=2026-10-02&…End=2026-10-02` | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,49 s |
| C'  | 18:35:56 | `…LastPublishDateStart=2026-09-30&…End=2026-10-02` (requête réelle)  | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,31 s |
| C4  | 18:36:18 | C en IPv4 forcé (`23.216.248.12`)                                    | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,47 s |
| Cx  | 18:36:18 | C en `format=xml`                                                    | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,23 s |
| D   | 18:35:56 | `…LastPublishDateStart=2026-10-01&…End=2026-10-01`                   | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,22 s |
| H1  | 18:36:36 | `…LastPublishDateStart=2024-01-01&…End=2024-01-31`                   | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,22 s |
| H2  | 18:36:36 | `…LastPublishDateStart=2026-09-01&…End=2026-09-01`                   | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,18 s |
| S1  | 18:36:36 | `…LastPublishDateStart=2026-10-01` seul                              | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,21 s |
| E1  | 18:36:36 | `…LastPublishDateEnd=2026-10-02` seul                                | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,20 s |
| R1  | 18:36:37 | `…RecallDateStart=2026-09-01&RecallDateEnd=2026-10-02`               | **503** | AkamaiNetStorage   | text/html        | 4 112          | 0,21 s |
| N1  | 18:40:51 | `…RecallNumber=24001&LastPublishDateStart=2023-01-01`                | **503** | AkamaiNetStorage   | —                | —              | —      |
| N2  | 18:40:52 | `…RecallNumber=24001&LastPublishDateStart=notadate`                  | **503** | AkamaiNetStorage   | —                | —              | —      |
| N3  | 18:40:53 | `…RecallNumber=24001&RecallDateStart=2023-10-01&RecallDateEnd=…31`   | **503** | AkamaiNetStorage   | —                | —              | —      |
| Rn  | 18:36:18 | `Recall?format=json&RecallNumber=24001`                              | 200     | Microsoft-IIS/10.0 | application/json | 3 521          | 0,24 s |
| T1  | 18:36:37 | `Recall?format=json&RecallTitle=crib`                                | 200     | Microsoft-IIS/10.0 | application/json | 588 965        | 0,32 s |
| Css | 18:36:19 | `Content/site.css`                                                   | 200     | Microsoft-IIS/10.0 | text/css         | 19 652         | 0,20 s |

Aucun redirect sur l'ensemble des appels.

Pour les lignes N1 à N3, seul le header `server` a été relevé : il identifie à lui seul la page de secours.

Les 503 portent tous les mêmes éléments :

- **Headers :** `etag: "d0d806ab41e622329a7fad0fa696324a:1727265427.848737"`, `last-modified: Wed, 25 Sep 2024 11:57:07 GMT` et `cache-control: max-age=0, no-cache, no-store`.
- **Corps :** UTF-16 LE, identique octet pour octet entre C et D. Il contient le titre « Under Construction » et le texte « SaferProducts.Gov — Page Unavailable. The page you are trying to reach is currently unavailable. Please double check your link and then try this link again soon. If you continue to get this error, you can report it to us at info@cpsc.gov. »

## Official documentation

- **[FAIT]** La [page API de CPSC](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information) donne toujours `https://www.saferproducts.gov/RestWebServices/Recall` et `?format=json` comme endpoint. Elle ne mentionne ni maintenance, ni dépréciation, ni changement de domaine.
- **[FAIT]** Le [Programmer's Guide v1.4 du 17/09/2018](https://cpsc.gov/s3fs-public/RecallRetrievalWebServicesProgrammersGuide20180917.pdf), dernière version publiée :
  - il fixe la racine à `https://www.saferproducts.gov/RestWebServices/Recall` ;
  - il liste `RecallDateStart`, `RecallDateEnd`, `LastPublishDateStart` et `LastPublishDateEnd` comme paramètres supportés ;
  - son code d'exemple formate les dates en `yyyy-MM-dd` ;
  - il avertit qu'un paramètre inconnu renvoie **tous** les recalls.
  - **[CONCLUSION]** Nos noms de paramètres et notre format de date sont conformes.
- **[FAIT]** La [FAQ développeurs de SaferProducts.gov](https://www.saferproducts.gov/FAQs/FrequentlyAskedQuestions11) ne mentionne ni limite, ni maintenance.
- **[FAIT]** Une recherche web ne fait ressortir aucun avis public de panne ou de maintenance pour octobre 2026. Un tiers signale seulement, le 2026-09-04, que le paramètre `Hazard` ne filtre rien, ce qui est sans rapport.
- **[FAIT]** Aucune limitation de débit n'est documentée.

## 502 provenance

1. **[FAIT]** Le 502 visible dans les logs edge provient de `ingest-recall-source` (fonction `860062c5…`, v15), ligne `return json(502, …)` du bloc `catch` de récupération.
2. **[FAIT]** `source_http_502` est construit par `ingest-recall-sources` à partir du **statut de la fonction enfant**. Le corps, qui contenait le message réel (vraisemblablement `CPSC returned HTTP 503.`), n'est ni enregistré ni loggé. Le statut CPSC d'origine est donc **perdu**.
3. **[FAIT]** Les durées des trois échecs (1 818, 1 706 et 801 ms) incluent les RPC de vérification d'activation et d'écriture d'état. Elles sont très loin du timeout de 15 s.
4. **[CONCLUSION]** Le timeout est exclu.
5. **[CONCLUSION]** Le dépassement de `maxRecords` est exclu : 0 recall n'a une `LastPublishDate` ≥ 2026-09-29, donc une réponse saine aurait été `[]`, et une liste vide ne déclenche aucune erreur.
6. **[CONCLUSION]** Le dépassement de taille et l'erreur de forme sont exclus pour la même raison.
7. **[CONCLUSION]** La seule branche compatible avec un échec rapide est la branche **non-2xx**. Combiné à la reproduction locale déterministe, cela indique avec une confiance élevée que le runtime Supabase a reçu la même page de secours Akamai **503**.
8. **[HYPOTHÈSE]** Le statut exact vu par Supabase (503 ou autre 5xx) ne peut pas être prouvé en lecture seule, puisque le message n'est conservé nulle part.

## Network evidence

- **[FAIT]** L'échec se reproduit depuis un réseau sans aucun lien avec Supabase, sur deux edges Akamai IPv6 distincts et sur un edge IPv4.
- **[FAIT]** Sur le **même hôte**, les **mêmes edges** et dans les **mêmes secondes**, les requêtes sans paramètre de date réussissent depuis l'origine IIS.
- **[FAIT]** La simple présence d'un paramètre de date suffit à provoquer l'échec, même avec une valeur invalide (`notadate`) et même combinée à un filtre très étroit (`RecallNumber=24001`).
- **[CONCLUSION]** L'échec dépend du **paramètre**, pas du réseau ni de l'IP source. Il n'est pas nécessaire de supposer un blocage des IP Supabase ou un problème régional pour expliquer les observations, et l'hypothèse d'un blocage spécifique à Supabase devient **peu plausible**.
- **[HYPOTHÈSE, non testée]** Les edges Akamai américains pourraient se comporter différemment. Aucun test n'a été fait depuis les États-Unis ni depuis la région Supabase, faute de pouvoir le faire sans appeler la production.
- **[HYPOTHÈSE]** Deux mécanismes restent possibles côté CPSC, sans que ce test permette de les départager :
  1. L'origine plante sur le chemin « filtre de date », peut-être avant même de valider la valeur, et Akamai sert alors sa page de secours.
  2. Une règle Akamai intercepte ces paramètres.

## Recall-specific code review

| Point                         | Constat                                                                                                                                                                                                               | Cause des 502 ?              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Endpoint, paramètres, format  | Conformes au guide officiel v1.4                                                                                                                                                                                      | Non                          |
| Headers                       | `accept: application/json` seul ; un GET local avec le même header échoue de la même façon                                                                                                                            | Non                          |
| Masquage du statut amont      | Tout échec de récupération devient 502, puis `source_http_502` ; le message est perdu et `retrieval_failed` est écrasé                                                                                                | Non (défaut d'observabilité) |
| Limite de backlog             | `records.length > maxRecords` (50) déclenche une exception, donc le même `source_http_502`. La fenêtre ne fait que s'agrandir jusqu'au plafond, ce qui produit un **échec persistant indiscernable** d'une panne CPSC | Non (défaut latent)          |
| Plafond de fenêtre à 31 jours | `startDate = max(endDate − 30, watermark − 2)` : au-delà de 31 jours, le début est avancé **sans erreur**, puis le watermark saute à `endDate` en cas de succès, ce qui crée un **trou silencieux**                   | Non (défaut latent, perte)   |
| Taille max 8 Mio              | Le jeu non filtré pèse 27,7 Mo : un repli « tout télécharger puis filtrer » est impossible sans changer le code                                                                                                       | Non                          |

**[CONCLUSION]** Le client CPSC n'a aucun défaut qui expliquerait les trois échecs. Les trois défauts latents ci-dessus aggravent en revanche le diagnostic et le risque de rattrapage.

## Safety and data-loss impact

- **[FAIT]** Pendant la panne, aucun nouveau recall CPSC n'entre dans Recall, donc aucune alerte ni aucun push n'est possible pour un produit américain concerné par un recall CPSC récent.
- **[FAIT]** Aujourd'hui, l'exposition réelle est **nulle** : à 18:41 UTC, CPSC n'a publié aucun recall avec une `LastPublishDate` ≥ 2026-09-29, et tout ce qui est antérieur est couvert par le watermark 2026-10-02 et le chevauchement de deux jours.
- **[FAIT]** Le watermark CPSC est **gelé** à 2026-10-02 (`last_status = failed`, sans régression) et l'état global avance grâce à Health Canada. Rien n'est perdu tant que la fenêtre reste ≤ 31 jours et le backlog ≤ 50.
- **[HYPOTHÈSE]** Le prochain lot hebdomadaire CPSC, attendu le jeudi 2026-10-08 si le lot du 01/10 a été sauté ou retardé, sera la première exposition réelle.

## Catch-up / backlog analysis

Paramètres effectifs en production (lecture DB) : `max_recalls_per_run = 100`, `catch_up_days = 7`, `overlap_hours = 48`, 2 sources actives, soit **50** enregistrements par source. Watermark CPSC : **2026-10-02**.

Volume CPSC observé dans le jeu complet (comptes par `LastPublishDate` actuelle, donc une borne basse indicative) :

- Rythme hebdomadaire le jeudi : 13, 12, 14 et 11 recalls les 03, 10, 17 et 24/09.
- Fenêtres de 31 jours : 44, 55, 81 et 50 (de juin à septembre 2026).
- Maximum glissant en 2026 : **59 sur 7 jours** (fin février) et **132 sur 31 jours**.

| Durée de panne                      | Fenêtre CPSC au retour        | Backlog estimé                              | Comportement actuel                                                                                                               |
| ----------------------------------- | ----------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Quelques jours                      | 09-30 → J, moins de 10 jours  | environ 0 à 25                              | Rattrapage automatique en une requête ; le watermark saute à J                                                                    |
| Environ 1 à 4 semaines              | ≤ 31 jours                    | environ 12 à 55 (pire : plus de 59/semaine) | **Au-delà de 50 : échec persistant** `source_http_502`, indiscernable d'une panne CPSC, même après le retour de l'API             |
| Run avec `endDate` ≥ **2026-11-01** | début avancé à `endDate − 30` | —                                           | **Trou silencieux** : les `LastPublishDate` 09-30 et 10-01, puis chaque jour qui sort de la fenêtre, ne sont plus jamais demandés |
| Au plafond de 31 jours              | 31 jours glissants            | 44 à 132 historiquement                     | Échec probable tant que le volume sur 31 jours dépasse 50 ; trou silencieux en cas de succès                                      |

**[CONCLUSION]** Une panne courte ne présente aucun risque. Au-delà d'environ 3 à 4 semaines (moins si l'activité est forte), le rattrapage **échouerait de lui-même** par dépassement de la limite à 50, avec un code d'erreur qui ne le révèle pas. À partir du 2026-11-01, la récupération deviendrait **lossy sans signal**.

## Possible mitigations

Aucune n'est appliquée. Toutes relèveraient d'une phase séparée, avec un GO.

1. **Attendre et surveiller.** Refaire un GET local passif de la requête C' avant les runs, et suivre `last_successful_sync_at`. Coût nul.
2. **Observabilité.** Propager le statut et la cause amont, par exemple `source_upstream_503`, `source_record_limit_exceeded` ou `source_timeout`, au lieu de `source_http_502`, et ne plus écraser `retrieval_failed`.
3. **Garde anti-trou.** Refuser le plafonnement quand `endDate − 30 > watermark − 2`, en signalant une erreur explicite (par exemple `source_window_gap`) au lieu d'avancer le début en silence.
4. **Rattrapage borné.** Découper la fenêtre en sous-fenêtres (par jour ou par semaine), dont chacune tient sous la limite, et faire avancer le watermark progressivement. Ou bien allouer la limite par source selon le besoin plutôt que 100/2.
5. **Repli sans filtre de date.** Si le filtre renvoie 5xx, télécharger le jeu complet (27,7 Mo, environ 2 s) et filtrer sur `LastPublishDate` localement, comme le fait déjà Health Canada (limite de 24 Mio). Il faudrait relever la limite au-delà de 32 Mio et évaluer la mémoire de l'edge et la politesse envers CPSC.
6. **Alerte opérateur** après N échecs CPSC consécutifs, par exemple 4, soit 24 h.
7. **Signalement à CPSC** (`info@cpsc.gov`, adresse indiquée sur la page d'erreur). C'est une action externe qui relève de votre décision.

## Recommendation

- **Maintenant :** aucun changement en production. Le backlog réel est nul et le rattrapage sera automatique si l'API revient dans les prochains jours.
- **Surveillance :** les runs de 00:17, 06:17, … suffisent. Un GET local passif de la requête C' peut confirmer le retour de l'API sans toucher à la production.
- **Si la panne dépasse environ 5 à 7 jours :** ouvrir une phase de code dédiée, sans urgence de production, qui couvrirait dans l'ordre les mitigations 3 (perte silencieuse), 2 (diagnostic), 4 (rattrapage) puis, éventuellement, 5.
- **Facultatif :** décider si vous voulez signaler la panne à `info@cpsc.gov`.

## Classification

**1 — Panne côté API CPSC, partielle**, limitée au chemin des filtres de date (`LastPublishDate*` et `RecallDate*`). Ce n'est pas une panne générale : l'endpoint répond sans filtre de date.

- **2 (réseau/régional)** : non nécessaire pour expliquer les observations ; non testé depuis les États-Unis.
- **3 (spécifique au runtime Supabase)** : peu plausible, l'échec se reproduit hors de Supabase.
- **4 (défaut du client Recall)** : non pour la cause, mais trois défauts latents ont été identifiés (statut masqué, blocage au-delà de 50 enregistrements, trou silencieux au-delà de 31 jours).

Confiance dans la cause : **élevée**. Le statut exact vu par Supabase n'est pas prouvable en lecture seule.

## Production changes

NONE
