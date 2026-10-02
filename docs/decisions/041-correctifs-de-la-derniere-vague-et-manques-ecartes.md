# ADR 041 — Correctifs de la dernière vague : export comptable après anonymisation, rattrapage du courrier, tâche de nuit, et manques de schéma tranchés

**Date** : 2026-10-02
**Statut** : accepté — corrige l'ADR 040 (compte auxiliaire figé, anonymisation
tracée) et l'ADR 037 (rattrapage des demandes non facturées) ; précise les
ADR 030, 036, 038 et 039 ; les choix marqués « à valider » attendent le centre

## Contexte

La revue de la dernière vague (ADR 036 à 040) a relevé quatre défauts, et son
intégration vingt-deux manques de schéma (`docs/roadmap.md`). Cet ADR corrige
les premiers et tranche les seconds : ce qui se construit maintenant
(migration 0044), et ce qui est écarté, avec la raison. Le critère est celui
du cahier des charges, en particulier « chaque demande et chaque document
restent consultables dans l'espace client » (slide 9) et « chiffrement au
repos, accès restreint et journalisé, purge programmée » (slide 21).

## Décision

### 1. Le livre d'une période passée ne change pas quand ses clients sont anonymisés

L'export FEC lisait le nom vivant du client, et en dérivait son compte
auxiliaire faute de compte saisi. L'anonymisation remplace ce nom par
« Client anonymisé » et le début de l'identifiant — le même pour tous, un
UUID v7 commençant par l'horodatage. Deux clients anonymisés dérivaient donc
le même compte : l'export de leur période était refusé pour toujours (la
fiche, archivée et figée, ne peut plus recevoir de compte), et tout export
déjà remis changeait.

- **Les libellés viennent de la pièce.** `CompAuxLib` et `EcritureLib` lisent
  le nom de l'acheteur dans `invoices.buyer_snapshot`, figé à l'émission,
  jamais `clients.name`. Un compte auxiliaire porte un seul libellé par
  fichier : celui de la pièce la plus récente de la période. Renommer une
  fiche ne réécrit donc plus non plus le livre d'une période passée.
- **Le compte auxiliaire est figé à l'anonymisation.** `anonymize_client_rows`
  pose `accounting_code = coalesce(accounting_code,
  derive_accounting_code(ancien nom))` pour un client qui a au moins une pièce
  émise. `derive_accounting_code()` est le jumeau SQL de
  `deriveAccountingCode` (fec.ts) ; un test les compare, caractères
  particuliers compris (ß, ı, ligatures).
- **Sans suffixe.** La revue proposait de suffixer un code « déjà pris ». Le
  code figé est celui que les exports passés donnaient déjà au client : le
  suffixer les changerait tous, ce que la correction veut éviter. Aucune
  collision nouvelle n'apparaît dans une période passée, et l'index d'unicité
  des comptes ne porte que sur les fiches vivantes. Si un client vivant prend
  un jour le même compte dans une période commune, l'export le refuse en les
  nommant, et le compte du client vivant se corrige à l'écran des comptes.

Effet sur l'existant : un export enregistré avant ce correctif, pour un client
renommé depuis l'émission de ses factures, se relit « modifié » — il portait
le nom du jour, il porte désormais celui de la pièce.

### 2. Une demande de courrier jamais facturée est reprise par le lot suivant

Le lot ne chargeait que les demandes faites dans le mois de consommation. Une
réexpédition qui attendait ses frais d'affranchissement, ou la demande d'un
client dont la facture du mois était déjà émise, n'était jamais facturée, et
plus rien ne le disait.

- **Rattrapage.** Le lot charge aussi les numérisations et réexpéditions
  faites **avant** la période, non retirées et jamais tenues par une ligne
  d'acte. Leurs frais d'affranchissement les suivent.
- **Seulement ce qu'un lot a laissé de côté.** Une demande faite avant que son
  service n'entre au catalogue n'est pas reprise : créer le service
  « numérisation » ne refacture pas des mois de numérisations que le centre
  n'a jamais facturées. *À valider.*
- **Les inclus se comptent par mois de la demande** (ADR 035). Chaque mois
  repris est chargé en entier, facturé ou non, et valorisé à part : une
  demande rattrapée prend le rang qu'elle avait dans son mois, sans entamer
  les inclus du mois en cours.
- **L'avertissement dit quoi faire.** Quand la facture du mois est déjà
  émise, le lot distingue ce qui reste « à facturer à part » des lignes de
  demandes de courrier, « reprises par le lot suivant » : les facturer à la
  main les ferait payer deux fois, aucune ligne manuelle ne pouvant tenir une
  demande.

Le manque « `mail_requests_guard` fige les frais dès la ligne d'acte » est
**écarté** : avec le rattrapage, attendre les frais ne perd plus rien, et
l'acte et ses frais restent sur la même facture.

### 3. La tâche de nuit isole chaque étape

La route de conservation enchaînait ses étapes sans filet : une panne du
stockage, ou une erreur de la base sur une ligne, arrêtait tout, chaque nuit.

`runNightlyConservation` (`src/modules/rgpd/tache-de-nuit.ts`) exécute chaque
étape dans sa transaction et son propre `try/catch`, celles qui ne dépendent
que de la base d'abord — le journal des consultations des numérisations est
séparé de la purge des fichiers. Le bilan garde ce qui a été fait, `null` pour
une étape en échec, et la liste `failed` ; la route répond alors `500`, que la
tâche du serveur signale. Le journal nomme l'étape et le message de l'erreur,
jamais son détail, qui peut citer la ligne refusée.

### 4. Le client d'une réservation ne change plus quand la base le refuserait

La fiche proposait « Client rattaché » pour toute réservation ; pour une
réservation faite ou annulée depuis l'espace client, ou portant un état des
lieux, la base refusait et l'écran d'erreur s'affichait.

- La fiche affiche le client, figé, avec sa raison (`bookingClientLock`) :
  réservée ou annulée depuis l'espace client, état des lieux, ou **facture** —
  que la base ne refusait pas, alors que la ligne de facture resterait à
  l'ancien client.
- L'action rend un état (chargement, « Client enregistré », ou la raison du
  refus près du champ) ; la règle est revérifiée dans la transaction, et un
  refus de la base (`23503`, `23514`) est traduit en phrase.

### 5. Manques de schéma construits (migration 0044)

| Manque | Ce qui est fait |
|---|---|
| Confirmation d'une réservation ni datée ni attribuée | `bookings.confirmed_at`, posé par la base quand la réservation devient confirmée (`bookings_stamp_confirmation`), et `confirmed_by_staff_id`, posé par le code quand l'accueil accepte une demande. L'historique du client dit « Confirmée par le centre » ou « Confirmée immédiatement », daté ; la fiche du back-office le dit aussi. Les confirmations antérieures restent sans date |
| Pas de table des demandes d'offre | `offer_requests` : la demande du client, son auteur, sa date, son état (`requested`, `contracted`, `dismissed`), le contrat qui la traite, le motif d'un refus. RLS, portée client RESTRICTIVE, garde `offer_requests_guard` (`CA013`), une seule demande à traiter par entreprise et par offre. Le client la retrouve dans son historique (rubrique Contrats) ; l'accueil la traite dans « Demandes » : le contrat tiré de l'offre la clôt dans la même transaction, ou il l'écarte avec un motif. Elle compte dans la dernière activité et retient l'anonymisation tant qu'elle attend |
| Version de clé d'une photo immuable | `rekey_inspection_photo()` : seule voie par laquelle la version de clé change, et rien d'autre, y compris sur un état des lieux clos. `rekeyInspectionPhotos` réécrit le fichier à la même clé de stockage, comme pour les numérisations ; `infra/chiffrer-documents.ts` l'appelle. L'ancienne clé se retire quand l'essai à blanc ne trouve plus rien |
| Nom du modèle non figé avec sa version | `inspection_template_versions.name`, repris du modèle pour les versions existantes. Renommer un modèle en publie une version : un état des lieux garde le nom qu'il portait |
| Réserves du client sans borne en base | `inspections_client_remarks_length` : 2 000 caractères, comme la saisie |
| Ni auteur ni motif d'un effacement à la demande | `anonymized_by`, `anonymization_basis` (`retention`, `erasure_request`, `relationship_ended`) et `erasure_requested_on` sur `clients`, `client_members`, `staff_members`. Les fonctions `anonymize_client`, `anonymize_client_member` et `anonymize_staff_member` les exigent (`CA012`) ; la nuit trace « au terme », sans auteur. Le dialogue de confirmation demande le fondement et, pour une demande d'effacement, le jour où elle a été reçue |

**Un fondement, pas un motif libre.** Le motif d'un effacement saisi en texte
(« demande de M. Durand ») conserverait ce qu'il efface. Une catégorie et une
date suffisent à rendre compte (art. 5-2) et à vérifier le délai d'un mois
(art. 12-3).

### 6. Manques de schéma écartés

| Manque | Raison |
|---|---|
| `mail_requests_guard` fige les frais dès la ligne d'acte | Écarté : le rattrapage (§ 2) reprend la réexpédition une fois ses frais notés ; acte et frais restent sur la même facture |
| Pas de date d'envoi distincte pour une réexpédition | Écarté : l'accueil enregistre la réexpédition quand il la fait ; le numéro de suivi donne la date du transporteur. À reprendre si le centre saisit ses envois le lendemain |
| Ni TVA ni nature propres aux frais d'affranchissement | Décision de l'expert-comptable (débours ou prestation, ADR 037 « à valider ») : rien n'est construit avant |
| Une demande publique anonyme n'est pas prévenue de son issue | Décision du centre : l'ADR 005 fait répondre l'équipe ; écrire automatiquement à une personne qui n'est pas cliente est un traitement de plus à inscrire au registre |
| Aucun événement pour un retrait du client | Écarté : une demande annulée sort de la file de l'accueil, qui montre l'état du moment ; un courriel la doublerait |
| Le journal ne dit pas quel texte est parti ; modèles non versionnés | Écarté : le journal garde l'événement, l'objet, les destinataires et le statut ; le corps n'est pas conservé, par minimisation (ADR 038) |
| Pas d'expéditeur par centre | Écarté : un seul centre ; à reprendre avec le multi-centres |
| `inspection_photos` sans `purged_at` | Écarté : une photo ne se retire que d'un brouillon et ne se purge qu'après la clôture ; l'état de l'état des lieux dit lequel des deux |
| `inspections` sans `deleted_by` | Écarté : seul un brouillon se retire, et il n'a aucune valeur probante |
| Relances invisibles sous portée client | Écarté : le client reçoit chaque relance ; ouvrir le journal des relances, preuve tenue par le back-office (ADR 034), à la portée client est un choix du centre |
| Pas de titulaire du compte bancaire du centre | Écarté : le titulaire est la personne morale du centre, déjà affichée |
| Contrat signé (scan) non stocké | Écarté : le cahier des charges demande des contrats générés, archivés et consultables (fait, ADR 028), pas le dépôt d'un exemplaire signé ; la signature reste manuelle. À reprendre si le centre le demande, sur le modèle des photos (chiffrement, journal, purge) |
| Pas de durée propre aux expéditeurs des plis | Décision du centre (durées « à valider ») : ils partent avec l'entreprise, ce qui donne la durée proposée par le registre |
| Pas de fonction de prévision en lecture seule | Écarté : l'écran appelle les fonctions de la base elles-mêmes (`client_last_activity_on`, `client_anonymization_blockers`), un test tient l'accord |
| Les fonctions de nuit ne rendent qu'un total | Écarté : le détail se compte dans la même transaction (ADR 040) |
| `client_anonymization_blockers()` rend des phrases | Écarté : elles nomment les factures et les contrats ; un lien par exclusion est un confort |

## Justification

**Pourquoi lire l'instantané plutôt que la fiche.** L'instantané de l'acheteur
est figé à l'émission précisément pour qu'aucune modification de la fiche ne
change la pièce (ADR 026). Le livre comptable est fait de ces pièces : il doit
les suivre, pas la fiche du jour.

**Pourquoi une table pour les demandes d'offre.** Le journal des envois est
un journal : purgé au terme de sa durée, sans la personne qui demande, sans
état. Une demande est un fait métier que le client doit retrouver et que
l'accueil doit pouvoir clore.

**Pourquoi la base date la confirmation.** Comme l'annulation et les
transitions des demandes de courrier : une date posée par le code peut être
oubliée par un chemin, pas un déclencheur.

## Conséquences

- `docs/roadmap.md` : R24 et R33 n'ont plus de manque de schéma ; R29 n'attend
  plus que la validation des durées, les DPA et l'AIPD.
- `infra/serveur/README.md` : la tâche de nuit répond `500` si une étape
  échoue ; la rotation de clé rechiffre aussi les photos.
- Les exports comptables enregistrés avant ce correctif pour un client renommé
  depuis sont à régénérer.
- *À valider par le centre* : le rattrapage limité à ce qui a été fait quand
  le service existait au catalogue ; l'absence de courriel au client quand sa
  demande d'offre est écartée (il la lit dans son historique).

## Alternatives écartées

**Stocker le fichier de chaque export comptable.** Il resterait identique,
mais l'ADR 030 a choisi de le reconstruire et de le vérifier par son
empreinte ; lire les pièces rend la reconstruction stable.

**Ne verrouiller les frais d'affranchissement qu'à leur propre ligne.** L'acte
serait facturé un mois, ses frais le suivant : deux lignes sur deux factures
pour un même envoi.

**Un journal des demandes d'effacement à part.** Trois colonnes sur la ligne
anonymisée disent la même chose sans table de plus, et suivent la ligne.

## Tests

- `facturation/fec.test.ts`, `facturation/comptabilite-anonymisation.db.test.ts` :
  libellés de la pièce, dérivation SQL et JavaScript identiques, export d'une
  période avec deux clients anonymisés, export enregistré avant l'anonymisation
  inchangé.
- `facturation/lot.test.ts`, `facturation/lot-courrier.db.test.ts` : rang des
  inclus par mois, demande reprise par le lot suivant après une facture émise.
- `api/maintenance/conservation/conservation.db.test.ts` : stockage en panne,
  les autres étapes ont lieu, réponse `500`.
- `reservations/rattachement.test.ts`, `rattachement.db.test.ts`,
  `demandes.db.test.ts` : client figé et refus dit, confirmation datée.
- `facturation/offres-portail.db.test.ts`, `clients/historique-compte.test.ts` :
  demande d'offre en table, portée client, refus motivé, historique.
- `etats-des-lieux/rechiffrement.db.test.ts`, `etats-des-lieux-ecrans.db.test.ts`,
  `etats-des-lieux.db.test.ts` : photos rechiffrées, nom du modèle figé,
  réserves bornées.
- `rgpd/fondement.test.ts`, `rgpd/anonymisation.db.test.ts`,
  `clients/anonymisation.db.test.ts` : fondement, auteur et date tracés, refus
  sans eux.
