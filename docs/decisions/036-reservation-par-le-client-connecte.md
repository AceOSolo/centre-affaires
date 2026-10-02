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

## Mise en œuvre — portail de réservation (vague 3)

Ajoutée par la tranche « portail-réservation » (R23 ; R24 pour les
réservations ; R25 pour ces écrans). Aucune migration ni dépendance : le
schéma ci-dessus suffit, à un manque près (fin de section). Les choix
nouveaux sont marqués **à valider**.

### Le parcours dans l'espace client

`/compte/reservations/nouvelle` : un formulaire en GET (type d'espace et
date, sans JavaScript, URL partageable), la liste des espaces ouverts au
portail avec leurs plages libres du jour, puis, l'espace choisi, le
formulaire de réservation. Mobile d'abord : une colonne, cibles de 44 px,
8 px entre deux cibles.

- **Disponibilités réelles, même moteur.** Le calcul des plages libres est
  sorti de `listDayAvailability` dans un module pur,
  `reservations/disponibilites.ts` (`dayAvailability`), qu'appellent la page
  publique, le back-office et l'espace client. L'espace client lit tout sous
  sa portée (`listPortalDayAvailability`, `inClientSpace`) : ressources en
  service, non archivées et non fermées au portail, horaires, fermetures, et
  les créneaux des autres par `booking_busy_ranges()`, qui n'en livre que les
  heures. Préavis et horizon du centre comme la page publique
  (`requestableRanges`).
- **Pas de plafond de huit heures** : un client réserve jusqu'à la fin d'une
  plage libre (`availableEnds(…, maxMinutes)`), sur une seule journée, trente
  minutes au moins (*à valider*).
- **Montant avant validation.** `previewPortalQuote` appelle `quote()` dans
  une transaction de l'espace client, pour l'entreprise choisie : la grille
  de son contrat passe avant celle du centre (ADR 023). L'écran affiche le
  détail (`QuoteSummary`), dit si le prix vient du contrat, et annonce la
  suite — « Confirmation immédiate » ou « Sur validation »
  (`expectedPortalOutcome`, jumeau pur du trigger). Le bouton le redit :
  « Confirmer la réservation » ou « Envoyer la demande ».
- **Écriture.** `createPortalBooking` : une transaction de l'espace client
  calcule le devis par `quoteInTransaction`, le fige (`bookingQuoteColumns`)
  et insère la réservation (`kind = 'booking'`, canal `client`,
  `booked_by_member_id` = la personne connectée). Le statut écrit est
  ignoré : celui que rend la base est lu et dit à l'écran
  (`portalOutcomeMessage` : « Réservation confirmée » ou « Demande envoyée à
  l'accueil »), avec le montant figé. Erreurs traduites : `23P01` (créneau
  pris entre-temps), `CA009` (message de la base, qui nomme la ressource),
  `23503` (personne qui n'est plus de l'entreprise). Les disponibilités sont
  relues à l'envoi (`portalBookingRejection`).
- **Entreprise.** Une personne qui représente plusieurs entreprises choisit
  la sienne ; elle doit être l'une du compte, jamais déduite de la seule
  requête.
- **Après l'écriture** : une réservation confirmée part dans l'agenda Google
  de la ressource (ADR 014) ; une demande prévient l'accueil
  (`booking_request_submitted`, ci-dessous).

La page publique, connectée ou non, ne change pas (ADR 005) ; « Mes
réservations » renvoie désormais vers le parcours de l'espace.

### « Mes réservations »

À venir — en cours comprises, signalées « En cours » — puis « Passées et
annulées » (six mois). Chaque réservation porte son statut en toutes
lettres et par une icône, son montant figé TTC, son origine
(`clientBookingTrace` : « Réservée par Jeanne Martin depuis l'espace
client », « Réservée par l'accueil du centre », « Demandée depuis le site
du centre ») et l'auteur de son annulation (« Annulée par Jeanne Martin »,
« Annulée par le centre » ; rien d'inventé pour une annulation sans
trace). L'équipe reste « le centre » : le client n'a pas à connaître ses
membres. L'annulation par le client suit `canClientCancel`, inchangée
(demande en attente, avant son début), et pose `cancelled_by_member_id`.

### Côté équipe

- **Fiche ressource** : section « Réservation depuis l'espace client »,
  trois choix expliqués, enregistrement avec son état
  (`updateClientBookingModeAction`, `ressources.gerer`). La création
  propose `closed` pour un casier ou une boîte aux lettres, `approval`
  sinon (`defaultClientBookingMode`, *à valider*), modifiable avant
  d'enregistrer.
- **Annulations tracées** : `cancelBooking`, `refuseBooking` et
  l'annulation des occurrences d'une série posent `cancelled_by_staff_id`
  (le membre connecté). La fiche d'une réservation dit qui l'a faite depuis
  l'espace et qui l'a annulée.
- **« Demandes »** : les demandes de l'espace client y arrivent avec les
  autres, chacune avec son canal (`ChannelLabel`), son entreprise, la
  personne (nom, adresse) et son montant figé — ou « non chiffrée ». Le
  motif de refus a désormais un libellé visible.

### L'offre groupée : une demande que l'équipe transforme

Tranché : **le client ne crée pas de contrat brouillon**. Un brouillon
tiré de l'offre par le client prendrait un numéro de contrat, bloquerait
l'anonymisation de l'entreprise tant qu'il vit (ADR 040 : un brouillon est
un contrat vivant), et l'accueil devrait de toute façon l'ajuster (lignes,
ressource, date de début : ADR 028). La demande est le message
`offer_requested` au centre, journalisé ; l'accueil en tire le contrat.

- **`/compte/offres`** (onglet « Offres » de l'espace) : les offres
  `client_visible` non archivées, lues sous la portée client, chiffrées par
  `priceOffer` au catalogue du jour (`loadOfferCatalogueInTransaction`,
  extrait de `loadOfferCatalogue`) : lignes par leur désignation
  commerciale (`offer_items.label`) ou celle du catalogue, actes inclus et
  prix au-delà, totaux HT et TTC par période, économie sur le catalogue,
  engagement. Une offre au prix incomplet le dit : « précisé par
  l'accueil ».
- **« Demander cette offre »**, en une action : l'entreprise (si
  plusieurs), puis `requestOfferAction`. Une seconde demande de la même
  offre par la même entreprise dans les sept jours ne renvoie rien et
  rappelle la date de la première (*à valider*).
- **Back-office** : la case « Présenter l'offre dans l'espace client » sur
  le formulaire d'offre, le champ « Désignation commerciale » sur ses
  lignes (`services.gerer`), repris dans la composition de l'offre.
  « Demandes » liste les offres demandées des quatre-vingt-dix derniers
  jours (*à valider*), relues dans le journal, avec « Préparer le
  contrat » (`/contrats/nouveau/offre`, offre et client remplis, droit
  `contrats.creer` ; sinon « À transmettre à l'exploitant ») ; une demande
  est traitée dès qu'un contrat est tiré de l'offre pour ce client après
  elle.

### Messages au centre

`notifications/message-centre.ts` (`sendCentreMessage`) : le chemin
minimal de cette tranche pour les deux messages au centre qu'elle
déclenche, `booking_request_submitted` (demande de réservation de
l'espace, après la réponse) et `offer_requested` (avant la réponse : le
journal est la seule trace de la demande, son échec fait échouer la
demande). Modèle du centre s'il existe, variables `{{centre}}`,
`{{client}}`, `{{personne}}`, `{{ressource}}`, `{{offre}}`, `{{date}}`,
`{{montant}}`, `{{lien}}` ; modèle désactivé ou centre sans adresse : rien
ne part, journalisé `skipped`. `sendMessage` rend désormais l'issue de
l'envoi (`SendReport`) pour le journal. À l'intégration avec le moteur de
la tranche notifications (ADR 038), ces deux appels passent par lui.

### Manque de schéma relevé

Le journal des envois ne porte pas la personne qui a demandé une offre
(`notification_deliveries` n'a ni membre ni texte libre, par décision de
l'ADR 038) : « Demandes » montre l'entreprise et l'offre, la personne
n'est que dans le corps du courriel. Le journal étant purgé au terme de sa
durée (12 mois) et anonymisé avec le client, une demande d'offre n'a pas
d'historique au-delà ; la table des demandes d'offre écartée ci-dessus le
permettrait, si le centre exprime un suivi.

### Tests

`portail-regles.test.ts` (statut annoncé selon le réglage et le devis,
créneau refusé avant l'écriture, objet), `disponibilites.test.ts` (moteur
commun), `reservation-client.test.ts` (réglage proposé et lu),
`compte-regles.test.ts` (traçabilité, réservation en cours),
`offres-regles.test.ts` (case et désignation), `message-centre.test.ts`
(modèles et textes) ; contre la base, `portail-reservation.db.test.ts`
(disponibilités sous portée client, tarif du contrat annoncé puis figé,
statut selon le réglage, refus traduits, annulations tracées,
« Demandes », message au centre) et `offres-portail.db.test.ts` (offres
présentées et chiffrées, demande journalisée sans contrat, anti-doublon,
traitement par le contrat, modèle désactivé).

## Mise en œuvre — documents, historique et revue mobile du portail (R17, R24, R25)

Tranche « portail-documents » de la vague 3. Aucune migration : tout se lit
dans le schéma posé par les migrations 0039 à 0043 et dans celui de la
vague 2.

### Navigation de l'espace client

`compte-nav.tsx` réunit, après l'intégration de la vague, huit rubriques,
dans cet ordre : Réservations, Offres, Courrier, Contrats, Factures, États
des lieux, Historique, Préférences (Offres vient de la tranche
« portail-réservation », États des lieux de l'ADR 039, Préférences de
l'ADR 038). Sur téléphone, une grille de trois colonnes : les huit rubriques
restent visibles, en trois rangées, hautes de 44 px et espacées de 8 px — une
bande qui défile cachait les dernières. À partir de `sm`, la barre d'onglets
habituelle. L'onglet actif est dit par `aria-current`, pas par la seule
couleur. Le test `cibles-tactiles.test.ts` vérifie l'ordre et qu'aucune
rubrique ne mène à une page absente.

### Mes contrats (R17)

`/compte/contrats` (`contrats/compte-queries.ts`, `compte-regles.ts`) : les
contrats des entreprises du compte, **jamais un brouillon ni un contrat
archivé**, avec leur état dit pour le client (à venir, en cours, résilié et
en cours jusqu'à son terme, arrivé à terme, résilié), leur période, la
ressource et le prix en vigueur le jour du centre (`contract_segments`,
`contract_price_versions`, ADR 025), l'engagement, le préavis, la
reconduction, les **seuls avenants signés**, et chaque version archivée du
document. Celle-ci s'ouvre en vue imprimable,
`/compte/contrats/[id]/document?version=N`, avec la même vue que le
back-office (`ContractDocumentView`) et l'empreinte SHA-256 vérifiée par la
base. Le client ne voit jamais un aperçu (données du jour, sans valeur
contractuelle), et le nom du membre de l'équipe qui a archivé le document
reste au back-office.

### Mes factures (R17)

`/compte/factures` (`facturation/compte-queries.ts`, `compte-regles.ts`) :
factures et avoirs émis, montant TTC, échéance, état pour le client (à
régler, échue, payée en partie, payée, annulée par avoir, avoir) et reste à
régler, avec un résumé par devise en tête. Coordonnées de virement du centre
(titulaire, IBAN, BIC) et référence à indiquer : le numéro de la facture,
repris sur chaque carte. Chaque document s'ouvre en vue imprimable,
`/compte/factures/[id]`, **identique à celle du back-office** : la feuille a
été extraite dans `facturation/invoice-sheet.tsx` et sert les deux pages,
avec les mêmes règles d'impression (`invoiceSheetPrintStyles`). Elle se lit
dans les instantanés figés à l'émission (vendeur, acheteur, mentions, IBAN).

Trois verrous contre un brouillon ou la facture d'un autre : le filtre
`client_id`, le filtre `status <> 'draft'` et `deleted_at is null`, et la
portée client en RLS (`invoices_client_scope`, migration 0031), qui tient
seule. `facturation/compte.db.test.ts` le prouve sous `app_centre`, y compris
par une requête sans aucun filtre ; `contrats/compte.db.test.ts` fait de même
pour les contrats et leurs documents.

Les pages imprimables de l'espace client sont dans le groupe `(impression)`,
hors de la coque du site, comme celle des contrats du back-office : elles
revérifient le compte (`requireClientAccount`) et répondent 404 de la même
façon pour « n'existe pas », « brouillon » et « pas à vous ».
`src/lib/auth/gardes-espace-client.test.ts` relit les sources et refuse
toute page ou route de `(portail)/compte` ou `(impression)/compte` sans
`requireClientAccount()`, pendant de la garde du back-office.

### Historique du compte (R24)

`/compte/historique` (`clients/historique-compte.ts`, pur, et
`historique-compte-queries.ts`) : demandes de réservation et leur issue
(auteur depuis l'espace, annulation datée par la personne ou par le centre,
motif), demandes de courrier et chacune de leurs étapes (dépôt, prise en
charge, réalisation, refus et motif, annulation, numéro de suivi), documents
de contrat archivés, factures et avoirs émis. Rien n'est écarté parce qu'il a
été annulé ou refusé : l'historique se lit dans `bookings` (ADR 036) et
`mail_requests` (ADR 037), qui gardent la trace. Regroupé par mois du centre,
filtrable par rubrique, et **lu par année du centre** : chaque année reste
accessible, rien n'est caché derrière une limite (500 lignes par rubrique et
par année, signalées si elles sont atteintes). L'expéditeur d'un pli retiré
par le centre n'est plus montré : le pli n'était peut-être pas celui de
l'entreprise.

### Revue mobile (R25)

Cibles portées à 44 px au moins, à 8 px d'écart : bouton Réserver et
téléphone de l'en-tête, logo, liens du pied de page (coordonnées, carte,
Espace client, Accès équipe) et des réseaux sociaux, lien d'évitement au
focus, barre d'action du téléphone sur l'accueil, pastilles de créneau,
bouton d'action et lien retour de `annonces/[slug]`, bouton « Voir » et
titre des annonces. Les liens du bandeau supérieur, affiché au seul grand
écran, ont 24 px (cible minimale du web). Marges des annonces alignées sur
la coque (20 px sur téléphone). Tableaux : la feuille de facture et le
document de contrat gardent leurs tableaux dans `overflow-x-auto` et
réduisent leurs marges sur téléphone ; les listes de l'espace client sont
des cartes.

Vérification : `src/app/(portail)/cibles-tactiles.test.ts` parcourt toutes
les pages de `(portail)` et de `(impression)/compte` (analyse des sources
par le compilateur TypeScript, déjà en dépendance) et échoue sur tout lien ou
bouton sans classe de 44 px — hors lien au fil d'une phrase (WCAG 2.5.8) et
élément réservé au grand écran — et sur toute largeur fixe plus grande
qu'un écran de 375 px moins ses marges. Il vérifie aussi les six rubriques du
compte. Sans navigateur dans la CI, l'absence de défilement horizontal à
375 px reste à constater à l'écran (outils de développement, 375 × 812) à
chaque tranche ; la règle de largeur et les `overflow-x-auto` en sont la
garde statique. Les composants des modules affichés dans le portail
(formulaires, actions) ne sont pas parcourus : ils suivent la même règle,
relue à chaque tranche.

### Manques et limites

- La confirmation d'une réservation n'est pas datée en base (ni
  `confirmed_at` ni auteur) : l'historique dit « Confirmée » sans date.
- Le journal des relances est réservé au back-office (RLS,
  `invoice_reminders_back_office_only`) : l'historique du client ne montre
  pas les relances envoyées.
- Le document de contrat **signé** (scan) n'est pas stocké (reporté à la
  vague 4, ADR 035) : le client voit le document établi et archivé, pas son
  exemplaire signé.

### À valider par le centre

- Les libellés d'état présentés au client (« Échue », « Arrivé à terme »,
  « Résilié, en cours jusqu'à son terme ») ;
- la référence de virement demandée : le numéro de la facture, une facture
  par virement.
