# ADR 010 — Calendrier de sélection d'un créneau

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Demander un créneau se faisait par saisie : une liste déroulante d'espaces, un
champ date, deux champs heure. Le portail affichait bien les plages libres du
jour sous forme de pastilles cliquables, mais rien ne montrait la forme d'une
semaine, et le back-office n'annonçait un conflit qu'après l'envoi — la
contrainte d'exclusion tranchait, l'écran expliquait ensuite.

Il fallait un calendrier visuel où l'on choisit ses heures, et qui tienne compte
de ce qui est déjà réservé, de part et d'autre : portail et back-office.

Les briques de calcul existaient déjà et n'ont pas bougé : `availability.ts`
pour le chevauchement, `slots.ts` pour les plages libres, `planning.ts` pour la
géométrie, `ouverture.ts` pour les horaires et fermetures.

## Décision

### Une grille de cellules, en plus de la géométrie au pourcentage

`planning.ts` positionne des blocs de hauteur proportionnelle : c'est ce qu'il
faut pour *montrer* une réservation. Choisir demande l'inverse — des cases
régulières, cliquables ou non. D'où `selection.ts`, second découpage de la même
journée, au pas de trente minutes.

Les deux découpages coexistent parce qu'ils répondent à deux questions. Les
fondre donnerait soit des blocs inclickables, soit des cases qui mentent sur la
durée réelle d'une réservation.

### Le choix se fait en deux clics, pas au glissement

Premier clic l'heure de début, deuxième l'heure de fin. C'est le seul geste
identique au doigt et à la souris : un glissement sur téléphone entre en
conflit avec le défilement de la page, et demanderait une seconde interaction
pour le portail mobile.

Un clic dans la sélection en cours l'efface. Un deuxième clic qui enjamberait
une réservation ne fait pas rien — ce qui passerait pour une panne — il relance
la sélection sur la case cliquée.

### Les champs restent la seule vérité, le calendrier les écrit et les relit

La sélection affichée est déduite des trois champs date, début et fin ; elle
n'est jamais tenue en parallèle. Une sélection faite à la souris se corrige donc
au clavier, et l'inverse se voit aussitôt dans la grille.

Conséquence voulue : le formulaire reste utilisable sans toucher au calendrier,
et le staff peut saisir un créneau hors ouverture — une salle prêtée un jour
férié — que la grille refuserait de proposer.

### Le portail glisse sur sept jours, le back-office suit la semaine calendaire

Le staff dit « mardi prochain » : sa semaine va du lundi au dimanche. Un
visiteur qui arrive un vendredi n'a que faire des quatre jours révolus ; son
calendrier part d'aujourd'hui. Même composant, même chargement, un paramètre.

### Le portail ne reçoit jamais le détail des réservations

`loadWeekCalendar()` ne rend que des cases et leur état. Le titre d'une
réservation, le nom du client, la note — rien de tout cela ne quitte le
back-office. La page `/reservations/nouvelle` charge ces détails séparément
pour nommer le créneau qui bloque ; le portail affiche « déjà réservé » et
s'arrête là.

### Le verdict précède l'envoi, sans devenir l'autorité

Le back-office annonce « créneau libre », « occupé par … » ou « hors des heures
d'ouverture » à mesure que les heures changent, sans aller-retour serveur : les
cases de la semaine sont déjà côté client. La contrainte d'exclusion reste seule
juge (décision 3), et l'action renvoie toujours le nom de la réservation qui
occupe la place.

Trois cas et non deux : confondre « fermé » et « occupé » ferait passer un jour
férié pour un conflit, alors que le staff a le droit d'y réserver.

### Déplacer une réservation est une opération à part

`/reservations/[id]/modifier` change les heures, la ressource, ou les deux. Pas
l'objet ni les notes : déplacer une réunion et la renommer sont deux intentions
différentes, et les mêler ferait d'un écran de planning un formulaire d'édition.

La réservation déplacée est retirée des cases occupées de sa propre grille —
sinon elle s'opposerait à elle-même et son créneau actuel serait le seul
inatteignable. `selectConflicts()` l'exclut de la même façon côté base.

Une réservation annulée ne se déplace pas : son créneau est libéré et sa ligne
ne subsiste que pour l'historique (décision 6). La ressusciter en la déplaçant
ferait réapparaître un créneau que la contrainte croyait libre.

## Justification

**La couleur ne porte pas l'information.** Une case de trente minutes n'a pas la
place d'un libellé. Les cases occupées sont donc hachurées, pas seulement
teintées : la trame est un second canal, doublé d'une légende et d'un
`aria-label` par case — « Mardi 10h00 à 10h30, déjà réservé ».

**Un vrai tableau, avec un `tabIndex` roulant.** Sept jours de cases font
cent-soixante boutons ; les mettre tous dans l'ordre de tabulation rendrait la
page intraversable au clavier. `role="grid"`, une seule case dans l'ordre de
tabulation, les flèches pour se déplacer, `Home` et `End` pour les extrémités.
Les colonnes sont des jours et les lignes des créneaux : un lecteur d'écran
annonce « mardi, 10h00 » sans qu'on ajoute quoi que ce soit.

**Les cases non disponibles restent focalisables** (`aria-disabled` plutôt que
`disabled`). Un utilisateur au lecteur d'écran doit pouvoir constater *pourquoi*
un créneau ne se prend pas, pas seulement ne pas l'atteindre.

**Le comptage se fait sur la durée écoulée.** Le jour du passage à l'heure d'été,
une fenêtre murale de 1h à 5h ne dure que trois heures : six cases, pas huit.
Compter sur l'amplitude murale proposerait un créneau qui n'existe pas
(décision 4). C'est testé dans les deux sens.

**La contrainte d'exclusion vaut aussi pour l'`UPDATE`.** Un déplacement n'est
pas une insertion, et rien ne garantissait a priori que Postgres compare la
ligne modifiée aux autres sans se heurter à son ancienne place. Deux tests de
base le vérifient : une réservation glisse sur son propre créneau, et se voit
refuser celui d'une voisine.

**Bornes `[)` reproduites à l'identique.** Une réservation qui finit à 10h00
laisse la case de 10h00 libre, exactement comme la contrainte d'exclusion. Un
écart ici ferait refuser en base un créneau que l'écran annonce libre.

## Alternatives écartées

**Le glisser-déposer** : plus naturel à la souris, mais il faut un second geste
pour le téléphone, donc deux codes à écrire et à tester pour un même écran. Le
portail est vérifié à 375 px, la charte l'exige.

**Des créneaux prédécoupés à cliquer** (une heure, une demi-journée) : le plus
simple, mais impossible de demander de 10h15 à 11h45, et le centre loue à
l'heure autant qu'à la demi-journée.

**Un aller-retour serveur pour vérifier la disponibilité à chaque frappe** : une
requête par caractère saisi, pour une réponse que le client peut déjà calculer.
Les cases de la semaine sont chargées une fois avec la page.

**Fusionner le planning du back-office et le calendrier de sélection** : deux
lectures, deux besoins. Le planning montre les réservations à leur taille réelle
et permet de cliquer dedans ; le calendrier propose des cases de saisie. Le
second ne remplace pas le premier.

## Conséquences

Positives : portail et back-office posent la même question au même chargement,
donc ne peuvent pas diverger sur ce qui est libre. Chaque ressource a son propre
emploi du temps de bout en bout — les horaires sont résolus pour elle, une
fermeture peut ne viser qu'elle.

Négatives : changer d'espace ou de période recharge la page. C'est volontaire —
les liens et le formulaire GET marchent sans JavaScript et l'URL se partage —
mais la sélection en cours est perdue au passage.

**Reste à faire** :

- **La demi-journée n'est toujours pas un créneau.** `MINUTES_PER_HALF_DAY` est
  un diviseur de facturation (ADR 009) ; rien n'empêche de demander 10h-14h et
  d'être facturé une demi-journée à cheval sur le matin et l'après-midi. Si le
  centre la vend comme un créneau nommé, il faut la rendre réservable comme tel.
- **Le pas de trente minutes est une constante**, pas un réglage du centre.
- **L'objet et les notes ne se corrigent nulle part.** `/reservations/[id]/modifier`
  déplace une réservation — d'autres heures, une autre ressource — mais renommer
  une réunion demande encore de l'annuler et de la refaire.
