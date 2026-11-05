# ADR 071 — Un lien d'agenda par ressource, à la place de la connexion Google

**Date** : 2026-11-05
**Statut** : accepté — remplace l'ADR 014 (agenda Google écrit par
l'application) et l'ADR 069 (identifiants Google Cloud à l'écran) ; amende
l'ADR 064 (l'agenda du camion dans Dolibarr passe par le lien) ; migration 0016

## Contexte

Les ADR 014 et 069 écrivaient les réservations dans un agenda Google créé
par l'application. Il fallait déclarer le site dans Google Cloud (projet, API,
écran de consentement, client OAuth), coller ses identifiants, connecter un
compte, puis créer l'agenda de chaque ressource. Après l'avoir fait, la
direction l'a jugé trop complexe (05/11/2026) et a demandé **un lien de
partage**, comme les applications qui donnent une adresse « .ics » à ajouter à
son agenda.

L'ADR 014 avait écarté ce lien : Google relit un lien externe à son rythme,
de 8 à 24 heures, et l'adresse donne accès au planning à qui la connaît. Ces
deux limites ont été rappelées ; la direction maintient sa demande. Cet ADR la
met en œuvre et garde les deux limites visibles à l'écran.

## Décision

### 1. Un lien par ressource

L'espace des agendas (`/ressources/agendas`, Réglages > Agendas) liste les
ressources. Pour chacune : « Créer le lien », et en tête « Créer le lien de
toutes les ressources ». Une ressource qui a son lien montre :

- l'adresse, avec « Copier » ;
- **« Google Agenda »** : la page de Google qui propose d'ajouter le lien
  (`calendar.google.com/calendar/r?cid=webcal://…`) — un clic, puis
  « Ajouter » ;
- **« Apple, Outlook »** : la même adresse en `webcal://`, qui ouvre
  l'abonnement dans l'application ;
- la date de la dernière lecture par une application d'agenda : l'abonnement
  marche ;
- « Régénérer » (l'ancien lien cesse aussitôt) et « Désactiver ».

Un encart dit comment ajouter le lien dans Google Agenda, Apple Calendrier et
Outlook, le délai de mise à jour de chacun, et que le lien ne se transmet qu'à
l'équipe.

### 2. Le lien sert les réservations confirmées

`GET /api/agendas/{jeton}.ics`, sans session : un fichier iCalendar
(RFC 5545) avec les réservations confirmées de la ressource terminées depuis
moins de 31 jours ou à venir. Mêmes règles et même minimisation que
l'ADR 014 : ni demande en attente, ni réservation annulée, ni
indisponibilité ; ni nom, ni courriel, ni téléphone du demandeur, ni notes.
L'événement porte l'objet, la ressource, le créneau en UTC et le lien vers la
fiche du back-office.

Le fichier est recalculé à chaque lecture : il n'y a plus rien à écrire après
une réservation, une annulation ou un déplacement. Une réservation déplacée
dans une autre salle quitte d'elle-même l'agenda de l'ancienne.

### 3. Le jeton n'est pas gardé en base

Table `calendar_feeds` : une ligne par ressource qui a un lien (`tenant_id`,
`resource_id` unique), qui l'a créé, dernière lecture. Le jeton de l'adresse
est l'identifiant de la ligne suivi d'une signature HMAC-SHA-256 (160 bits)
de cet identifiant et du centre, par une clé dérivée d'`AUTH_SECRET`. Il se
recalcule pour l'affichage et se vérifie à temps constant à la lecture.

- Une copie de la base ne donne aucun lien.
- Régénérer remplace la ligne : nouvel identifiant, nouveau jeton.
- Désactiver supprime la ligne. Un réglage, pas une entité métier : supprimé
  physiquement, comme la connexion Google de l'ADR 014.
- Changer `AUTH_SECRET` change tous les liens (et déconnecte l'équipe) : les
  agendas abonnés doivent ajouter les nouveaux.
- Jeton inconnu, régénéré, désactivé ou ressource retirée : 404.

La seule lecture sans filtre de centre est celle de la ligne par son
identifiant : c'est le lien qui désigne le centre, comme le jeton du CRM
(ADR 065).

### 4. La connexion Google est retirée

Le code de l'ADR 014 et de l'ADR 069 est supprimé : connexion OAuth,
écriture après chaque réservation, identifiants Google Cloud, retour de
Google. Les trois tables (`google_oauth_clients`,
`google_calendar_connections`, `resource_google_calendars`) restent en
sommeil, sans code qui les lise : les supprimer est irréversible, une
migration le fera une fois vérifié ce qu'elles contiennent en production.
`GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` ne sont plus lues.

Le droit `agenda-google.gerer` garde son identifiant ; son libellé devient
« Agendas : liens d'agenda des ressources ».

Aucune dépendance ajoutée : le format iCalendar s'écrit en une centaine de
lignes, testées.

## Conséquences

- **Le délai** : Google Agenda relit un lien toutes les 8 à 24 heures, sans
  bouton pour forcer ; Outlook toutes les quelques heures ; Apple environ
  toutes les heures. Une réservation prise le matin pour l'après-midi peut ne
  pas apparaître à temps dans Google Agenda. L'écran le dit : pour un créneau
  imminent, le planning du site fait foi.
- **Le lien vaut mot de passe** : qui le reçoit voit le planning de la
  ressource, avec l'objet des réservations, qui peut porter le nom d'un
  client. L'écran demande de ne le donner qu'à l'équipe et de le régénérer
  s'il a circulé. L'adresse figure aussi dans les journaux nginx (ADR 051),
  comme le `?jeton=` du CRM.
- **RGPD** : le site n'envoie plus rien à Google ; c'est l'application à
  laquelle l'équipe ajoute le lien qui le lit et le garde. Le registre des
  traitements (T8) est mis à jour.
- **Dolibarr** : l'agenda du camion ne se donne plus par un code
  d'intégration Google (ADR 064), mais par le lien, que Dolibarr sait lire
  (module Agenda, calendriers externes). Marche à suivre :
  `docs/exploitation/agenda-google-dans-dolibarr.md`.
- Ce qui était écrit dans un agenda Google par la connexion y reste : ces
  agendas ne sont plus tenus à jour et peuvent être supprimés depuis Google
  Agenda. L'accès donné au site se retire depuis le compte Google (Sécurité >
  Applications tierces).

## Alternatives écartées

**Garder la connexion Google à côté du lien.** Deux façons de faire la même
chose sur le même écran : c'est la complexité que la demande veut retirer.

**Un seul lien pour tout le centre.** Toutes les ressources mêlées dans un
agenda : on ne voit plus d'un coup d'œil si une salle est libre, et le
camion ne s'isole plus pour Dolibarr. Un lien par ressource reprend le
découpage de l'ADR 014.

**Garder le jeton en base, en clair ou chiffré.** En clair, une copie de la
base donnerait tous les liens ; chiffré, il faudrait une clé de plus. La
signature se recalcule et ne laisse rien à protéger en base.
