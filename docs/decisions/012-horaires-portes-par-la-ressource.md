# ADR 012 — Les horaires sont portés par la ressource

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

L'ADR 010 a posé deux porteurs d'horaires : le centre, et la ressource. Une
ressource sans plage propre hérite de celles du centre ; une ressource qui en a
les remplace entièrement.

À l'usage, l'héritage est le mauvais défaut. Un centre d'affaires ne gère pas
une amplitude commune dont quelques salles s'écarteraient : chaque ressource a
son rythme propre. Une salle de réunion ouvre plus tard qu'un bureau, un casier
est accessible en permanence, un véhicule ne sort pas le week-end. Le cas
« comme le centre » est une coïncidence, pas une règle.

L'héritage avait par ailleurs une conséquence pratique désagréable : l'écran de
gestion ne montrait une ressource que lorsqu'elle avait déjà des horaires
particuliers, et la section entière disparaissait tant qu'aucune n'en avait. Le
réglage par salle existait dans le modèle sans exister à l'écran.

## Décision

### Toute ressource porte ses propres horaires

Une ressource déclarée reçoit, à sa création et dans la même transaction, une
copie des plages du centre. Elle ne dépend plus de personne ensuite.

Le mécanisme d'héritage de l'ADR 010 — `rulesForResource()` — **reste en
place**. Il n'est pas supprimé : il devient le filet pour une ressource qui
n'aurait pas reçu sa copie, et il reste ce qui donne son sens au modèle
multi-centres. Simplement, plus aucune ressource ne s'y appuie en
fonctionnement normal.

### Les horaires du centre deviennent un modèle

Ils ne décrivent plus l'ouverture effective de quoi que ce soit. Ils décrivent
ce que reçoit la prochaine ressource déclarée. L'écran le dit à l'endroit exact
où l'on se ferait prendre : « les modifier ne change rien aux ressources
existantes ».

### La reprise est explicite et rejouable

`copierHorairesDuCentre()` dote les ressources qui suivent encore le centre.
Elle **n'écrase jamais** une ressource qui a déjà ses plages : des horaires
saisis sont une décision de quelqu'un, pas un état par défaut à corriger.

Rejouable sans dommage, elle est exposée comme un bouton dans l'écran
Disponibilités plutôt que comme un script — l'opération appartient au métier,
pas à l'exploitation.

### Un centre sans horaires ne donne rien

Si le centre n'a aucune plage, une ressource nouvelle naît sans horaire, donc
visiblement fermée. Pas de repli en dur : c'est exactement la constante que
l'ADR 010 a retirée du code, et la reproduire ici rendrait de nouveau invisible
une configuration oubliée.

## Justification

**Pourquoi copier plutôt que supprimer l'héritage.** Supprimer
`rulesForResource()` obligerait à garantir qu'aucune ressource n'est jamais sans
plage — une contrainte que la base ne sait pas exprimer, et dont la violation
fermerait silencieusement une salle. Copier à la création et laisser l'héritage
en dernier recours donne le même résultat fonctionnel sans ce risque.

**Pourquoi la copie est dans la même transaction que la création.** Entre deux
écritures, la ressource existerait sans horaires et hériterait de ceux du
centre. C'est sans conséquence visible ici, mais l'invariant « une ressource a
toujours ses horaires » vaut mieux tenu que commenté.

**Pourquoi le dédoublonnage sur `(jour, heure d'ouverture)`.** C'est la clé de
`opening_hours_slot_key`. Un centre peut porter deux plages qui commencent à la
même heure le même jour si elles ont été saisies avant cet index ; les recopier
telles quelles ferait échouer l'insertion. La règle de copie suit la clé de la
base plutôt qu'une notion d'égalité à elle.

**Pourquoi ne pas écraser les horaires existants à la reprise.** C'est le seul
point où la reprise pourrait détruire du travail. Une salle réglée à la main
l'a été pour une raison, et une opération de confort ne doit pas pouvoir
l'annuler.

## Conséquences

**Le réglage de l'ouverture du centre ne se propage plus.** C'est le coût
central de cette décision, et il est assumé : changer l'horaire de dix salles
demande dix gestes. En contrepartie, aucun de ces dix gestes n'a d'effet de
bord sur les neuf autres.

À surveiller : si un centre finit par vouloir « décaler tout le monde d'une
heure », il faudra une action groupée sur plusieurs ressources. Elle n'est pas
écrite, et elle ne doit pas être écrite en rétablissant l'héritage.

**L'écran Disponibilités liste toutes les ressources en service**, chacune avec
ses plages, et indique pour chacune si elle porte les siennes ou suit encore le
centre. L'état est écrit en toutes lettres, pas porté par une couleur.

**Les ressources archivées ne sont pas listées** ni reprises : leurs horaires
restent en base, sans écran pour les montrer. C'est cohérent avec la décision 6
— on ne supprime pas — mais cela veut dire qu'une ressource réactivée retrouve
des horaires que personne n'a revus.

**La reprise doit être lancée une fois** sur les centres existants. Tant qu'elle
ne l'est pas, les ressources d'avant continuent d'hériter et se comportent comme
avant : la décision est sans effet rétroactif automatique.

## Alternatives écartées

**Garder l'héritage et se contenter de rendre l'écran par ressource visible.**
Le changement minimal, et il répondait à la gêne immédiate. Écarté sur demande
explicite : le besoin exprimé était que chaque salle soit gérée pour elle-même,
pas qu'on voie mieux une exception.

**Copier les horaires à la lecture plutôt qu'en base.** Une ressource sans
plage se verrait attribuer celles du centre au moment de l'affichage, et la
copie ne serait écrite qu'à la première modification. Écarté : deux ressources
identiques à l'écran auraient un contenu différent en base, et « pourquoi cette
salle a-t-elle changé quand j'ai touché le centre » redeviendrait une question.

**Une colonne `suit_le_centre` sur `resources`.** Rendrait l'intention
explicite et permettrait de rebasculer une salle sur l'héritage. Écarté pour
l'instant : c'est un troisième état à tenir dans tous les calculs de
disponibilité, pour un besoin — « remettre cette salle comme le centre » — que
personne n'a encore exprimé. À reconsidérer s'il se présente.
