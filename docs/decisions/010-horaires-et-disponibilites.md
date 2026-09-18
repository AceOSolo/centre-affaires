# ADR 010 — Horaires d'ouverture et disponibilités

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Jusqu'ici l'application supposait une ouverture de 7h à 20h, sept jours sur
sept, écrite en dur dans une constante du module planning. Cette constante
servait à deux choses très différentes : l'amplitude du planning en back-office,
et le calcul des créneaux libres annoncés sur le site public.

La conséquence était visible : le site public proposait des créneaux le dimanche
matin, et le planning affichait treize heures de grille un jour férié. Un centre
qui ferme entre 12h et 14h voyait sa pause déjeuner annoncée comme disponible.

Les horaires sont par ailleurs le socle de tout ce qui reste à construire — une
annonce qui affiche « disponible » et un agenda honnête ont tous deux besoin de
savoir quand la ressource est ouverte.

## Décision

### Deux tables, `opening_hours` et `closures`

`opening_hours` : une ligne par plage et par jour de semaine. Deux lignes pour
une journée coupée à midi. `weekday` suit ISO 8601, 1 = lundi … 7 = dimanche,
comme `extract(isodow)`.

`closures` : fermetures exceptionnelles, en journées entières, bornes comprises.

### Les horaires sont en `time`, pas en `timestamptz`

« Ouvre à 9h00 » est une heure murale : elle ne bouge pas au changement d'heure,
contrairement à l'instant qu'elle désigne. La conversion en instants se fait
jour par jour, ce qui donne une journée d'ouverture de 9 heures même lorsque la
journée civile en fait 23 ou 25.

C'est le troisième type temporel du projet, et le découpage est maintenant net :
`timestamptz` pour un moment (décision 4), `date` pour une borne de calendrier
(ADR 006), `time` pour une heure murale récurrente.

### Les règles d'une ressource remplacent celles du centre

Une ressource qui a ses propres plages ignore entièrement celles du centre, au
lieu de s'y ajouter.

Le cumul ne permettrait d'exprimer qu'une ouverture élargie — une salle ouverte
le samedi dans un centre fermé le samedi — mais pas l'inverse, qui est plus
fréquent : une salle fermée le lundi dans un centre ouvert le lundi. Le
remplacement couvre les deux cas.

### Les horaires par défaut sont posés en base, pas dans le code

La migration 0011 insère 9h–18h du lundi au vendredi pour chaque centre.

Un repli dans le code — « si aucune règle, alors 9h–18h » — masquerait une
configuration oubliée et rendrait impossible d'exprimer un centre réellement
fermé. Les lignes posées en base sont visibles et modifiables à l'écran.

### « Fermé » et « complet » sont deux réponses différentes

`listDayAvailability()` renvoie un drapeau `closed` distinct d'une liste de
créneaux vide. Le site public doit pouvoir écrire « fermé le samedi » plutôt que
de laisser croire que tout est réservé.

### Une réservation hors ouverture reste possible en back-office

Le staff doit pouvoir poser une réservation exceptionnelle un jour férié. Le
planning affiche alors la grille sur l'amplitude de repli et grise les heures de
fermeture, colonne par colonne. Le site public, lui, ne propose rien hors des
plages d'ouverture.

## Justification

**Pourquoi des plages plutôt qu'un couple ouverture/fermeture par jour.** La
pause déjeuner est la règle dans un centre d'affaires, pas l'exception. Un
modèle à deux colonnes obligerait soit à annoncer midi comme disponible, soit à
poser une fausse réservation pour le bloquer.

**Pourquoi les fermetures en journées entières.** Une indisponibilité de
quelques heures relève du statut de la ressource (`maintenance`) ou d'une
réservation de blocage. Un troisième mécanisme à granularité horaire ferait
trois façons de dire la même chose, et trois endroits à consulter pour savoir si
une salle est libre.

**Pourquoi le moteur est une fonction pure.** `openingWindows()` ne touche pas à
la base et ne connaît aucun fuseau implicite : elle reçoit des règles, une date
et un fuseau, et rend des instants. C'est ce qui permet de la tester sur les
deux changements d'heure de l'année sans base de données — vingt-trois tests,
dont la journée de 23 heures et celle de 25.

## Alternatives écartées

**Garder la constante et ajouter un champ « horaires » sur le centre**
(par exemple `opensAt`/`closesAt` sur `tenants`) : plus petit, mais ne couvre ni
la pause déjeuner, ni le samedi, ni une salle aux horaires propres. Le besoin
est arrivé dès la première question posée sur les disponibilités.

**Un calendrier de créneaux pré-générés** en base, une ligne par créneau
réservable : rend les requêtes triviales mais impose de regénérer à chaque
changement d'horaire, et fixe d'avance la granularité. Le calcul à la lecture
reste peu coûteux — quelques dizaines de règles par centre.

**Modéliser les jours fériés français** dans le code : la liste bouge, elle
diffère selon les départements, et un centre choisit d'ouvrir ou non. Une
fermeture saisie est plus juste qu'une liste devinée. À reconsidérer sous forme
de proposition de saisie, pas d'automatisme.

## Conséquences

Positives : le site public n'annonce plus de créneaux le dimanche. Le planning
montre l'ouverture réelle et grise le reste. Les annonces publiques et les
agendas à venir s'appuieront sur une notion de disponibilité unique, et non sur
une constante recopiée.

Négatives : une ressource sans horaires hérite de ceux du centre, et une
ressource avec un seul horaire particulier perd tous les autres. C'est le prix
du remplacement plutôt que du cumul ; l'écran de gestion le dit explicitement.

La constante `FALLBACK_EXTENT` subsiste dans le module planning, mais ne sert
plus qu'à donner une hauteur à la grille d'un jour fermé. Elle n'intervient plus
dans aucun calcul de disponibilité.

**Reste à faire** : les fermetures exceptionnelles ne sont pas encore affichées
sur le site public — une page d'annonce devra dire « fermé du 24 décembre au 2
janvier » plutôt que d'afficher un calendrier vide.
