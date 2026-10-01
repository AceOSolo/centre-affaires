# ADR 011 — Annonces publiques et vue semaine

**Date** : 2026-09-18
**Statut** : accepté — la vue semaine est amendée par l'ADR 017 (semaine
toutes ressources filtrée par type, vue mois)

## Contexte

Le back-office savait gérer le parc, les réservations, les clients, les contrats
et les tarifs. Deux manques restaient pour couvrir ce que le centre fait
réellement :

- **Les annonces.** Le site public ne montrait qu'un tableau de créneaux libres
  du jour. Rien ne présentait ce que le centre loue : pas de titre, pas de
  descriptif, pas de prix affiché, pas d'adresse partageable. Un centre
  d'affaires se remplit d'abord parce qu'on trouve ses bureaux.
- **Les agendas.** Le planning ne répondait qu'à « qui occupe quoi
  aujourd'hui ». La question du quotidien est aussi « quand cette salle est-elle
  libre cette semaine », à laquelle une vue jour ne répond qu'en cliquant sept
  fois.

## Décision

### Une table `listings`, pas des colonnes sur `resources`

L'annonce est la face publique d'une ressource, dans une table à part, liée une
pour une.

Les deux objets changent à des rythmes différents et par des mains différentes :
la capacité et le statut relèvent de l'exploitation, le titre et le texte de la
vitrine. Toutes les ressources ne sont pas annoncées — un casier ne l'est
jamais — et `resources` n'a pas à porter six colonnes vides pour les quarante
boîtes aux lettres.

### Le slug est stocké, pas calculé

Il paraît dans l'URL publique et dans les moteurs de recherche. Le dériver du
titre à l'affichage casserait tous les liens partagés au premier renommage.

Il est calculé une fois à la création, à partir du titre, avec un suffixe
numérique en cas d'homonyme. Le staff peut le forcer, et l'écran l'avertit de ce
que cela coûte.

### Publication explicite, et trois conditions pour être visible

`published_at` nul vaut brouillon. Une annonce n'apparaît au public que si elle
est publiée, non archivée, **et** que sa ressource est encore en service.

Cette troisième condition évite un oubli classique : une salle mise en
maintenance disparaît du catalogue sans qu'on ait à penser à dépublier son
annonce. L'écran de gestion affiche alors « Masquée — hors service » plutôt que
de laisser croire à un bug.

### Le prix affiché vient de la grille, jamais de l'annonce

Le catalogue montre le tarif le plus fin que la grille par défaut propose — « à
partir de 90 € HT la demi-journée ». La page de détail les liste tous.

Une annonce qui porterait son propre prix serait un second endroit à tenir à
jour, et le premier à mentir.

### Les disponibilités annoncées sont les vraies

La page d'une annonce affiche sept jours, calculés par le même moteur que le
planning : plages d'ouverture réelles, fermetures exceptionnelles, réservations
déduites. « Fermé » et « complet » restent deux réponses distinctes (ADR 010).

### La vue semaine suit une ressource, pas le centre

Sept colonnes, une par jour, pour une ressource choisie. La vue jour fait
l'inverse — une colonne par ressource. Les deux répondent à des questions
différentes, et vouloir les fondre donnerait une grille à cinquante colonnes.

Les colonnes partagent une **amplitude murale commune** pour être comparables
d'un coup d'œil, mais chacune garde sa fenêtre en instants : une semaine qui
contient un changement d'heure reste juste.

## Justification

**Pourquoi le slug plutôt que l'identifiant.** Un UUID v7 dans l'URL d'une page
publique est illisible et ne dit rien à un moteur de recherche. Le slug est la
seule donnée de ce projet dont la stabilité prime sur l'exactitude : il doit
rester tel quel même quand le titre change.

**Pourquoi les points forts en JSONB plutôt qu'une table.** Une liste courte,
ordonnée, sans requête possible dessus et sans cycle de vie propre. Une table de
plus coûterait une jointure sur chaque page publique pour zéro service rendu.

**Pourquoi l'amplitude murale commune en vue semaine.** Sans elle, chaque
colonne aurait sa propre échelle et deux créneaux de même hauteur ne
désigneraient pas la même durée — la comparaison visuelle, qui est tout
l'intérêt de cette vue, serait fausse.

## Alternatives écartées

**Publier depuis la fiche ressource**, avec une case « visible sur le site » et
trois champs : plus court, mais mélange l'exploitation et la vitrine dans un
même écran, et oblige le staff à traverser l'inventaire pour corriger une faute
de frappe dans un descriptif.

**Générer le slug à l'affichage** à partir du nom de la ressource : supprime une
colonne, casse les liens au premier renommage. Le coût d'une colonne est très
inférieur.

**Une vue semaine toutes ressources confondues** : la grille deviendrait
illisible dès la dizaine de ressources, et le centre en compte une cinquantaine
avec les boîtes aux lettres. La vue jour couvre déjà ce besoin.

## Conséquences

Positives : le site public présente enfin ce qui est à louer, avec des prix et
des disponibilités qui ne peuvent pas diverger de ceux du back-office, puisque
ce sont les mêmes fonctions. Le staff publie et dépublie sans toucher au parc.

Négatives : une annonce de plus à tenir à jour par ressource. Le rattachement un
pour un rend impossible une annonce qui regrouperait « nos neuf bureaux » en une
seule page ; si ce besoin apparaît, il faudra une notion d'offre au-dessus de la
ressource, pas détourner celle-ci.

**Reste à faire** :

- **Les photos.** La colonne `photos` existe et reste vide : le téléversement
  demande le raccordement au stockage objet et des URL signées, ce qui est une
  tranche à part entière. Une annonce sans photo est une annonce faible.
- **Les fermetures sur la page publique.** Les jours fermés s'affichent
  « Fermé », mais rien n'annonce « fermé du 24 décembre au 2 janvier » en tête
  de page.
- **L'export iCal.** « Agendas » peut aussi vouloir dire un abonnement depuis
  l'agenda du staff. La vue semaine ne le remplace pas.
