# ADR 079 — Courrier côté équipe : expéditeurs réglables, saisie en un écran, « Valider », numérisation relue avant le client

**Date** : 2026-11-17
**Statut** : accepté — lot 6 de la recette du 17/11/2026
(`docs/recette/2026-11-17.md`) ; amende l'ADR 058 (suggestions d'expéditeurs,
parcours de la saisie groupée), l'ADR 057 (« Prendre en charge », traitement
sur la fiche du pli) et l'ADR 044 (« pas de courrier aujourd'hui ») ; une
migration de structure (`tenants.mail_suggested_senders`,
`mail_scans.pending_validation`), un fichier de règles
(`64-courrier-equipe.sql`, code `CA025`). Les choix marqués « à confirmer en
recette » ont été tranchés par défaut, le responsable produit étant absent.

## Contexte

Cinq notes de la recette du 17/11/2026, côté équipe :

1. « Admin > Courrier : la liste des expéditeurs proposés se règle dans
   l'admin. »
2. « Saisie groupée du courrier trop compliquée, trop d'étapes. »
3. « Plis déclarés et tournée terminée : plus de bouton “Pas de courrier
   aujourd'hui”. »
4. « “Prise en charge” du courrier devient “Valider”, puis seulement les
   informations utiles à la demande (une réexpédition n'a pas d'onglet
   numérisation). »
5. « Envoi du courrier numérisé avec une étape de validation et un aperçu du
   document avant la notification. »

## Décision

### 1. Les expéditeurs proposés se règlent dans Réglages

**Écran** : Réglages > « Expéditeurs proposés » (`/courrier/expediteurs`).
Un tableau, une ligne par expéditeur : renommer dans le champ, « Monter »,
« Descendre », « Retirer », « Ajouter un expéditeur », puis « Enregistrer la
liste » d'un coup. Un encart « Souvent saisis, absents de la liste » propose
d'ajouter d'un clic les expéditeurs les plus tapés par l'accueil qui n'y sont
pas. « Revenir à la liste par défaut » efface le réglage.

**En base** : `tenants.mail_suggested_senders`, JSON, **par centre**, nulle
tant que le centre n'y a pas touché. Nulle, rien ne change (règle commune de
la recette) : l'accueil voit, comme avant (ADR 058), les expéditeurs de
l'entreprise du pli, puis les plus saisis au centre, puis la liste de départ
du code (`STARTING_SENDERS`). L'écran part de **cette liste-là, telle que
l'accueil la voit** : l'enregistrer sans y toucher ne change rien.

**Réglée**, la liste remplace les suggestions du centre et la liste de
départ, dans son ordre : un expéditeur retiré n'est plus proposé. Les
expéditeurs déjà saisis **pour l'entreprise du pli** restent en tête — ils
disent qui écrit vraiment à cette entreprise. La saisie reste libre, et
toujours ramenée à l'écriture connue (« banque du leman » → « Banque du
Léman ») : celle de la liste, sinon la plus employée au centre.

**Règles** (`readSenderList`, testées) : chaque ligne normalisée comme une
saisie (`readSender`, 120 caractères), une ligne vide est retirée, un doublon
à la casse, aux accents et à la ponctuation près est refusé sur sa seconde
ligne, 200 expéditeurs au plus — plafond tenu aussi par la base
(`tenants_mail_suggested_senders_valid`).

**Droit** : `centre.configurer` (exploitant et direction), comme les autres
réglages du centre (ADR 019). *À confirmer en recette* : l'ouvrir à l'accueil,
qui tape les expéditeurs tous les jours, c'est remplacer ce droit par
`courrier.gerer` dans l'action, la page et le lien de Réglages — l'accueil
verrait alors l'entrée « Réglages » du menu.

### 2. La saisie groupée tient en un écran, sans étape

L'ADR 058 avait quatre temps numérotés à l'écran : 1. entreprise, 2. type,
3. photos, 4. récapitulatif. Désormais, **un seul écran, sans numéros** :

- « Reçu le », puis la recherche de l'entreprise (nom ou numéro de boîte).
- Sur téléphone et tablette, chaque entreprise trouvée a son bouton
  **« Photographier »** : il la choisit **et** ouvre l'appareil, d'un geste.
  Au clavier, `Entrée` choisit la première entreprise, comme avant.
- **Une photo = un pli, en lettre par défaut** : le type ne se choisit plus
  avant les photos. Il se corrige **pli par pli**, sur la carte de
  l'entreprise, d'une touche (quatre puces : lettre, recommandé, colis,
  autre), comme l'expéditeur.
- Une **carte par entreprise**, dans l'ordre de la saisie, qui est aussi le
  récapitulatif : ses plis (photo, type, expéditeur, « Retirer ») et, pour
  celle en cours, « Photographier le pli suivant », « Choisir des photos »,
  « + Pli sans photo » ; on y dépose aussi des photos à la souris. « Ajouter
  des plis » rouvre une carte précédente.
- « Enregistrer les N plis », toujours en bas (`Ctrl`+`Entrée`).

Rien ne change derrière : le même envoi (`pli.<clé>.client|kind|sender|photo`),
les mêmes règles (`parseMailEntry`, tout ou rien, 500 plis, 20 Mo, compression
dans le navigateur), le même ordre d'enregistrement (`entryCards` suit
`groupEntry`), donc le même repère du jour (ADR 057).

**Clics, avant / après.** Scénario de référence : 4 entreprises, 6 plis —
A : 2 lettres ; B : 1 lettre et 1 colis ; C : 1 recommandé ; D : 1 lettre —,
sur tablette, photos à l'appareil. On compte chaque toucher d'écran, frappe
au clavier exclue ; l'appareil photo du système en demande deux par photo
(déclencher, valider), soit 12 dans les deux cas.

| | Avant (ADR 058) | Après |
|---|---|---|
| A, 2 lettres | recherche, entreprise, « Prendre une photo », « Photographier le pli suivant » : 4 (+ 4 appareil) | recherche, « Photographier », « Photographier le pli suivant » : 3 (+ 4) |
| B, lettre + colis | « Entreprise suivante », entreprise, photo, « Colis », photo : 5 (+ 4) | recherche, « Photographier », pli suivant, « Colis » sur le pli 2 : 4 (+ 4) |
| C, recommandé | « Entreprise suivante », entreprise, « Recommandé », photo : 4 (+ 2) | recherche, « Photographier », « Recommandé » sur le pli : 3 (+ 2) |
| D, lettre | « Entreprise suivante », entreprise, **« Lettre »** (le type restait sur « Recommandé »), photo : 4 (+ 2) | recherche, « Photographier » : 2 (+ 2) |
| Enregistrer | 1 | 1 |
| **Total** | **18 + 12 = 30** | **13 + 12 = 25** (− 5, − 28 % hors appareil) |

Et surtout : quatre étapes à l'écran deviennent une, et l'erreur la plus
courante disparaît — l'ancien type « restait » d'une entreprise à l'autre,
une lettre partait en recommandé si l'on oubliait de le remettre.

### 3. Plus de « Pas de courrier aujourd'hui ? » une fois la tournée du jour terminée

Une tournée terminée aujourd'hui (jour du centre) a prévenu les domiciliés ;
l'ADR 044 ne redit pas « pas de courrier » à une seconde tournée. Le bouton
n'a donc plus d'objet :

- le bandeau du courrier (`tournee-bandeau.tsx`) dit « Tournée du jour
  terminée à 10:42 par Camille : les domiciliés ont été prévenus » et propose
  seulement « Du courrier arrive encore ? Le saisir » ;
- l'écran de la tournée n'offre plus « Signaler qu'aucun courrier n'est
  arrivé » ;
- **le serveur refuse** un signalement venu d'une page restée ouverte
  (`MailDayReportedError`, testé) : rien n'est ouvert ni terminé.

Des plis déclarés aujourd'hui ouvrent une tournée : le bandeau montre alors
la tournée en cours, sans ce bouton (inchangé). Le courrier de l'après-midi
ouvre et termine sa tournée comme avant.

### 4. « Valider », puis un écran de traitement par demande

**« Prendre en charge » devient « Valider »** partout côté équipe : bouton de
la file et de « Demandes », « Valider la sélection », écran de la demande,
état « Validée » (ex-« En cours ») dans les files, la cloche, les filtres
(« Pas encore validées », « Validées ») et le bilan d'une validation groupée.
`/aujourdhui` n'avait pas de bouton : rien à y renommer. Le geste ne change
pas (`requested` → `in_progress`) ; côté client, les mots restent ceux du
client (« En cours de traitement », « Prise en charge par le centre »).

**Écran de traitement** : `/courrier/demandes/<demande>`. « Valider » y mène,
comme « Traiter la demande » depuis les files et la fiche du pli. Il ne montre
**que ce qui sert à la demande** :

- toujours, de quoi retrouver le pli : la photo de l'enveloppe agrandissable
  et le **repère du jour** (ADR 057), le type, l'expéditeur, la réception ;
  la consigne du client ; les étapes ;
- **réexpédition** : l'adresse figée, le suivi et l'affranchissement ; aucune
  numérisation ;
- **numérisation** et **ouverture** : le dépôt du contenu, son aperçu et sa
  validation (§ 5) ; aucune réexpédition ;
- « Valider », « Annuler à la demande du client », « Refuser » selon l'état.

Le reste du pli — journal des consultations, retrait, autres demandes,
expéditeur — reste sur sa fiche, à un lien (« Fiche complète du pli »). La
fiche ne porte plus les formulaires des demandes : chacune y a ses étapes et
son lien « Traiter la demande ». Une ouverture demandée par le client ne
s'ouvre plus depuis la fiche, qui renvoie à sa demande ; l'ouverture à
l'initiative du centre, elle, reste sur la fiche.

L'écran est sous `/courrier/demandes` : « Demandes » du rayon Domiciliation
reste allumée (ADR 057, pas d'entrée de menu en plus).

### 5. La numérisation se relit et se valide avant le client

**Dépôt, aperçu, validation.** Le contenu d'une **ouverture** (demandée ou à
l'initiative du centre) ou d'une **numérisation demandée** se dépose
(« Déposer et relire ») : il est chiffré et stocké comme toute numérisation,
mais **à valider** (`mail_scans.pending_validation`). L'écran montre :

- l'**aperçu du document** : les pages une à une quand le PDF est fait de
  photos (le cas des pages photographiées, ADR 055 — leurs JPEG sont lus tels
  quels dans le PDF, `apercu-pdf.ts`, sans bibliothèque), la photo seule,
  sinon le PDF dans le lecteur du navigateur ; et « Ouvrir le document dans
  un nouvel onglet » ;
- **« Valider et prévenir le client »** : le pli est noté ouvert, ou la
  demande faite ; le client voit le document dans son espace et reçoit le
  courriel (« courrier numérisé », « demande traitée ») — **à ce moment
  seulement** ;
- « Remplacer le fichier » : un nouveau dépôt remplace le précédent, purgé
  (fichier effacé, ligne gardée) ; « Abandonner ce dépôt ».

**Invisible du client avant validation.** Aucune lecture de l'espace client
ne rend un contenu à valider : lien de la fiche, de la liste et des demandes,
compte des numérisations, fichier lui-même (`findScanForAccounts`). Le relevé
des ouvertures et le registre des consommations (ADR 066) ne lisent que les
contenus validés : un dépôt remplacé ne compte jamais ses pages.

**Journalisé.** L'aperçu lit le document **une fois**, par la route protégée
`/courrier/scans/…`, qui l'inscrit au journal des consultations du pli
(ADR 020) ; l'aperçu se construit ensuite dans le navigateur. Pourquoi pas un
cadre : le site refuse d'être mis en cadre (`X-Frame-Options: DENY`), ce
qu'un document local, déjà lu, ne subit pas.

**Ce que tient la base** (`64-courrier-equipe.sql`, `CA025`) : un dépôt à
valider ne naît que sur un pli présent, pour une demande en cours ou pour un
pli encore fermé ; un contenu validé ne redevient pas à valider ; un dépôt
purgé ne se valide plus ; **la validation suit son geste** — pli ouvert, ou
numérisation demandée faite ; rien de cela ne s'écrit depuis l'espace client.

**Déposer, c'est valider la demande** : une demande encore « à traiter »
passe « validée » au dépôt, pour que le client ne l'annule pas pendant que
l'accueil y travaille. Un refus de la demande purge son dépôt.

## Choix faits par défaut (à confirmer en recette)

- **Droit du réglage des expéditeurs** : exploitant et direction
  (`centre.configurer`), pas l'accueil. Voir § 1.
- **Liste réglée** : elle remplace les expéditeurs « appris » du centre ; ceux
  de l'entreprise du pli restent en tête ; l'encart « Souvent saisis » garde
  l'apprentissage, à la main.
- **Saisie groupée** : type par défaut « lettre », corrigé sur le pli ; pas de
  caméra intégrée à la page (voir Alternatives).
- **Aperçu** : avant validation, sur l'écran de la demande (ou la fiche pour
  une ouverture d'office) ; pas d'aperçu imposé à la saisie pli par pli
  (`/courrier/nouveau`) : un contenu joint à l'enregistrement est relu dans le
  formulaire avant l'envoi, et le client n'en est prévenu qu'à la fin de la
  tournée (ADR 044).
- **Photo et repère du pli** montrés pour toute demande (pas seulement
  l'ouverture) : il faut retrouver le pli pour le réexpédier aussi.
- **Ouverture demandée** : traitée depuis sa demande, plus depuis la fiche.
- **Astérisques** : en attendant le composant commun du lot 1, une astérisque
  en ligne (`aria-hidden`) doublée de `required` et `aria-required`, et la
  phrase « Les champs marqués * sont obligatoires » en tête de chaque
  formulaire touché ; à remplacer par le composant du lot 1 à la fusion.

## Contradictions et écarts

- **ADR 057 § 3** (« Prendre en charge » mène à la fiche du pli) : remplacé
  par « Valider », qui mène à l'écran de la demande.
- **ADR 058 § 1 et § 3** : le parcours en quatre temps et l'ordre des
  suggestions sont amendés (§ 1 et § 2 ci-dessus). Le reste tient.
- **Aucune contradiction avec `CLAUDE.md`** : rien ne s'efface (un dépôt
  remplacé est purgé, sa ligne reste — décision 6), la consultation reste
  journalisée (RGPD), aucun montant ni facture.

## Justification

- **Un drapeau sur `mail_scans` plutôt qu'une table de brouillons** : le
  journal des consultations, le chiffrement, la purge et la route protégée
  servent tels quels ; seules les lectures du client et des relevés filtrent
  le drapeau, et un test le vérifie pour chacune.
- **La validation fait le geste** plutôt que le dépôt : le relevé, le
  registre des consommations et le client lisent l'ouverture et la demande
  faite ; tant que rien n'est validé, rien n'est dû ni montré.
- **Une colonne JSON sur `tenants`** pour la liste : un réglage par centre,
  ordonné, jamais interrogé ligne à ligne — comme `social_links` et
  `booking_max_days`. Nulle, elle laisse le code décider : rien ne change tant
  que personne n'y touche.
- **Un écran par demande** plutôt que des onglets masqués sur la fiche : une
  adresse que « Valider », la cloche et les files partagent, et une page qui
  n'a rien d'autre à montrer.

## Alternatives écartées

- **Caméra dans la page** (`getUserMedia`) pour la saisie groupée : une
  touche par photo au lieu de trois (déclencher et valider dans l'appareil du
  système), soit environ dix touches de moins dans le scénario ci-dessus.
  Écartée pour ce lot : non éprouvable sans navigateur dans la CI, et le
  comportement d'iOS (autorisation, `playsinline`) demande un essai sur
  tablette. À reprendre si l'accueil le demande.
- **PDF.js** pour l'aperçu : une dépendance pour les seuls PDF de scanner ;
  les PDF de photos, le cas courant, se montrent sans elle.
- **Garder le type à choisir avant les photos** : c'est l'étape que la
  recette trouve de trop, et la source d'erreurs du type « resté ».
- **Bloquer « pas de courrier » en base** : une tournée vide de l'après-midi
  (un pli retiré) doit pouvoir se terminer ; la règle est dans le code, qui
  sait d'où vient le geste.

## Conséquences

- Migration de structure : `tenants.mail_suggested_senders` (JSON, nul),
  `mail_scans.pending_validation` (faux par défaut : tout l'existant est
  validé), deux contraintes. Règles : `64-courrier-equipe.sql` (`CA025`,
  `DB_MAIL_TEAM_REFUSED`).
- Réglages : lien « Expéditeurs proposés », service **Domiciliation**.
- Actions retirées : `openMailAction` et `completeScanRequestAction` (une
  ouverture ou une numérisation publiée d'un coup, sans relecture) ;
  `recordOpening` et `recordScanRequestDone` restent pour les jeux d'essai du
  relevé, de la facturation et des consommations.
- Tests : `expediteurs.test.ts` (liste réglée, lecture de la saisie,
  doublons, plafond, « souvent saisis »), `expediteurs.db.test.ts` (réglage
  lu, suivi, rétabli, plafond en base), `saisie-groupee-regles.test.ts`
  (cartes, type par défaut), `tournees.db.test.ts` (plus de « aucun
  courrier » après la tournée du jour), `apercu-pdf.test.ts` (pages d'un PDF
  de photos, rotation, repli), `depots.db.test.ts` (invisible du client,
  remplacement sans compter, validation par ouverture ou numérisation,
  ouverture d'office rattachée à une demande arrivée depuis, abandon, refus,
  retrait, garde `CA025`), `demandes-refus.test.ts` et `cloche*.test.ts`
  (libellés « validée »).
