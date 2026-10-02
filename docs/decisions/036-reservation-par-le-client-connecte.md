# ADR 036 — Réservation par un client connecté : réglage par ressource, auteur et annulation tracés

**Date** : 2026-10-02
**Statut** : accepté — met en œuvre la décision D4 de l'ADR 016 ; précise
l'ADR 015 (annulation par le client) ; lève le manque « désignation des lignes
d'offre » reporté par l'ADR 035 ; les choix marqués « à valider » attendent le
centre

## Contexte

L'ADR 016 (décision D4) a tranché : quand un client connecté réserve depuis
son espace, **un réglage par ressource** dit si la réservation se confirme
immédiatement ou attend l'accord de l'accueil. La page publique anonyme reste
une demande validée par l'équipe (ADR 005).

Jusqu'ici, un client connecté ne réservait qu'à travers la page publique : la
demande était rattachée à son entreprise (`channel = 'client'`), toujours en
attente, sans dire **qui** l'avait faite. L'annulation par le client
(`canClientCancel`, ADR 015) posait un motif en texte, sans auteur. R23
demande aussi le tarif avant la réservation (fait : `quote()`, ADR 023) et
« l'offre groupée » ; l'ADR 035 avait reporté à cette vague la désignation
commerciale des lignes d'offre.

Le schéma de la vague 3 est posé avant les écrans, que d'autres tranches
construisent sans pouvoir le modifier : il doit être complet.

## Décision

### Un réglage par ressource, appliqué par la base

`resources.client_booking_mode`, énumération `client_booking_mode` :

| Valeur | Effet sur une réservation du portail |
|---|---|
| `instant` | Confirmée d'emblée **si son devis est figé** (`quoted_at`) ; sans devis, en attente |
| `approval` | En attente de l'accueil (`pending`) — **valeur par défaut** |
| `closed` | Refusée : la ressource ne se réserve pas depuis l'espace client |

La valeur par défaut est la plus prudente : rien ne s'engage sans l'équipe,
comme une demande publique. La reprise ferme au portail les casiers et les
boîtes aux lettres existants, qui se louent par contrat (ADR 018). Une
ressource créée ensuite reçoit `approval` quel que soit son type : l'écran de
la ressource propose `closed` pour un casier ou une boîte aux lettres
(*à valider*).

Une réservation **du portail** est celle qui porte
`bookings.booked_by_member_id` : la personne de l'entreprise qui l'a faite.
Le trigger `bookings_apply_client_booking_mode` (migration 0041) en **pose le
statut** à l'insertion, quel que soit celui que le code a écrit, et refuse
une ressource fermée, inactive ou archivée (SQLSTATE `CA009`). Le code lit le
statut rendu (`returning`) pour dire au client s'il a une réservation ou une
demande.

La page publique, connectée ou non, ne pose pas de personne : le réglage ne
la concerne pas, elle reste une demande (ADR 005, ADR 016).

### L'auteur, le client, le canal et le devis

- `booked_by_member_id` est une personne **de l'entreprise de la
  réservation** : clé étrangère `(tenant_id, client_id, booked_by_member_id)`
  vers `client_members (tenant_id, client_id, id)`. Il exige le canal
  `client`, une réservation (`kind = 'booking'`) et le client
  (`bookings_booked_by_member_consistent`). Il ne change jamais.
- Le devis figé est celui de la vague 2 (`quote_*`, `quoted_at`, ADR 023) : le
  code le calcule par `quote()` et l'écrit avec la réservation. Sans devis,
  une ressource `instant` attend l'accueil : un prix ne s'engage pas à
  l'aveugle.

### L'annulation par le client, tracée

`bookings.cancelled_by_member_id` (la personne, de l'entreprise de la
réservation) ou `bookings.cancelled_by_staff_id` (le membre de l'équipe), un
seul des deux, seulement sur une réservation annulée
(`bookings_cancelled_by_consistent`). Nuls pour les annulations antérieures,
et pour celles posées par la base (occupation de contrat). La date reste
`cancelled_at`.

La règle de `canClientCancel` est aussi celle de la base
(`bookings_guard_client_space`, `CA009`) : au nom du client, seule une
demande **en attente** et **pas commencée** s'annule ; une réservation
confirmée s'annule auprès du centre (ADR 015).

### Sous portée client, deux écritures seulement

Dans une transaction de l'espace client (ADR 019), pour une entreprise de la
portée, `bookings` n'accepte que :

- l'insertion d'une réservation (`kind = 'booking'`, canal `client`) au nom
  d'une personne de l'entreprise, sans coordonnées de demandeur public ;
- l'annulation d'une demande en attente, au nom d'une personne de
  l'entreprise, sans rien changer d'autre.

Hors de la portée, la RLS refuse elle-même (`42501`).

### L'offre groupée du portail

Les offres (ADR 024) se vendent par contrat, au mois : une réservation
horaire n'en porte pas. Le portail **présente** les offres que le centre
choisit et en transmet la demande à l'accueil, qui en tire le contrat
(ADR 028) :

- `offers.client_visible` (faux par défaut) : l'offre se montre dans
  l'espace client, avec son prix (`priceOffer`) ;
- `offer_items.label` : la désignation commerciale de la ligne (« Bureau
  fermé de 12 m² », « Dix numérisations par mois ») ; nulle, le nom du
  service, de la ressource ou du type. C'est le manque reporté par l'ADR 035 ;
- la demande part à l'accueil par l'événement `offer_requested` du moteur de
  notifications (ADR 038), journalisé. Pas de table de demandes d'offre : un
  contrat se négocie avec l'accueil.

L'unité d'une ligne d'acte inclus reste celle de l'ADR 024 (la quantité est
due par période de l'offre) : l'écran l'écrit en toutes lettres plutôt que de
changer le schéma.

## Justification

**Pourquoi la base pose le statut.** Le réglage peut changer pendant qu'un
client saisit. Laisser le code choisir le statut, c'est risquer une
confirmation que l'accueil devait valider, sur une simple course. Le trigger
lit la ressource dans la transaction qui écrit.

**Pourquoi exiger le devis pour confirmer.** Une réservation confirmée sera
facturée au devis figé (ADR 023). Sans devis, la confirmer laisserait une
réservation sans prix ; l'accueil, lui, peut la chiffrer à la validation.

**Pourquoi la personne plutôt qu'un simple canal.** Le canal dit « depuis
l'espace client », pas qui. Une entreprise a plusieurs accès (ADR 015) ; la
traçabilité (R24) veut le nom.

**Pourquoi refuser au lieu de corriger pour `closed`.** Une demande sur une
ressource fermée n'a pas d'issue : l'accueil la refuserait. Le refus
immédiat dit au client de contacter le centre.

## Alternatives écartées

**Un réglage par type de ressource.** Plus simple à saisir, mais une salle
peut se confirmer d'emblée quand la grande salle exige un accord : D4 dit
« par ressource ».

**Un réglage par centre, avec exceptions.** Deux niveaux à lire, pour un
parc de quelques dizaines de ressources.

**Une table des demandes d'offre.** Une offre se négocie ; le message à
l'accueil et son journal suffisent tant que le centre n'exprime pas de suivi.

**Réécrire le statut des réservations de la page publique connectée.** Elle
reste une demande de devis (ADR 005) ; la confondre avec la réservation du
portail aurait confirmé des « demandes de devis ».

## Conséquences

- Le portail (R23) réserve en écrivant `booked_by_member_id = account.memberId`
  sous `inClientSpace`, avec le devis de `quote()`, et lit le statut rendu.
  Erreurs à traduire : `CA009` (ressource fermée, ou écriture refusée sous
  portée client), `23P01` (créneau pris), `23503` (personne d'une autre
  entreprise).
- `cancelRequestForAccounts` (compte-queries.ts) pose désormais
  `cancelled_by_member_id`. L'annulation par l'équipe doit poser
  `cancelled_by_staff_id` (à faire dans les actions du back-office).
- La fiche ressource montre et règle `client_booking_mode` (droit
  `ressources.gerer`) ; le formulaire d'offre règle `client_visible` et la
  désignation des lignes (`services.gerer`).
- *À valider par le centre* : la liste des ressources ouvertes en
  confirmation immédiate ; la proposition `closed` pour les casiers et boîtes
  aux lettres créés ensuite.
