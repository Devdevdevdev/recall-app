# F-1 — `needs_review` sans budget IA : fingerprint final qui bloque la réévaluation prévue

**Statut :** ouvert, documenté. **Non corrigé**, et volontairement séparé de Phase 17.7a.
**Découvert :** audit Phase 17.7a, le 2026-10-02.
**Gravité :** moyenne. Aucune fausse alerte possible (le défaut ne crée jamais d'alerte), mais des
faux négatifs silencieux sont possibles.

## Fichiers concernés

- `supabase/functions/_shared/recallMatching/orchestrator.ts`, dans la branche
  `deterministic.decision === 'needs_review'` :
  - quand `nebiusCalls >= limits.maxNebiusCalls`, l'orchestrateur marque le recall
    `unresolved: 'limit'` ;
  - puis il appelle quand même `finalizePair` avec l'évaluation déterministe et le fingerprint
    canonique.
- `supabase/functions/_shared/recallMatching/fingerprint.ts` : le fingerprint contient déjà les
  versions `hybrid_guarded_v1`, prompt et `modelId`. Il est donc identique avec ou sans escalade.
- `public.claim_recall_match_evaluation` (`20260914110000_…_fix_matching_rpc_ambiguity.sql`)
  renvoie `unchanged` dès qu'un `recall_matches` porte le même fingerprint.
- Contrat 16.33 concerné : `record_recall_automation_matching_outcome`, qui retient le recall
  `limit` pour qu'il soit retenté.

## Reproduction

Test local : `tests/finding-f1-ai-budget-fingerprint-freeze.test.mjs`. Il passe : il épingle le
comportement actuel.

1. Paire « modèle exact sans nom compatible » : `deterministic_v1` donne `needs_review`.
2. Run 1 avec `maxNebiusCalls = 0` :
   - `needsReview = 1` et `unresolvedRecalls = [{ reason: 'limit' }]` ;
   - mais la paire est finalisée en `needs_review/deterministic_v1` avec le fingerprint
     canonique.
3. Run 2 avec `maxNebiusCalls = 5` :
   - le claim répond `unchanged` ;
   - `nemotronEscalated = 0` et l'évaluateur n'est jamais créé ;
   - le recall est déclaré **résolu**, donc il sort de `pending_recalls`.

## Impact

- Toute paire `needs_review` rencontrée après l'épuisement du budget IA d'un run (5 escalades par
  run en production) ne reçoit jamais l'escalade hybride gardée, tant que ni le produit ni l'avis ne
  changent.
- Sur le holdout Phase 9.1, cette escalade porte le rappel strict de 66,7 % à 100 %, avec 0 faux
  positif. La perte est donc potentiellement significative.
- La rétention 16.33 de la raison `limit` est inopérante pour ce cas : le cycle suivant résout le
  recall au lieu de le retenter.
- Production au 2026-10-02 : 0 produit, 0 match. Aucun impact réalisé.

## Correction envisagée (phase dédiée, à concevoir)

**Piste préférée.** Quand l'escalade est éligible mais non exécutée faute de budget, ne pas
finaliser la paire :

- libérer le bail par une RPC dédiée ;
- garder le recall non résolu (`limit`) ;
- le run suivant évalue alors réellement la paire.

**Alternative.** Inclure dans le fingerprint un marqueur « escalade tentée / non tentée ». Cela
change les fingerprints Phase 16 : il faut donc une politique versionnée et une réévaluation
contrôlée.

**Tests à ajouter :**

- inversion du test de caractérisation ;
- pgTAP sur la libération du bail ;
- non-régression des tests 16.33.

Hors périmètre de 17.7a : le chemin produit 17.7a n'utilise ni IA ni l'orchestrateur v1 (voir le
document de conception, « Safe confirmation contract »).
