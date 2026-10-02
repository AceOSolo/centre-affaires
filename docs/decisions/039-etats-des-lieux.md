# ADR 039 — États des lieux : modèles versionnés par type, état clos figé, photos chiffrées

**Date** : 2026-10-02
**Statut** : accepté — met en œuvre la décision D8 de l'ADR 016, sauf la
compression par `sharp`, remplacée par une compression dans le navigateur ;
les choix marqués « à valider » attendent le centre

## Contexte

R06 demande des états des lieux d'entrée et de sortie, avec des champs
configurables par type de ressource, en base, des photos compressées, et un
lien vers la ressource et la réservation. R33 demande la compression et la
purge des photos stockées.

L'ADR 016 (D8) a retenu des modèles de champs en JSONB, versionnés, et une
compression avec `sharp`. La vague 3 s'interdit toute nouvelle dépendance :
la compression se fait dans le navigateur (canvas) avant l'envoi, le serveur
vérifie le type et la taille.

Les photos d'un local occupé sont des documents sensibles au même titre que
les scans de courrier : chiffrées au repos (ADR 020), consultation
journalisée.

## Décision

### Un modèle par type de ressource, en versions figées

- `inspection_templates` : un modèle vivant par type de ressource
  (`inspection_templates_type_key`), avec un nom ;
- `inspection_template_versions` : ses versions, numérotées (`version`, la
  précédente + 1, posée par le code ; l'unicité tranche entre deux
  publications simultanées). Une version publiée **ne change plus** : le
  rôle applicatif n'a ni `UPDATE` ni `DELETE`. Modifier un modèle, c'est
  publier une version.

Les champs (`fields`, JSONB) sont une liste d'objets, validée par la base
(`inspection_fields_error()`, contrainte) :

| Propriété | Règle |
|---|---|
| `id` | `^[a-z][a-z0-9_]{0,62}$`, unique dans la version : la clé de la valeur |
| `label` | libellé visible, non vide, 200 caractères au plus |
| `type` | `text`, `number`, `choice`, `checkbox` ou `condition` (note d'état) |
| `required` | booléen, exigé à la clôture |
| `unit` | nombre seulement (« kWh », « clés ») |
| `options` | choix seulement, 2 à 50 libellés distincts |
| `help` | aide sous le champ, facultative |

La note d'état suit une échelle commune, du meilleur au pire : `neuf`, `bon`,
`usage`, `mauvais` (`inspection_condition_levels()`, *à valider*).

Modèles et versions n'ont pas de client : ils se lisent depuis l'espace
client (les libellés s'y affichent), mais ne s'écrivent que depuis le
back-office (politiques restrictives d'écriture).

### Un état des lieux garde sa version

`inspections` : nature (`entry`, `exit`), ressource, client, réservation
et/ou contrat (au moins l'un, du même client — clés étrangères composites),
date (`performed_at`), valeurs (`values`, JSONB par identifiant de champ),
observations, auteur. Une sortie désigne l'entrée qu'elle clôt
(`entry_inspection_id`) : même ressource, même client (clé étrangère),
entrée close, une sortie par entrée.

`template_version_id` est la version avec laquelle il est saisi, et ne
change jamais : un modèle qui évolue ne réécrit pas un état des lieux passé.
La version est celle du **type** de la ressource.

### Brouillon, clôture, validation par le client

| Statut | Ce qui se passe |
|---|---|
| `draft` | Saisie au centre ; valeurs vérifiées contre la version (clés connues, types, options, échelle) ; un champ obligatoire peut attendre ; photos ajoutées, légendées, retirées ; le brouillon se retire (`deleted_at`). Invisible du client. |
| `closed` | Clôture par l'équipe (`closed_by`, `closed_at` posé par la base), refusée tant qu'un champ obligatoire est vide. **Figé** : ni valeurs, ni observations, ni photos, ni date. |
| validé | Le client valide depuis son espace, une fois : `signed_by_member_id` (une personne de l'entreprise), `client_remarks` (ses réserves), `signed_at` posé par la base. |

Garde `inspections_guard` (migration 0042) : `CA011` pour une saisie non
conforme, `CA010` pour un état figé. Un état des lieux ne se supprime pas.

La validation dans l'espace client tient lieu de signature. Une signature
électronique au sens du règlement eIDAS, ou la signature sur papier
numérisée, n'est pas couverte (*à valider*).

### Photos : compressées dans le navigateur, chiffrées, journalisées

`inspection_photos` : clé de stockage, **version de la clé de chiffrement
obligatoire** (pas d'objet hérité en clair : `sealDocument`, ADR 020), type
déterminé par le contenu (`image/jpeg`, `image/webp`, `image/png`), taille
en clair (10 Mio au plus), dimensions (pour réserver la place à
l'affichage), légende, champ illustré (un champ de la version), ordre,
auteur, `deleted_at`.

Le navigateur réduit et recompresse la photo (canvas, JPEG ou WebP) avant
l'envoi ; le serveur vérifie les premiers octets et la taille, chiffre,
dépose, puis écrit la ligne. Une photo se dépose sur un brouillon seulement
(`CA010` ensuite) et ne change jamais de fichier.

`inspection_photo_views` : journal des consultations, comme
`mail_scan_views` — ajout seul, lecture par le centre ou par le client
(portée), purge au terme de `inspection_access_log_retention_months`
(12 mois, *à valider*) par `purge_expired_inspection_photo_views()`.

### Conservation des photos

`tenants.inspection_photo_retention_months` : 36 mois par défaut (*à
valider* ; la preuve de l'état des locaux sert jusqu'au règlement du dépôt de
garantie et des litiges). Le délai court depuis **la clôture de la sortie** :
pour une sortie, la sienne ; pour une entrée, celle de la sortie qui la
désigne (`inspection_photo_retention_start()`). Une entrée sans sortie close
ne se purge pas : l'occupation dure, ou la sortie reste à faire.

La purge suit le modèle du courrier : le code lit
`expired_inspection_photos(limite)`, efface le fichier du stockage, puis
`mark_inspection_photo_purged(id)` marque la ligne (`deleted_at`) en
revérifiant l'échéance — seul chemin pour retirer une photo d'un état clos.

### Portée client

Sous portée client (ADR 019), une entreprise ne voit que ses états des lieux
**clos** et non retirés, leurs photos et leurs consultations. Elle ne saisit
rien : seule la validation passe.

## Justification

**Pourquoi le navigateur plutôt que `sharp`.** `sharp` embarque une
bibliothèque native : une dépendance lourde, à mettre à jour, pour un travail
que le canvas fait avant l'envoi. Le serveur n'a plus qu'à vérifier, et la
bande passante d'un téléphone sur place est épargnée.

**Pourquoi une validation en base.** Les écrans de saisie seront construits
par d'autres mains, et un état des lieux est une pièce probante : une valeur
hors du modèle, ou une clôture incomplète, ne doit pas pouvoir s'écrire.

**Pourquoi des versions plutôt qu'un modèle modifiable.** Un état des lieux
de 2026 relu en 2029 doit montrer les champs de 2026.

**Pourquoi la sortie fait partir le délai.** L'entrée est la référence de la
sortie : la purger avant serait perdre la comparaison qui fonde une retenue
sur le dépôt de garantie.

## Alternatives écartées

**Une table de champs et une table de valeurs.** Plus de jointures pour la
même garantie, que la fonction de validation donne sur du JSONB (D8).

**Un modèle par ressource.** Le cahier des charges dit « par type ».

**Garder les photos sans limite.** Contraire à R33 et au registre RGPD.

## Conséquences

- Le module `src/modules/etats-des-lieux/` porte le schéma ; la tranche
  états des lieux construit les modèles (`etats-des-lieux.modeles`,
  exploitant), la saisie, la clôture et les photos
  (`etats-des-lieux.gerer`, accueil et exploitant), la validation dans
  l'espace client, le service des photos (déchiffrement, journal) et la
  purge nocturne.
- Erreurs à traduire : `CA011` (le message dit quoi corriger), `CA010`
  (figé), `23505` (une sortie par entrée, un modèle par type, une version en
  double), `23503` (réservation ou contrat d'un autre client).
- Les événements `inspection_to_sign` et `inspection_signed` (ADR 038)
  préviennent le client puis le centre.
- *À valider par le centre* : l'échelle de note d'état, la durée des photos
  et du journal, la valeur de la validation en ligne comme signature.
