# ADR 076 — Réservations salles et bureaux : jour de départ libre, formules de location, modification par le client

**Date** : 2026-11-17
**Statut** : accepté — recette du 17/11/2026, lot 3. Complète les ADR 036 et 061 ;
modifie le garde de l'espace client de l'ADR 036. Migration `0017` (à
renuméroter à la fusion), règles `24-formules-et-modifications.sql`, code
`CA022`. Les choix marqués *à confirmer en recette* attendent le responsable
produit.

## Contexte

Notes de recette : « jour de départ libre ; ne pas écrire “nuits comprises”
mais les heures de fermeture » ; « bureaux : longue durée ou coworking, à la
journée, semaine minimum, mois minimum, le formulaire s'y plie » ; « modifier,
annuler ses demandes jusqu'à 7 jours avant, réglable ».

## Décision

### 1. Jours et heures (page publique, espace client)

Un composant commun (`reservations/periode-fields.tsx`) remplace les champs de
dates des deux formulaires. Le **jour du départ** se choisit dans un
calendrier, de l'arrivée à la durée maximale du produit (ADR 061) ; il ne
suit plus l'heure d'arrivée. Un jour qui ne propose aucune heure dit pourquoi
(fermé, réservé avant — « libre jusqu'au… », trop loin). Les **heures
d'ouverture des jours choisis**, lues dans « Horaires et fermetures »,
remplacent « nuits comprises » (aussi retiré du back-office). Le modèle de
l'ADR 061 (une réservation continue) ne change pas.

### 2. Formules de location des bureaux

- Sur la fiche d'un bureau : **agencement** (open space / bureau fermé,
  attribut `attributes.agencement`) et **formules** cochées (à l'heure, à la
  demi-journée, à la journée, à la semaine, au mois), rangées dans
  `attributes.formules` (décision 2, sans migration). Aucune formule : le
  formulaire libre d'avant.
- Le formulaire ne propose que les formules réglées : à la journée, de
  l'ouverture du jour d'arrivée à la fermeture du jour de départ ; à la
  semaine ou au mois, un nombre de semaines ou de mois, départ à la fermeture
  du dernier jour ouvert. Une fermeture exceptionnelle n'interrompt pas une
  location longue. Plafonds réglables dans Disponibilités :
  `tenants.booking_max_weeks` (4) et `booking_max_months` (12) — *à confirmer*.
- **Le prix suit l'unité de la formule** (`quote({ unit })`) : `week` et
  `month` reçus de Dolibarr par `tarif.bureau.semaine` et `tarif.bureau.mois`
  (ADR 049, déjà reconnus) ; au mois, la quantité est le nombre de mois du
  calendrier entamés. Sans prix : « tarif communiqué par l'accueil ».
- Choix par défaut : une demande au mois **reste une demande de réservation**
  que l'accueil valide ; le contrat se fait dans Dolibarr (ADR 046).

### 3. Modification et annulation par le client

- Le client modifie (formule, jours, heures) ou annule une demande **ou une
  réservation confirmée** jusqu'à **N jours avant le début**, N =
  `tenants.booking_change_days` (7, de 0 à 90, réglé dans Disponibilités). Le
  délai se compte en heure murale du centre : même heure, N jours plus tôt.
  Au-delà, la carte et la page de modification disent pourquoi et donnent le
  téléphone et l'adresse de l'accueil.
- Une modification **repasse la réservation en attente** (choix par défaut,
  *à confirmer*), est rechiffrée, et passe par le trigger anti-chevauchement
  (`CA000`, message clair). Le devis ouvert est annulé par la base
  (`bookings_client_change_proposal`) et un nouveau est déposé aux nouvelles
  dates, mêmes réponses.
- La base garde la règle (`booking_assert_client_change`, `CA022`) : ni
  annulée ni commencée, avant le délai, une modification remise en attente,
  et pas de modification d'une réservation qui emporte du matériel en option
  (*à confirmer* : l'accueil le déplace ; l'annulation, elle, reste possible).
- L'accueil est prévenu : événements `booking_changed_by_client` et
  `booking_cancelled_by_client` (adresse du centre, ancien et nouveau
  créneau). Une réservation confirmée sort de l'agenda Google.

## Contradictions et écarts

- **ADR 036 / ADR 015** : « une réservation confirmée s'annule auprès du
  centre ». La recette demande l'inverse dans le délai : le garde de
  `20-reservations.sql` est modifié (nécessité) et délègue au fichier 24.
- **Délai appliqué aussi aux demandes en attente** : avant, une demande
  s'annulait jusqu'à son début ; désormais jusqu'à N jours avant (N = 0 rend
  l'ancien comportement).
- Un prix saisi à la main par l'accueil est remplacé par celui de la grille
  à la modification ; l'accueil le revoit à la validation.

## Alternatives écartées

- Une colonne de formule sur `bookings` : l'unité du devis figé la retrouve.
- Une table des formules par ressource : une liste dans `attributes` suffit.
- Contrôler le délai en code seulement : la base le garde comme le reste de
  l'espace client.

## Conséquences

- Fichiers partagés touchés par ajout : `notifications/schema.ts`,
  `catalogue.ts`, `70-notifications.sql` (deux événements), `db/errors.ts`,
  `reglages/sections.ts`, `ressources/[id]/page.tsx` (section « Formules »),
  `facturation/devis.ts` (unité imposée).
- L'astérisque des champs obligatoires est local (`Requis`) en attendant le
  composant commun du lot 1.
