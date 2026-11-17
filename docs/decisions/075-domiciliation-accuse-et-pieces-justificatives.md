# ADR 075 — Domiciliation, après la demande : l'accusé de réception toujours, les pièces justificatives dans l'espace client

**Date** : 2026-11-17
**Statut** : accepté — lot 2 de la recette du 17/11 (`docs/recette/2026-11-17.md`),
tranché en l'absence du responsable produit : chaque choix marqué « à
confirmer en recette » sera revu avec lui. Revient sur l'ADR 068 § 5 (« connecté
à son espace, rien ne part ») ; complète l'ADR 020 (chiffrement et
conservation des documents), l'ADR 038 (moteur de notifications) et l'ADR 019
(droits). Migration générée à part (`0017_pieces_justificatives`, renumérotée
à la fusion), règles `src/db/regles/34-pieces.sql`, code `CA021`.

## Contexte

Deux notes de recette sur la domiciliation, après le formulaire :

1. **« Aucun courriel envoyé. »**
2. **« Déposer les pièces dans l'espace client »** : pièce d'identité, Kbis,
   justificatif de domicile de la société, en PDF ou en image.

### Pourquoi le demandeur ne recevait rien

Lecture du chemin d'envoi, de l'action au transport :

- `requestDomiciliationAction` (`reservations/public-actions.ts`) prévient
  l'accueil (`notifyDomiciliationRequestSubmitted`), puis n'envoie l'accusé
  de réception (`sendRequestReceived`, ADR 068) que **si la demande n'est
  rattachée à aucune entreprise** (`if (!clientId)`). Le déclencheur
  `notifyRequestReceived` refaisait le même tri (`row.clientId` → rien).
- La demande est rattachée à une entreprise dès que la personne qui remplit
  le formulaire est **connectée à un espace client qui n'a qu'une
  entreprise** (`requesterClientId()`). C'est le cas d'un client, mais aussi
  d'un **membre de l'équipe qui a créé son espace client personnel** depuis le
  back-office (ADR 045, droit `espace-client.personnel`) : la direction qui
  essaie le formulaire en restant connectée tombe exactement là.
- Dans ce cas, **rien ne part et rien n'est écrit au journal des messages** :
  le déclencheur rend la main avant le moteur. Vu de l'écran « Messages
  envoyés », la demande n'a laissé aucune trace côté demandeur.

C'est la cause que le code reproduit (test
`demandes-site.db.test.ts` : « envoie l'accusé à un demandeur connecté… »,
qui échouait avant ce lot). Trois autres causes ne se voient que sur le
serveur et se vérifient au journal (voir « Vérifier en production ») :

- **production antérieure au 05/11** : l'accusé de réception n'existe que
  depuis l'ADR 068 ; une production plus ancienne (la mise en ligne est
  manuelle, le commit déployé n'est pas connu) ne prévient que l'accueil ;
- **SMTP non configuré ou refusé** : le journal dit « Non envoyé : SMTP non
  configuré », ou « Échec » avec la cause en clair (identifiant, expéditeur
  non validé chez Brevo, serveur injoignable) ;
- **modèle désactivé** par le centre (Messages envoyés > Modèles > « Demande
  du site bien reçue ») : le journal dit « Non envoyé — Modèle désactivé ».

## Décision

### 1. L'accusé de réception part toujours

- Toute demande de la page publique — domiciliation, salle, bureau, camion,
  matériel — vaut un accusé de réception (`request_received`) à l'adresse
  saisie dans le formulaire, **connecté ou non**. Les deux `if (!clientId)` de
  `public-actions.ts` tombent ; le déclencheur ne trie plus sur l'entreprise.
- Demande rattachée à une entreprise : ni compte créé ni lien d'invitation ;
  le message porte le lien de l'espace (variable `espace` :
  `/compte/pieces` pour une domiciliation, `/compte/reservations` pour une
  réservation). Le journal garde l'entreprise (`client_id`), l'audience reste
  `person`.
- Demande sans entreprise : inchangé (ADR 068) — lien pour créer son espace,
  ou invitation à se connecter pour une adresse déjà connue.
- **Domiciliation** : le message cite les pièces à préparer (variable
  `pieces`), d'après la liste du centre et la situation de la société (§ 2),
  et dit qu'elles se déposent dans l'espace client, en PDF ou en photo.
- L'accueil reste prévenu comme avant (`domiciliation_request_submitted`).

Le texte par défaut de `request_received` gagne deux lignes, qui ne partent
que si leur variable est présente (règle des modèles, ADR 038). Un centre qui
a réécrit son modèle garde son texte ; les deux variables lui sont proposées.

### 2. Pièces justificatives dans l'espace client

**Liste des pièces demandées, réglée par centre** (table
`client_document_kinds`, écran Réglages > « Pièces justificatives »,
`/reglages/pieces`, droit `centre.configurer`) : nom, aide montrée au client,
sociétés à qui la pièce est demandée (toutes, en création, immatriculées),
ordre ; une pièce se retire de la liste, elle ne se supprime pas. Sans ligne
pour le centre, la liste du code s'applique ; la première modification
l'écrit en base (même principe que les modèles de messages). Liste par
défaut :

| Pièce | Demandée à |
|---|---|
| Pièce d'identité du dirigeant | toutes |
| Extrait Kbis | société immatriculée |
| Projet de statuts | société en création |
| Justificatif de domicile du dirigeant | toutes |

**Situation de la société** : lue dans la réponse `situation` de la dernière
demande de domiciliation non annulée de l'entreprise. `creation` → en
création ; `immatriculee` et `transfert` → immatriculée (le transfert de siège
est une société déjà immatriculée, comme le dit la recette). Sans demande (une
entreprise domiciliée par contrat) : tenue pour immatriculée.

**Rubrique de l'espace client** « Pièces justificatives » (`/compte/pieces`),
montrée à une entreprise qui a une demande de domiciliation non annulée, un
contrat de domiciliation vivant, ou déjà une pièce déposée. Pour chaque pièce
demandée : son aide, son état en texte et en icône (« À déposer », « Reçue, en
cours de vérification », « Validée », « Refusée » avec le motif), le fichier
déposé, et le dépôt quand la pièce manque ou a été refusée. L'accès vient du
compte créé après la demande (ADR 068) ; un demandeur sans compte y arrive par
le lien de l'accusé de réception.

**Fichiers** : PDF, JPEG ou PNG, **type lu dans les octets** ; 10 Mo ; une
pièce = un fichier ; plusieurs photos JPEG (recto et verso) sont réunies en un
PDF par le serveur (`photosToPdf`, ADR 055). Dans le navigateur, chaque photo
est réduite et réencodée en JPEG avant l'envoi (`compressPhoto`, ADR 039) :
EXIF et position GPS partent, et une photo **HEIC** d'iPhone devient un JPEG
là où le navigateur sait la lire (Safari, et l'iPhone convertit déjà au choix
du fichier). Un HEIC qui arrive tel quel au serveur est refusé avec un message
qui dit quoi faire : pas de conversion côté serveur.

**Stockage** : comme les numérisations (ADR 020) — chiffré avant de partir
(AES-256-GCM, `sealDocument`, version de clé sur la ligne, jamais d'objet en
clair), clé de stockage sans rien de lisible (`pieces/<centre>/<uuid>.<ext>`),
stockage européen (`stockage.ts`). Chaque ouverture, par l'équipe ou par le
client, est **journalisée avant l'envoi** (`client_document_views`) ; une
pièce altérée n'est ni servie ni journalisée.

**Côté équipe** : encart « Pièces justificatives » sur la fiche client
(`#pieces`) et sur le devis de domiciliation (droit `pieces.valider` :
accueil, exploitant, direction) — les pièces demandées selon la situation, la
dernière déposée pour chacune, qui l'a déposée, « Ouvrir » (nouvel onglet,
journalisé), « Valider », « Refuser… » avec un motif obligatoire, et
« Valider la sélection » quand plusieurs attendent ; dépôts précédents en
dessous. Un devis d'un prospect sans fiche dit que les pièces viendront une
fois la demande rattachée.

**Règles tenues par la base** (`34-pieces.sql`, `CA021`) :

- la liste des pièces ne s'écrit pas depuis l'espace client, ne se supprime
  pas, et le code d'une pièce ne change pas (les dépôts le citent) ;
- une pièce se dépose « reçue », pour une entreprise de la portée client, et
  **pas tant qu'une autre du même type attend sa vérification ou est
  validée** (dépôts d'une entreprise sérialisés par le verrou de sa fiche) ;
- le fichier d'une pièce ne se remplace pas ; seule l'équipe la vérifie :
  reçue → validée ou refusée, validée → refusée, jamais l'inverse ; un refus
  a son motif, une vérification sa date et son auteur (contraintes) ;
- une pièce ne se supprime pas ; son fichier s'efface au terme de sa
  conservation, par `mark_client_document_purged()`, qui revérifie
  l'échéance ;
- le journal des consultations est en ajout seul, purgé à son terme.

**Messages** (moteur, ADR 038) :

| Événement | À qui | Quand |
|---|---|---|
| `client_document_received` | l'accueil (adresse du centre) | une pièce est déposée |
| `client_document_refused` | les personnes de l'espace du client | une pièce est refusée, avec le motif |

Sans catégorie de préférence : un refus attend une action du client. Type
d'entité `client_document` ; le journal mène à la fiche du client. La cloche
du client (lot 4) peut se nourrir de `client_document_refused`.

**Conservation** (RGPD ; durées par centre, écran Configuration > Durées de
conservation, groupe « Pièces justificatives de la domiciliation ») :

| Donnée | Défaut | Départ | Au terme |
|---|---|---|---|
| Pièces reçues ou validées | 60 mois | fin de la relation (`client_last_activity_on`) ; tout de suite si la fiche est anonymisée | fichier effacé, ligne marquée |
| Pièces refusées | 3 mois | refus | fichier effacé, ligne et motif gardés |
| Journal des consultations | 12 mois | consultation | lignes effacées |

La tâche de nuit (`/api/maintenance/conservation`) purge le journal puis les
fichiers (`clientDocumentViews`, `clientDocuments` au bilan).

## Choix par défaut, à confirmer en recette

- **Libellé « Justificatif de domicile du dirigeant »** : la note dit « de la
  société ». Le domiciliataire vérifie le domicile personnel du représentant
  légal (art. R123-168 du Code de commerce) ; la société, elle, sera
  domiciliée au centre. Libellé réglable.
- **Kbis pour une société immatriculée, projet de statuts en création** ;
  pas de statuts à jour demandés à une société immatriculée (à ajouter dans
  la liste si le centre le veut).
- **Situation inconnue = immatriculée**, transfert = immatriculée.
- **Un seul dépôt en attente par pièce** : le client ne remplace pas une
  pièce en cours de vérification ; l'accueil la refuse avec un motif et il en
  dépose une autre.
- **Une pièce validée peut encore être refusée** (erreur, pièce périmée),
  jamais l'inverse.
- **HEIC converti par le navigateur, pas par le serveur.**
- **Durées** : 60 mois après la fin de la relation (obligations du
  domiciliataire contre le blanchiment, art. L.561-12 du Code monétaire et
  financier), 3 mois pour une pièce refusée, 12 mois pour le journal.
- **Le refus d'une pièce part toujours** (pas de renoncement possible).
- **L'accusé de réception part aussi pour une réservation de salle, de
  bureau, de camion ou de matériel faite depuis la page publique en étant
  connecté** : même règle pour toute demande du site.
- **Liste des pièces réglée par l'exploitant et la direction**
  (`centre.configurer`), comme le reste de la configuration ; vérification par
  l'accueil (`pieces.valider`).

## Contradictions avec `CLAUDE.md` ou un ADR

- **ADR 068 § 5** disait « connecté à son espace, il voit déjà sa demande :
  rien ne part ». C'est précisément ce qui produisait le « pas de courriel » :
  la recette demande l'accusé dans tous les cas. Cet ADR le remplace sur ce
  point.
- **« HEIC converti si besoin »** : converti par le navigateur seulement ;
  convertir côté serveur demanderait une dépendance d'image (`sharp` et
  `libheif`), refusée par l'ADR 039 et la règle « pas de dépendance nouvelle
  sans justification ». Un HEIC que le navigateur ne lit pas est refusé avec
  la marche à suivre.

## Justification

- **Accusé toujours** : une demande sans réponse fait douter qu'elle soit
  partie ; le demandeur connecté a autant besoin de la preuve que le
  visiteur, et l'adresse saisie est celle qu'il a choisie pour être joint.
- **Pièces rattachées à l'entreprise, pas au devis** : un devis s'annule et
  se refait, la domiciliation dure ; c'est l'entreprise qui est domiciliée,
  et sa fiche porte déjà la portée client (ADR 019).
- **Une table pour la liste**, plutôt qu'un JSON sur `tenants` : une ligne par
  pièce, un code stable, l'auteur de la modification, et une règle de base
  (« pas de suppression ») qui la protège.
- **Mêmes garanties que le courrier** pour des pièces d'identité : chiffrées,
  servies par l'application seule, consultations journalisées, durées
  réglées et purgées.

## Alternatives écartées

- **Liste des pièces en JSON sur `tenants`** : pas de code stable garanti ni
  de trace de qui l'a changée ; une colonne de plus sur une table que tous les
  lots touchent.
- **Pièces rattachées au devis** : perdues de vue à l'annulation du devis ;
  un client domicilié par contrat, sans devis, n'aurait nulle part où
  déposer.
- **Conversion HEIC sur le serveur** : dépendance nouvelle, brevets HEVC.
- **Effacer une pièce refusée tout de suite** : le motif ne se comprend plus
  sans elle le temps que le client en dépose une autre ; trois mois suffisent.
- **Accusé à l'adresse du compte connecté** plutôt qu'à l'adresse saisie : la
  personne a pu saisir l'adresse de la société à domicilier.

## Conséquences

- Migration (structure) : tables `client_document_kinds`, `client_documents`,
  `client_document_views` ; colonnes `client_document_retention_months`,
  `refused_client_document_retention_months`,
  `client_document_access_log_retention_months` de `tenants` ; valeurs
  `client_document_received`, `client_document_refused` (`event`) et
  `client_document` (`related_type`). Règles : `34-pieces.sql` (nouveau),
  `70-notifications.sql` (deux événements classés).
- Droit `pieces.valider` (accueil, exploitant, direction).
- Réglages : lien « Pièces justificatives » (service **Domiciliation**), à
  ranger sous son service à la fusion avec le lot 9.
- Espace client : onglet « Pièces justificatives » (`espace-rubriques.ts`,
  signal `documents`).
- **Raccord avec le lot 1** (formulaire de domiciliation revu en parallèle) :
  la situation est lue dans `answers.situation` (`creation`, `immatriculee`,
  `transfert`) ; si le lot 1 renomme la question ou ses valeurs, mettre à jour
  `situationFromAnswers` (`pieces-regles.ts`). Les astérisques des formulaires
  de ce lot sont posés à la main (`*` masqué aux lecteurs d'écran, `required`
  et `aria-required` sur le contrôle) : les remplacer par le composant commun
  du lot 1. Les deux lignes changées de `public-actions.ts` (fichier du lot 1)
  sont à garder à la fusion.
- Reste à faire : rotation de clé des pièces (script de rechiffrement, comme
  `rechiffrement.ts` des états des lieux) ; dépôt d'une pièce par l'accueil au
  nom du client (reçue par courriel ou au guichet) ; carte « pièces à
  déposer » sur l'accueil de l'espace client et compteur des pièces à
  vérifier dans la cloche de l'équipe.
- Tests : `pieces-regles.test.ts` (situation, liste, état, passages, motif,
  fichiers, HEIC, photos réunies) ; `pieces.db.test.ts` (liste réglée et
  protégée, rubrique, dépôt chiffré et refus de la base, portée client,
  vérification et passages, messages et journal, consultation journalisée et
  pièce altérée, purges) ; `demandes-site.db.test.ts` (accusé au demandeur
  connecté, pièces citées selon la situation) ; `durees.test.ts`,
  `espace-rubriques.test.ts`, `permissions.test.ts`,
  `conservation.db.test.ts`.

## Vérifier en production

1. **Version** : la production doit porter ce lot (au moins l'ADR 068 pour un
   accusé, ce lot pour l'accusé au demandeur connecté). Mise en ligne :
   `infra/serveur/README.md` § 4.
2. **Configuration de l'envoi** : back-office, **Réglages**, encart
   « Courriels » en bas de page : il doit dire « Envoi configuré » (serveur,
   port 587, STARTTLS, expéditeur). « Envoyer un e-mail d'essai » dit tout de
   suite si le message part, et la cause s'il est refusé. `APP_URL` doit être
   renseigné, sans quoi les liens manquent (le message part quand même).
3. **Journal** : **Messages envoyés** (`/notifications`), filtrer l'événement
   « Demande du site bien reçue » : une ligne par demande, à l'adresse saisie.
   « Envoyé » : le message est parti de chez nous (regarder ensuite les
   indésirables et le journal d'envoi de Brevo) ; « Non envoyé : SMTP non
   configuré » : compléter `SMTP_*` et `MAIL_FROM` ; « Échec » : la cause est
   dans la ligne ; « Non envoyé » avec « Modèle désactivé » : réactiver le
   modèle dans Messages envoyés > Modèles. **Aucune ligne** pour une demande :
   la production est antérieure à ce lot (cas du demandeur connecté) ou à
   l'ADR 068.
4. **Brevo** : domaine expéditeur authentifié, suivi des ouvertures désactivé
   (`infra/serveur/README.md` § 8).
