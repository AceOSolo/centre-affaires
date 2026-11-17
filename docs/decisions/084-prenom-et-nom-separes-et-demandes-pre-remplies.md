# ADR 084 — Prénom et nom séparés, demandes pré-remplies pour un client connecté

**Date** : 2026-11-17
**Statut** : accepté. Complète l'ADR 077 (« Mon compte ») et l'ADR 074
(formulaires de demande). Migration 0025.

## Contexte

Demande du responsable produit : « quand tu réserves en étant connecté, ça doit
remplir automatiquement les champs nom, prénom, etc. Les champs nom et prénom
doivent toujours être deux champs différents. »

Le formulaire de demande sur créneau (salle, bureau, véhicule, matériel)
n'avait qu'un champ « Nom et prénom » ; celui de la domiciliation les séparait
déjà (ADR 074). Aucun ne reprenait les coordonnées d'une personne connectée à
son espace client. « Mon compte » (ADR 077) ne gardait qu'un nom complet
(`client_members.full_name`), d'où l'on ne peut pas retrouver le prénom d'un
« Jean Pierre Martin ».

## Décision

- **Prénom et nom sont deux champs** dans les deux formulaires publics et dans
  « Mon compte », chacun obligatoire et borné à 100 caractères
  (`modules/clients/prenom-nom.ts`, partagé par les formulaires et le serveur).
- **`client_members` gagne `first_name` et `last_name`**, nuls pour un accès
  qui n'a pas encore été enregistré depuis « Mon compte ». `full_name` reste :
  il est recomposé « Prénom Nom » à chaque enregistrement, et tout ce qui le
  lisait (fiche client, demandes, courriels, cloche) continue de le lire.
- **Les demandes de la page publique partent pré-remplies** pour une personne
  connectée qui a un espace client : prénom, nom, téléphone de « Mon compte »,
  adresse du compte, et l'entreprise quand elle n'en représente qu'une. Tout
  reste modifiable. La demande garde, comme avant, le nom complet du demandeur.
- **Un accès d'avant cette décision** n'a que son nom complet : le premier mot
  est proposé en prénom, le reste en nom (`splitFullName`). Ce n'est qu'un
  pré-remplissage à vérifier, jamais écrit en base tel quel ; il disparaît dès
  que la personne enregistre « Mon compte ».
- **La lecture est sans effet de bord** (`loadKnownContact`) : elle ne passe pas
  par `clientAccess`, qui rattache et crée au besoin une fiche d'inscription,
  pour qu'une simple visite de la page d'accueil — par un membre de l'équipe,
  par exemple — ne crée rien. Un visiteur anonyme ou un compte sans entreprise
  ne reçoit rien.
- **RGPD** : le prénom et le nom sont effacés à l'anonymisation de l'accès, par
  le trigger qui efface déjà le téléphone (`74-cloche-client.sql`) ; la
  contrainte `client_members_anonymized_no_names` le vérifie.

## Hors périmètre, à confirmer en recette

Les formulaires du back-office gardent un champ unique : contact d'une
entreprise (qui peut être le nom d'un cabinet), invitation d'un client, membre
de l'équipe. Les séparer demanderait la même migration sur `client_contacts`
et `staff_members`.
