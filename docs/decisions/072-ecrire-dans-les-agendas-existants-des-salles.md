# ADR 072 — Écrire dans les agendas Google existants des salles

**Date** : 2026-11-05
**Statut** : accepté — remplace l'ADR 071 (lien `.ics` par ressource, retiré)
et rétablit les ADR 014 et 069, amendés : le site écrit dans les agendas que
le compte du centre a déjà, au lieu de ne créer que les siens. Sans migration.

## Contexte

Le même jour, l'ADR 071 avait remplacé la connexion Google par un lien `.ics`
par ressource. Il est apparu ensuite que le centre tient **déjà** un agenda par
salle dans le compte Google du centre (« 1 Salle Mont Blanc », « 2 Salle Albert
EINSTEIN », « 3 Salle Old Trafford », « Autre Salle »…), à côté d'autres
agendas (formations, anniversaires).

Un lien `.ics` ne peut pas remplir ces agendas : Google l'ajoute comme un
agenda de plus, en lecture seule, sous « Autres agendas », relu toutes les 8 à
24 heures. L'ADR 014, lui, ne savait écrire que dans des agendas créés par
l'application. Ni l'un ni l'autre ne correspond à l'organisation du centre.

La direction a choisi (05/11/2026) que les réservations du site arrivent
**directement dans les agendas existants**.

## Décision

### 1. L'agenda de chaque salle se choisit dans la liste du compte

Une fois le compte connecté, l'espace des agendas liste les ressources ; pour
chacune, une liste déroulante propose :

- « Aucun agenda » ;
- les agendas **dont le compte est propriétaire** (`calendarList`,
  `minAccessRole=owner`), l'agenda principal d'abord — ceux qu'on lui partage
  ne sont pas proposés, le site ne pourrait pas y écrire ;
- « Créer un nouvel agenda pour cette ressource », comme l'ADR 014.

Un seul bouton, « Enregistrer les agendas », applique les changements. Le
serveur vérifie que chaque agenda choisi est bien l'un de ceux du compte : le
formulaire ne peut pas faire écrire le site ailleurs. Plusieurs ressources
peuvent partager un agenda (« Autre Salle ») ; chaque événement porte le nom
de sa ressource dans son lieu.

La liste est relue chez Google à chaque affichage de l'écran : un agenda
renommé ou supprimé y apparaît tel qu'il est. Un agenda relié mais disparu du
compte reste affiché, « introuvable », pour ne rien changer sans le vouloir.

### 2. Ce qui est écrit ne change pas

Mêmes règles que l'ADR 014 : réservations confirmées écrites après la réponse,
déplacées ou retirées avec elles ; identifiant d'événement dérivé de la
réservation ; ni nom, ni courriel, ni téléphone du demandeur, ni notes.

**Le site ne touche qu'à ses propres événements.** Il n'en lit aucun, et ne
modifie ou ne supprime que ceux dont il a dérivé l'identifiant. Les
réservations saisies à la main par l'équipe dans ces agendas restent
intactes.

### 3. Changer l'agenda d'une salle

- Relier une salle à un agenda y recopie ses réservations confirmées à venir.
- Quitter un agenda (autre agenda choisi, ou « Aucun agenda ») en retire les
  réservations à venir que le site y avait écrites. Le passé y reste. Sans
  cela, l'ancien agenda montrerait des créneaux qui ne seraient plus tenus à
  jour.

### 4. Des autorisations élargies, au plus juste

| Scope | Pour |
| --- | --- |
| `calendar.calendarlist.readonly` | lire la liste des agendas, pas leur contenu |
| `calendar.events.owned` | écrire des événements dans les agendas dont le compte est propriétaire |
| `calendar.app.created` | créer un agenda pour une ressource qui n'en a pas |

Plus `openid email` pour afficher le compte. Ni `calendar` (contrôle complet,
partage, suppression d'agendas), ni `calendar.events` (événements de tous les
agendas, y compris ceux qu'on partage au compte). La connexion exige les trois
autorisations ; décochées sur la page de Google, la connexion est refusée.

Une connexion faite avant cet ADR n'a que `calendar.app.created` : Google
refuse la liste des agendas, et l'écran propose « Reconnecter le compte
Google ».

### 5. Reconnecter le même compte garde les choix

Jusqu'ici, toute reconnexion supprimait les liaisons des ressources
(ADR 014). Désormais, si le compte reconnecté est le même (même adresse), seul
le jeton est remplacé : les agendas des salles restent. Un autre compte
remplace l'ancien et emporte ses liaisons, comme avant.

### 6. Le lien `.ics` est retiré

Le code de l'ADR 071 (écran, adresse `/api/agendas/…`, signature) est
supprimé. La table `calendar_feeds` reste en sommeil, sans code qui la lise ;
une migration la supprimera. Les identifiants Google Cloud réglés à l'écran
(ADR 069) reprennent du service, ainsi que le code d'intégration de chaque
agenda pour la page Dolibarr (ADR 064), qui vaut aussi pour un agenda
existant.

## Justification

**Pourquoi revenir sur l'ADR 014, qui refusait cet accès.** Il le jugeait
disproportionné pour un centre qui n'avait pas d'agendas. Le centre en a, et
les tient déjà : ne pas y écrire obligerait l'équipe à tenir deux agendas par
salle. `calendar.events.owned` et `calendar.calendarlist.readonly`, apparus
depuis, restreignent l'accès aux agendas du compte et à leur liste, sans le
contenu des agendas partagés, sans droit de partage ni de suppression d'un
agenda.

**Pourquoi la liste relue à chaque affichage plutôt que gardée en base.** Elle
change dans Google (agenda renommé, supprimé) sans que le site le sache ; la
garder exigerait une migration et une synchronisation de plus, pour un écran
qu'un administrateur ouvre rarement.

## Conséquences

- **Accès plus large** : le site voit le nom de tous les agendas du compte —
  y compris ceux qui portent un nom de personne (« GASQUET GUILLAUME… ») — et
  peut écrire dans tous ceux dont le compte est propriétaire. Il ne garde
  aucun de ces noms ; ils ne s'affichent qu'à l'administrateur, dans la liste.
  Le registre des traitements (T8) est mis à jour.
- **Sens unique, toujours** : une réservation saisie directement dans Google
  Agenda n'arrive pas dans le site. Pour éviter les doubles réservations, les
  réservations des salles reliées se prennent dans le site.
- **Un appel à Google à chaque affichage de l'écran** : Google lent ou en
  panne, la liste ne s'affiche pas et l'écran le dit ; les réservations, elles,
  continuent d'être faites en base.
- **Après mise en ligne** : reconnecter le compte une fois pour accorder les
  nouvelles autorisations, puis choisir l'agenda de chaque salle.

## Alternatives écartées

**Garder le lien `.ics`.** Un agenda de plus par salle, en lecture seule,
relu par Google jusqu'à 24 heures plus tard : voir le contexte.

**Les deux, écriture directe et lien.** Proposé à la direction, qui a choisi
l'écriture directe seule : deux façons de faire la même chose sur le même
écran.

**Le scope `calendar.events`.** Il ouvrirait aussi les agendas que d'autres
partagent au compte (les « Autres agendas »), où le site n'a rien à écrire.
