# ADR 013 — Séries et délais de réservation

**Date** : 2026-09-21
**Statut** : accepté

## Décision

Le planning propose « Ajouter en masse ». L’équipe choisit les ressources, une
période inclusive et plusieurs plages hebdomadaires. Chaque plage porte ses
jours et ses horaires. Le formulaire présente les occurrences avant l’envoi.
Un lot est limité à 500 occurrences, toutes ressources comprises, sur un an
au maximum. Les heures sont converties dans le fuseau du centre pour chaque
date, afin de conserver l’heure locale aux changements d’heure.

Les occurrences sont des réservations ordinaires, liées par `series_id`.
Le type `unavailability` permet de bloquer un créneau pour entretien ou
occupation régulière. Ces lignes confirmées bénéficient de la même contrainte
anti-chevauchement que les réservations et les demandes publiques. Leur titre
porte « Indisponible » dans le planning ; aucune identité n’est exposée au public.

Le lot est inséré dans une transaction. Tout conflit, même concurrent, refuse
le lot entier. Aucun créneau n’est ignoré silencieusement. Les réservations
restent possibles hors ouverture pour l’équipe, comme en saisie individuelle.

Chaque occurrence peut être déplacée ou annulée depuis sa fiche. La fiche
de série permet aussi d’annuler toutes les occurrences qui n’ont pas encore
commencé. Les occurrences passées, en cours et les autres séries sont conservées.
Une série a une date de fin et ne se prolonge pas automatiquement.

## Délais publics

« Disponibilités » permet de régler le préavis minimum en heures et l’horizon
maximum en jours, pour le centre. Les valeurs initiales restent 0 heure et
90 jours. L’horizon est compris entre 1 et 365 jours ; le préavis doit être
positif ou nul et strictement inférieur à l’horizon.

Ces durées sont glissantes, calculées en heures réelles à partir du dépôt,
et limitent le début de réservation. Les bornes exactes sont admises, sauf
l’instant présent. Elles sont appliquées dans les propositions du portail et
vérifiées à nouveau par l’action serveur. Elles ne limitent pas le planning admin.

La migration `0018_regles_et_series_reservations` ajoute les colonnes et
contraintes, avec des valeurs par défaut compatibles avec les lignes existantes.
Les tests couvrent les récurrences, le préavis, l’horizon, les conflits concurrents,
l’insertion atomique et la libération des créneaux après annulation de série.
