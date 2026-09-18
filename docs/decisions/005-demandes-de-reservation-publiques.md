# ADR 005 — Demandes de réservation publiques

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Le back-office de la tranche 1 est utilisable : inventaire des ressources,
planning du jour, création et annulation de réservations. Tout y est fait par
l'équipe du centre.

La demande est d'ouvrir une page publique de réservation avant les tranches 2 et
3 (clients, contrats, facturation). Cette page s'adresse à **n'importe qui, sans
compte** : un prospect qui cherche une salle pour l'après-midi doit pouvoir
demander un créneau sans créer de compte ni signer de contrat. Une demande ainsi
déposée est **validée par le staff** avant de devenir ferme.

Deux choses manquent au schéma pour cela :

- une réservation ne sait pas qui la demande — `bookings` ne porte ni nom, ni
  contact, et n'est reliée à aucun client ;
- le statut `pending` est déclaré dans l'énumération depuis l'ADR 002 mais aucun
  écran ne le produit ni ne le traite.

La table `clients` existe depuis la tranche 2, avec un statut `prospect`. La
question n'est donc pas « où stocker un demandeur faute de table », mais « un
demandeur public mérite-t-il une fiche client dès le dépôt ».

L'ordre de construction de `CLAUDE.md` place le portail en tranche 4, après la
facturation. Cet ADR consigne le fait de le devancer, et ce que ça coûte.

## Décision

### Une demande publique est une ligne de `bookings` en `pending`

Pas de table `booking_requests` distincte. Une demande occupe le créneau dès son
dépôt : le prédicat de la contrainte d'exclusion est `status <> 'cancelled'`,
donc `pending` bloque déjà.

### L'identité du demandeur vit sur la réservation

Trois colonnes nullables sur `bookings` : `requester_name`, `requester_email`,
`requester_phone`. Nullables parce qu'une réservation posée par le staff pour un
usage interne n'a pas de demandeur externe.

Aucune contrainte de base ne les exige : le staff peut légitimement créer une
réservation `pending` sans contact. C'est l'action publique qui les rend
obligatoires, pas le schéma.

### Valider, c'est confirmer ; refuser, c'est annuler

Une demande acceptée passe à `confirmed`. Une demande refusée passe à
`cancelled` avec un motif, exactement comme une annulation. Pas de statut
`refused` supplémentaire.

### Garde-fous de l'écriture publique

L'action publique est le premier point d'écriture non authentifié du produit.
Elle refuse : un créneau dans le passé, une durée hors bornes, une ressource qui
n'est pas `active`, et plus de quelques demandes successives depuis la même
adresse.

## Justification

**Pourquoi pas une table séparée.** Une `booking_requests` à côté de `bookings`
ne serait pas vue par la contrainte d'exclusion. Deux personnes pourraient
déposer une demande sur le même créneau, et il faudrait réécrire en code la
vérification de chevauchement que la décision 3 confie précisément à la base.
C'est le contraire de ce que cette décision protège.

**Pourquoi des colonnes plutôt qu'une fiche client à chaque demande.** La table
`clients` existe et son statut `prospect` conviendrait sur le papier. Mais une
page publique reçoit des demandes non vérifiées, dont des dépôts automatisés :
créer une fiche client à chaque soumission remplirait le fichier clients de
lignes que personne n'a validées, et le SIRET — la clé qui empêche les doublons
de facturation — serait vide sur toutes.

Le sens de la lecture est donc l'inverse : une demande porte son contact en
propre, et c'est la **validation par le staff** qui peut la convertir en fiche
client. Le demandeur qui ne donne pas suite ne laisse aucune trace dans le
fichier clients. Beaucoup de demandeurs ne deviendront jamais clients — la
demande anonyme reste un cas à part, elle ne disparaît pas quand le portail
authentifié arrivera.

**Pourquoi pas de statut `refused`.** Le prédicat de `bookings_no_overlap` est
`status <> 'cancelled'`. Tout nouveau statut qui libère le créneau oblige à
modifier la contrainte d'exclusion et à reconstruire son index GiST sur une
table vivante. Un refus est fonctionnellement une annulation avant confirmation :
la ligne reste consultable, le motif est écrit, le créneau se libère. Le statut
existant dit déjà tout cela.

**Pourquoi `pending` bloque le créneau.** L'inverse — une demande qui n'occupe
rien — laisserait le staff valider deux demandes concurrentes sur le même
créneau, et la seconde validation échouerait sur la contrainte, face à un client
qui a déjà reçu un accusé de réception. Mieux vaut refuser au dépôt.

## Conséquences

**RGPD.** `bookings` contient désormais des données personnelles de personnes
qui ne sont pas clientes du centre : nom, adresse électronique, téléphone. Ce
sont les premières du produit. Il en découle une durée de conservation à définir
par type — une demande refusée ou expirée n'a pas à garder son contact
indéfiniment — et une purge à écrire. Elle n'est pas dans cet ADR.

**Le back-office doit être fermé.** Tant que tout était interne, l'absence
d'authentification était un risque théorique. Servir une page publique depuis le
même déploiement rend `(admin)` atteignable par quiconque en connaît l'URL.
better-auth, prévu par `CLAUDE.md`, devient un prérequis de mise en ligne et non
une étape ultérieure.

**Surface d'abus.** Une écriture publique non authentifiée invite le dépôt
automatisé. Les garde-fous ci-dessus limitent les dégâts sans les supprimer ; une
vraie limitation de débit devra s'appuyer sur l'hébergeur.

**L'ordre de construction est modifié.** Le portail passe devant la facturation
récurrente. Conséquence à assumer : `bookings` ne porte aucun `client_id`
aujourd'hui, donc une demande validée n'est rattachée à aucune fiche client et
n'est pas facturable en l'état. Relier les deux — colonne `client_id` sur
`bookings`, et conversion du demandeur en client à la validation — reste à
faire et justifiera son propre ADR.

## Alternatives écartées

**Attendre la tranche 4.** Respecte l'ordre de construction, et la page publique
aurait alors les clients et les tarifs. Écartée : la demande est explicite et
l'ordre de `CLAUDE.md` est un plan, pas une contrainte technique.

**Ouvrir la réservation directe sans validation.** Plus fluide pour le
demandeur. Écartée à l'arbitrage : le centre veut garder la main sur qui occupe
ses salles.

**Exiger un compte pour réserver.** C'est le portail client de la tranche 4, qui
reste prévu. Il ne remplace pas la page publique : un prospect ne crée pas de
compte pour demander une salle une fois.
