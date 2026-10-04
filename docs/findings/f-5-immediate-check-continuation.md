# F-5 — La vérification immédiate peut exiger une nouvelle action de premier plan après une continuation

**Statut :** **ouvert, non bloquant.** Il n'y a aucune conséquence de sûreté, aucune perte de
données et aucun retraitement. Suivi dans `docs/phase-17-7a-1-release-gate.json` (`tracked`,
`blocksThisPhase: false`).

**Découvert :** test T3 de Phase 17.7, en production, le 2026-10-04.

**Classification :** UX, latence et ergonomie de complétion. Ce n'est **pas** un problème de
sûreté ni de perte de données, et ce n'est **pas** bloquant pour la production.

## Constat

Le produit T3 avait **36 candidats**, tous de **rang 1** (signal faible : titre, marque ou nom
seulement). `max_product_check_candidates` vaut **25**.

| Appel                          | Ce qui s'est passé                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (à l'enregistrement)         | `claimed/user` ; 25 candidats examinés ; issue `continue` ; curseur durable enregistré ; `attempts` remis à 0 ; HTTP 200 en 2936 ms. La tâche revient en `pending`, état affiché `pending_check`.         |
| 2 (focus de l'onglet Products) | `claimed/user` ; reprise **exacte** après le 25ᵉ candidat ; **11** candidats examinés, aucun des 25 premiers rejoué ; `completed/user` ; `completed_revision` 1 ; état final `monitored_no_known_recall`. |

**Ce qui fonctionne comme prévu :**

- aucune perte : le curseur est durable et la tâche reste due ;
- aucun retraitement : les 25 + 11 candidats sont examinés chacun une seule fois ;
- une `continue` ne consomme pas le budget de retry (`attempts` est remis à 0) ;
- aucune conséquence de sûreté : 0 évaluation, 0 alerte, porte et F-4 inchangées.

**Le problème :** entre les deux appels, l'utilisateur reste sur « Saved — checking known
recalls… » jusqu'à l'un de ces trois événements :

- un nouveau focus de l'onglet Products (l'app relance au plus 3 produits en `pending_check`) ;
- le passage du worker au prochain cron : au plus 3 produits par run, toutes les 6 h ;
- une modification d'un attribut pertinent du produit.

## Décision pour Phase 17.7

**Le budget reste `max_product_check_candidates = 25`.** Il n'y a aucun tuning de production dans
la Phase 17.7.

**Pourquoi :**

- Les mesures de T3 (environ 2,5 s pour 25 candidats, environ 1,1 s pour 11) décrivent le
  comportement actuel. Elles **ne garantissent pas** le coût dans le pire cas pour 100 candidats.
- Ce budget est **partagé** avec le worker : l'augmenter accroît aussi sa charge par produit.
- Il n'y a aucun réglage de production sans benchmark dédié.

## Design proposé pour 17.7b (non implémenté)

**Solution préférée : auto-continuation bornée sur le chemin immédiat.**

Quand `check-owned-product` se termine sur une issue `continue`, le chemin immédiat relance la
vérification, avec des bornes. Le budget de 25 reste le garde-fou **par page**.

**Contraintes à respecter :**

- **Plafond :** 1 ou 2 continuations automatiques au maximum par demande utilisateur, jamais de
  boucle illimitée.
- **Budget temps global** côté utilisateur : il englobe toutes les pages. Le délai de 15 s par
  page et le bail de 120 s restent en place.
- **Respect du curseur serveur :** la reprise passe toujours par `claim_owned_product_recall_check`.
  Le client ne choisit jamais de position.
- **`attempts` :** une `continue` ne l'incrémente pas, ce qui est déjà le cas. Une
  auto-continuation ne doit pas changer cela.
- **Conditions d'arrêt :**
  - `complete` ;
  - un état final (`monitored_no_known_recall`, `possible_match_needs_verification`,
    `recall_detected`) ;
  - `retry` ou erreur ;
  - `busy`, `not_due` ou `rate_limited` ;
  - le budget de temps ou le plafond de continuations atteint.
- **Le cron reste le filet durable :** toute tâche encore `pending` est reprise par le worker.
- Aucun changement de F-4, de la porte ni de l'allowlist v2. **Aucune IA.**

**Deux emplacements à comparer :**

| Emplacement    | Principe                                                                                                               | À vérifier                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Serveur** | Le handler `check-owned-product` enchaîne au plus N pages dans le même appel, en re-réclamant après chaque `continue`. | Le temps total doit rester sous la limite de durée Edge et sous ce que l'app attend.                                                                      |
| **B. App**     | Le client rappelle `check-owned-product` au plus N fois quand la réponse est `pending_check` juste après un passage.   | Plus simple côté serveur, mais il faut distinguer « en continuation » de « jamais vérifié ». La réponse doit l'indiquer, par exemple avec un champ borné. |

**À évaluer séparément, plus tard :** réduire au pré-filtre les candidats de **rang 1 seuls**.
Dans T3, ces 36 candidats ont tous été écartés sans persistance, mais ils ont consommé le budget.
Toute modification du pré-filtre doit garder la parité avec `get_recall_candidates`, déjà testée en
pgTAP.

## Preuves

- Enregistrement : `releases/phase-17-7a-1/post-install-verification.json`, champ
  `t3ImmediatePath`.
- Rapport : [phase-17-7a-production-verification.md](../phase-17-7a-production-verification.md),
  §T3.
