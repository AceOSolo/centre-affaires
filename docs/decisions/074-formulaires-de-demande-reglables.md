# ADR 074 — Formulaires de demande réglables, dynamiques ; domiciliation revue ; astérisques ; anti-robot discret

**Date** : 2026-11-17
**Statut** : accepté — lot 1 de la recette du 17/11 (`docs/recette/2026-11-17.md`) ;
amende l'ADR 043 (questionnaires en code, « un formulaire pour salle et bureau »)
et l'ADR 047 (case « Je ne suis pas un robot »). Les choix marqués
**à confirmer en recette** ont été tranchés en l'absence du responsable produit.

## Contexte

Notes de recette : questions réglables dans l'admin, un formulaire par service
(salle ≠ bureau), « Autre » qui ouvre un champ libre, formulaires qui
s'adaptent aux réponses, domiciliation revue (deux situations, SIRET, nom et
prénom séparés, plus de question courrier ni d'up-sell, tarif calculé selon des
options venues de Dolibarr), astérisques sur les champs obligatoires, captcha
qui « se coche tout seul » et paraît factice.

## Décision

1. **Un formulaire par service vendu** : `salle`, `bureau`, `vehicule`,
   `materiel`, `domiciliation` (`reservations/questionnaires.ts`). Le produit du
   devis ne change pas (`espace` pour salle et bureau) : ni Dolibarr ni la base
   des devis ne bougent. Le formulaire se déduit du type de ressource. La page
   publique propose « Salle de réunion » et « Bureau » séparément.
2. **Questions en base, par centre** : table `questionnaires` (une ligne par
   centre et formulaire : nom, présentation, questions en JSON, options de
   domiciliation). Sans ligne, les questions du code (rien ne change tant que le
   centre n'y touche pas). Écran **Réglages > Formulaires de demande** (droit
   `formulaires.gerer`, exploitant et direction) : présentation, ajouter,
   modifier, ordonner, masquer/reposer, revenir aux questions par défaut. Une
   question n'est jamais supprimée ; son nom (clé de réponse) ne change jamais.
3. **Réponses figées** : `proposals.described_answers` garde les réponses en
   clair avec les libellés lus par le demandeur ; un devis antérieur est relu
   avec les questions du code d'alors (`answersForDisplay`). Base : forme des
   questions vérifiée par `JSON_SCHEMA_VALID`, réponses figées hors brouillon et
   sous portée client (`23-questionnaires.sql`, **CA020**).
4. **Dynamique** : « Autre » (`allowOther`) ouvre un champ libre, obligatoire si
   la question l'est ; `showWhen` remplace `requiredWhen` : « affichée et
   obligatoire si ». Masquée, une question n'est ni gardée ni exigée par le
   serveur. Sans JavaScript, une règle CSS `:has()` montre la question dès que
   la réponse qui l'ouvre est cochée ; avec JavaScript, les champs masqués sont
   en plus désactivés. Une condition porte sur une question à choix posée avant,
   sans chaîne de conditions.
5. **Domiciliation** : situation « en cours de création » (nom du projet, date
   prévue) ou « déjà immatriculée » (raison sociale, **SIRET** : 14 chiffres,
   Luhn ; exception La Poste, SIREN 356 000 000 : somme des chiffres multiple
   de 5, siège en Luhn). Plus de question courrier ni « services en plus ».
   Prénom et nom séparés. **Tarif** : forfait = prix au mois de la boîte aux
   lettres dans la grille par défaut (`tarif.boite_aux_lettres.month`, ADR 049)
   + options cochées parmi les forfaits mensuels du catalogue (Dolibarr) que le
   centre choisit ; total HT et TTC recalculé à chaque choix, TVA par taux sur
   la somme des bases ; sans forfait : « Tarif communiqué par l'accueil ». Le
   devis (brouillon) reprend ces lignes.
6. **Astérisques** : `components/ui/obligatoire.tsx` (`RequiredMark`,
   `RequiredNote`, `FieldLabel`), en bleu foncé (la charte réserve le rouge aux
   erreurs), masqué aux lecteurs d'écran : `required`/`aria-required` portent
   l'information. Appliqué aux questions, aux formulaires publics, au besoin de
   l'espace client et aux formulaires de connexion.
7. **Anti-robot discret** : ALTCHA gardé, en mode invisible ; une ligne d'état
   (« en cours », « réussie », échec avec « Réessayer » ; un défi expiré repart
   seul).

## Justification

- ALTCHA se vérifie seul parce que c'est une **preuve de travail** : le
  navigateur résout un calcul de quelques secondes, gratuit pour une personne,
  ruineux pour un robot en masse ; rien à cliquer. La case qui se cochait seule
  était un habillage, d'où l'impression de faux contrôle. **Pas de captcha à
  images** : inaccessible (lecteurs d'écran, malvoyants), pénible, et les
  services qui en servent (reCAPTCHA, hCaptcha) sont hors UE et pistent
  (ADR 047).
- Le JSON par formulaire (comme `attributes`, décision 2) : un questionnaire se
  lit et se valide entier ; un tableau de questions en lignes n'apporterait que
  des jointures.
- Garder `espace` comme produit évite une migration des devis et du format
  Dolibarr pour une distinction que porte déjà le type de ressource.

## Choix par défaut — à confirmer en recette

- Questions par défaut du bureau : nombre de personnes, bureau fermé / open
  space / peu importe, usage (avec Autre), équipements, accès PMR.
- Domiciliation : date prévue d'immatriculation facultative ; « forme
  juridique » gardée, avec Autre.
- « (facultatif) » retiré là où l'astérisque est posé : un champ sans astérisque
  est facultatif.
- Options de domiciliation : forfaits mensuels seulement, dans l'ordre du
  catalogue ; forfait de base pris dans la grille, pas dans un service.
- Ligne du forfait au devis en source `manual` (repère : la ligne de grille).
- Le devis de l'accueil (`/devis/nouveau`) se choisit aussi par formulaire.

## Conséquences

- Migration de structure (table `questionnaires`, colonne
  `proposals.described_answers`) et règles `23-questionnaires.sql`.
- L'anonymisation RGPD des devis, à écrire (ADR 043), devra vider aussi
  `described_answers`.
- Reste aux autres lots : astérisques sur leurs écrans de l'espace client
  (courrier, préférences, dates de la réservation) ; open space / bureau fermé
  comme attribut de la ressource (lot 3).

## Tests

`questionnaires.test.ts`, `questionnaires-edition.test.ts`,
`domiciliation-tarif.test.ts` (purs) ; `questionnaires.db.test.ts` (défauts,
réglage par centre, CA020, tarif et lignes du devis, réponses figées).
