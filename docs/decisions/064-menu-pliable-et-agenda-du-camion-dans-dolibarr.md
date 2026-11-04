# ADR 064 — Menu pliable par rayon, et l'agenda du camion dans Dolibarr

**Date** : 2026-11-04
**Statut** : accepté — complète l'ADR 053 (menu par service vendu) et
l'ADR 014 (un agenda Google par ressource) ; lot 8 de la recette du 04/11/2026
(`docs/recette/2026-11-04.md`)

## Contexte

Deux notes de la recette du 04/11/2026 :

- **« Menu de gauche pliable ».** La barre latérale affiche tous les rayons
  ouverts (ADR 053) : sept groupes, dix-neuf entrées. Un membre qui ne
  s'occupe que du courrier et du camion fait défiler le reste chaque jour.
- **« Page Dolibarr “aide outils” : tous les agendas, ajouter le calendrier du
  camion ».** La page réunit déjà des agendas Google. Le site sait écrire les
  réservations confirmées dans un agenda Google par ressource (ADR 014), mais
  son écran ne donnait ni l'identifiant de l'agenda ni le code pour l'intégrer
  ailleurs.

## Décision

### 1. Chaque rayon se plie

**Ce qui se plie est tiré des données de `menu.ts`**, sans liste de rayons
dans le code : un groupe se plie s'il a un titre visible, c'est-à-dire si sa
première entrée ne porte pas son nom (`isFoldable`, `nav-plie.ts`).

| Groupe | Se plie |
|---|---|
| Aujourd'hui (Aujourd'hui, Demandes) | non : toujours visible |
| Salles, Bureaux, Domiciliation, Camion | oui |
| Tout rayon ajouté à `produits.ts` et au menu (Matériel, lot 6) | oui, sans retouche |
| Tous les services | oui |
| Réglages | non, voir l'écart ci-dessous |

La règle est lue sur le groupe déclaré, pas sur ce qu'un rôle en voit : un
rôle sans « Aujourd'hui » ne pourrait pas plier « Demandes ».
`nav-plie.test.ts` vérifie que chaque produit de `produits.ts` se plie et que
« Aujourd'hui » et « Demandes » restent dehors.

**Écart avec la recette : « Réglages » ne se plie pas.** Son groupe n'a qu'une
entrée, du même nom. Plié, il occuperait la même ligne qu'aujourd'hui, avec un
clic de plus pour l'atteindre.

**Par défaut, tout est ouvert**, comme avant : un membre qui ne plie rien ne
voit aucun changement.

**Le rayon de la page en cours est ouvert à l'arrivée**, même plié : on ne
perd jamais de vue où l'on est. Il reste pliable à la main, et se rouvre à la
page suivante du même rayon. Naviguer ne réécrit pas le cookie : les autres
rayons pliés le restent.

### 2. L'état est retenu par navigateur, dans un cookie

- Cookie `menu_plie` : les clés des rayons pliés (`camion.salles`), dérivées
  du libellé sans accents ni espaces. Un an, `path=/`, `SameSite=Lax`,
  `Secure` en HTTPS. Pas `HttpOnly` : c'est le navigateur qui l'écrit au clic.
- **La coque du back-office le lit au rendu serveur** (`layout.tsx`) : la
  barre latérale arrive déjà pliée, **sans saut de mise en page au
  chargement**. Le contenu est relu sans confiance : seules des clés
  `[a-z0-9-]`, vingt au plus.
- Les deux rendus de la navigation (barre latérale, menu des écrans étroits)
  partagent le même état, lu dans le cookie par un magasin commun
  (`useSyncExternalStore`) : plier dans l'un plie dans l'autre. Le menu
  mobile (`mobile-menu.tsx`) n'a pas changé : il affiche la même navigation.
- C'est un cookie de préférence d'affichage, posé à la demande du membre, sans
  suivi : il n'appelle pas de consentement.

### 3. Accessibilité

- Le titre du rayon est un **bouton** (`aria-expanded`, `aria-controls` vers
  la liste), au clavier comme tout bouton (Entrée, Espace), avec le contour de
  focus du back-office. Le nom du groupe reste son seul libellé.
- Plié, la liste est `inert` et `invisible` : ses liens sortent de la
  tabulation et des lecteurs d'écran.
- **Animation** : la hauteur passe de zéro à celle des entrées en 200 ms
  `ease-out` (`grid-template-rows` de `0fr` à `1fr`), le chevron tourne d'un
  quart de tour. Le bloc `prefers-reduced-motion` de `globals.css` rend les
  deux immédiats.
- **Un rayon plié garde ses compteurs** : celui du courrier dans
  « Domiciliation », et tout compteur qu'un rayon recevra, lu sur ses
  entrées (`counter` de `menu.ts`). Le chiffre est accompagné d'un texte
  pour les lecteurs d'écran (« 3 demandes de courrier à traiter »). Ouvert,
  le compteur reste sur son entrée seulement, pour ne pas être lu deux fois.
- Le titre devient une cible de 24 px de haut, le minimum du web, au lieu
  d'une ligne de 16 px, à 8 px de la première entrée : un menu tout ouvert
  gagne 8 px par rayon, qu'un seul rayon plié rend largement. Les listes ont
  une marge intérieure, reprise sur l'écart entre groupes (16 px au lieu de
  20) : le contour de focus des liens tient dans la zone qui masque le rayon
  plié au lieu d'y être rogné.

### 4. L'agenda du camion dans la page Dolibarr

- **Vérifié : rien n'est propre aux salles.** L'écran des agendas liste toutes
  les ressources, le camion (type `vehicule`) se relie comme les autres, et
  ses locations confirmées s'y écrivent, une location de plusieurs jours en
  un seul événement. Tests ajoutés à `agenda-google.test.ts`.
- **L'écran donne le code d'intégration.** Réglages > Agendas Google
  (`/ressources/agendas`), section « Intégrer un agenda dans une autre page » :
  pour chaque ressource reliée, le code d'intégration (le cadre
  `calendar.google.com/calendar/embed` que donne Google Agenda, à l'heure du
  centre, titré pour les lecteurs d'écran, sur toute la largeur de la page) et
  l'identifiant de l'agenda, pour l'ajouter à un cadre qui en réunit déjà
  plusieurs. Chacun a son bouton « Copier ».
- L'identifiant n'est pas un secret : il ne donne rien à qui n'a pas accès à
  l'agenda. L'écran reste réservé au droit `agenda-google.gerer`.
- **RGPD : l'agenda n'est jamais rendu public.** L'objet d'une réservation
  peut porter le nom d'un client (« Réservation ACME », ADR 014). Un agenda
  intégré non public ne montre ses événements qu'aux comptes Google avec qui
  il est partagé, connectés dans le navigateur. Il se partage nommément avec
  les comptes de l'équipe, en lecture (« afficher tous les détails ») : une
  modification faite dans Google serait écrasée, l'application fait foi.
- Le partage se fait dans Google Agenda, par le titulaire du compte du centre,
  une fois par membre. Le site ne le fait pas.
- Marche à suivre : `docs/exploitation/agenda-google-dans-dolibarr.md`.

## Justification

**Un cookie plutôt que le stockage local.** Le stockage local n'est lisible
qu'une fois la page chargée : le menu arriverait ouvert, puis se plierait
sous les yeux. Le cookie est lu au rendu serveur.

**Par navigateur plutôt que par membre en base.** C'est ce que demande la
recette. Une préférence en base demanderait une migration et une écriture
serveur à chaque clic, pour un réglage d'affichage.

**Le rayon en cours rouvert, mais pliable.** Un bouton qui ne plie pas quand
on clique serait plus déroutant qu'un rayon qu'on replie soi-même.

**Le code d'intégration à l'écran.** Google le donne aussi (Paramètres de
l'agenda > Intégrer l'agenda), mais il faut savoir où le chercher, dans le
bon compte. L'avoir à côté de la ressource reliée évite l'aller-retour.

## Alternatives écartées

**Accordéon (un seul rayon ouvert à la fois).** Il refermerait un rayon sans
qu'on le demande ; « Domiciliation » et « Camion » ouverts ensemble est un
usage normal.

**Tout plié par défaut.** Changement imposé à tous pour une préférence de
quelques-uns.

**Rendre l'agenda public, ou donner son adresse iCal secrète.** Les
événements portent des noms de clients ; l'adresse secrète donne l'accès à
quiconque la connaît (ADR 014).

**Partager l'agenda depuis le site.** Un geste fait une fois par membre, dans
Google Agenda, que le titulaire du compte maîtrise déjà ; le faire depuis le
site demanderait un écran et des droits de plus chez Google.

## Conséquences

- Aucune migration, aucune variable d'environnement nouvelle. L'agenda
  Google demande les variables de l'ADR 014 (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `APP_URL`, `SECRETS_ENCRYPTION_KEY`).
- Le rayon Matériel du lot 6 se pliera de lui-même ; `menu.test.ts` est
  inchangé.
- Un rayon renommé perd son état plié (la clé vient du libellé) : il
  s'ouvre, sans autre effet.
- Dans un navigateur qui bloque les cookies tiers (Safari par défaut, Firefox
  en protection stricte, navigation privée), Google ne reconnaît pas le
  compte dans le cadre intégré, qui reste vide. L'agenda partagé reste lisible
  dans Google Agenda ; la marche à suivre le dit.
