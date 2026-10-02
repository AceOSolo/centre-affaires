# ADR 034 — Règlements : journal des relances, rechiffrement des mandats, remises sans table

**Date** : 2026-10-02
**Statut** : accepté — précise l'ADR 030, dont il lève trois conséquences ;
les choix marqués « à valider » attendent le centre

## Contexte

L'ADR 030 laissait au schéma trois manques sur les règlements (R16) :

- **aucune relance n'était tracée** : l'écran des impayés ne pouvait pas dire
  « relancée le … », et une mise en demeure envoyée en recommandé ne laissait
  aucune trace dans l'application ;
- **une remise de prélèvement n'existait que par la référence de ses
  paiements** (`PRLV-…`) ;
- **`infra/chiffrer-documents.ts` ne rechiffrait pas les IBAN des mandats**
  après une rotation de la clé des documents : un mandat chiffré avec une clé
  retirée du trousseau bloque sa remise.

## Décision

### Un journal des relances, preuve de ce qui a été réclamé

Table `invoice_reminders` (migrations 0035 et 0036) : la facture, le palier
(1 relance amiable, 2 seconde relance, 3 mise en demeure), le canal
(`email`, `post`), les destinataires d'un courriel, le reste dû réclamé et sa
devise, l'objet et le texte de la lettre tels qu'ils sont partis, qui l'a
faite et quand. Isolée par centre, réservée au back-office ; l'application
n'y a que la lecture et l'insertion (une preuve ne se réécrit pas). La base
refuse une relance sur un brouillon ou un avoir (`CA003`), un courriel sans
destinataire, un courrier avec, un palier inconnu, un montant nul.

- **Par courriel** : `sendRemindersAction` inscrit la relance dans la
  transaction de son envoi — un courriel qui ne part pas n'y figure pas.
- **Par courrier** : la page de la lettre a un bouton « Noter l'envoi par
  courrier » (droit `paiements.gerer`), qui inscrit la lettre du jour. Une
  impression seule ne s'inscrit pas : le navigateur n'en dit rien au serveur,
  et une lettre imprimée n'est pas forcément partie.

La lettre du jour vient d'une seule règle (`reminderDraft`) : celle qui
s'affiche, s'imprime, part par courriel et s'inscrit est la même. La page de
la lettre liste les relances déjà faites ; la liste des impayés montre la
dernière (date, palier, canal).

Rien ne change à la règle de l'ADR 030 : **aucune relance ne part seule**.

### Le rechiffrement des mandats suit celui des documents

`rekeyMandateIbans` (`facturation/mandats-rechiffrement.ts`) rechiffre avec la
clé courante chaque IBAN de mandat chiffré avec une autre clé — mandats
révoqués et archivés compris, leur IBAN restant en base. Même discipline que
la reprise des numérisations (ADR 020) : essai à blanc par défaut, un mandat
par transaction sous `for update skip locked`, rejouable, et un mandat
illisible (clé absente, chiffré altéré) laissé tel quel et signalé.
`infra/chiffrer-documents.ts` l'appelle après les numérisations ; la
procédure de rotation (`infra/serveur/README.md`) attend que l'essai à blanc
ne trouve plus ni numérisation ni IBAN avant de retirer l'ancienne clé, et
rappelle que les sauvegardes de la base antérieures à la rotation ne se
lisent qu'avec elle.

### Les remises de prélèvement restent sans table

Écarté : une table `direct_debit_batches` et `payments.batch_id`. Une remise
est entièrement décrite par ses paiements — identifiant (`reference`), jour de
prélèvement (`paid_on`), auteur (`recorded_by`), date de préparation
(`created_at`), montants, rejets (paiements annulés avec leur motif) — et son
fichier `pain.008` se reconstruit à l'identique (ADR 030). Une table
dupliquerait ces faits ; un état « déposée à la banque » demanderait un geste
que le centre n'a pas demandé. À reprendre si le raccordement bancaire ou la
plateforme agréée l'exige.

## Justification

**Inscrire dans la transaction de l'envoi.** Le journal ne doit dire ni moins
ni plus que ce qui est parti. Un envoi refusé par le serveur de messagerie
annule l'inscription ; une inscription refusée par la base annule l'envoi.

**Garder le texte.** Une lettre dépend du jour (palier, reste dû, mentions du
centre) : la reconstruire après coup ne dirait pas ce qui a été réclamé. Une
mise en demeure peut avoir à être produite devant un tiers.

**Un bouton pour le courrier.** C'est le canal de la mise en demeure ; sans
lui, le journal manquerait précisément la relance qui compte le plus.

## Alternatives écartées

**Journaliser l'ouverture de la page de la lettre, ou son impression** : ni
l'une ni l'autre ne prouve un envoi.

**Stocker les remises de prélèvement** : voir ci-dessus.

## Conséquences

- Migrations 0035 (table) et 0036 (isolation, droits, garde).
- R16 garde ses restes hors code : choisir et raccorder la plateforme agréée.
- **À valider par le centre** : noter à la main l'envoi d'une lettre par
  courrier ; la conservation du texte des relances, et des adresses de leurs
  destinataires, le temps de conservation des factures (registre RGPD,
  `docs/rgpd/`).
