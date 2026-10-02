# ADR 033 — Tâches planifiées de la facturation : lot mensuel et reconduction tacite

**Date** : 2026-10-02
**Statut** : accepté — met en œuvre la reconduction tacite de l'ADR 023 et le
lancement planifié prévu pour R13 (ADR 029) ; les choix marqués « à valider »
attendent le centre

## Contexte

La vague 2 a laissé deux tâches sans exécutant :

- **La reconduction tacite (R10).** L'ADR 023 en fait une règle du contrat :
  « au terme, le code prolonge `ends_on` de `renewal_months` faute de
  préavis ». Rien ne le faisait. Un contrat d'un an à reconduction tacite
  s'arrêtait donc à son terme : plus d'occupation, plus de facturation, sans
  que personne ne l'ait décidé.
- **Le lot de facturation planifié (R13).** La roadmap le prévoit (« génération
  périodique, planificateur sur le VPS ») ; l'ADR 029 le rendait impossible,
  `invoice_runs.created_by` exigeant un membre de l'équipe.

Le serveur a déjà son mécanisme de tâche planifiée : une route
`/api/maintenance/…` appelée par la crontab avec `MAINTENANCE_TOKEN` (purge du
courrier, ADR 015 et 020).

## Décision

### Deux routes de maintenance, sur le modèle de la purge

| Route | Quand | Ce qu'elle fait |
|---|---|---|
| `/api/maintenance/contrats` | chaque nuit, 3 h 05 | reconduction tacite des contrats |
| `/api/maintenance/facturation` | le 1er du mois, 6 h 00 | lot de facturation du mois du centre |

Même garde que la purge (`isMaintenanceRequest`, `src/lib/maintenance.ts`) :
sans jeton configuré, ou avec un mauvais jeton, la route répond 404. Les
horaires et les lignes de crontab sont dans `infra/serveur/README.md`.

### Reconduction : inscrite dès qu'elle est acquise

Un contrat en cours, à reconduction tacite, non résilié et non archivé, est
**reconduit** dès qu'un préavis donné ce jour-là ne mettrait plus fin au
contrat à son terme : le terme du préavis (jour de la demande compris) et la
fin d'engagement dépassent le terme (`earliestEndOn`, jumelle de
`contract_earliest_end_on`, ADR 023). La tâche nocturne porte alors `ends_on`
au terme suivant — du lendemain du terme, `renewal_months` mois, la veille —
autant de fois qu'il le faut pour rattraper des périodes manquées
(`tacitRenewalTerm`, `contrats/reconduction.ts`).

Chaque prolongation est inscrite au journal `contract_renewals` (ancien
terme, nouveau terme, jour de l'inscription), sous isolation par centre,
réservé au back-office, sans modification ni suppression par l'application.
La fiche du contrat l'affiche sous le terme.

L'occupation suit le nouveau terme (déclencheur de l'ADR 018). Si la
ressource est déjà prise après le terme, la contrainte d'exclusion refuse :
le contrat garde son terme, la tâche le nomme dans `failures`, et les autres
contrats sont prolongés (un point de reprise par contrat). Elle le redit
chaque nuit jusqu'à ce que l'équipe libère la ressource ou résilie.

Un préavis reçu à temps mais saisi après la reconduction reste possible : la
résiliation raccourcit le contrat comme toute résiliation (la base ne refuse
pas une résiliation avant le terme, ADR 023).

### Lot planifié : celui de l'écran, sans auteur

La route du 1er appelle `runInvoicing` pour le mois du centre (son fuseau,
décision 4), avec un auteur nul : `invoice_runs.created_by` devient
facultatif, nul voulant dire « tâche planifiée » (migration 0033). Le journal
des lots l'affiche ainsi. Tout le reste est le lot de l'ADR 029 : journalisé,
un seul à la fois (409 si un lot tourne), un client à la fois, rejouable sans
doublon, et **il n'émet rien** — l'équipe relit, puis émet. `?mois=AAAA-MM`
rejoue un autre mois, à la main.

## Justification

**Inscrire la reconduction dès qu'elle est acquise, pas au lendemain du
terme.** Passé le dernier jour de préavis, la reconduction est certaine.
L'inscrire aussitôt donne le nouveau terme à l'échéancier, au planning et au
lot préparé en fin de mois ; l'inscrire au lendemain du terme laisserait la
ressource libre quelques heures et un lot préparé la veille sans le mois
suivant. Pour un contrat sans préavis, les deux se confondent.

**Le lot à 6 h le 1er.** Les consommations du mois précédent sont complètes,
la reconduction de la nuit est passée, et l'équipe trouve ses brouillons en
arrivant. L'écran reste le chemin principal ; la tâche évite l'oubli.

**Des routes plutôt qu'un script.** Le code tourne dans le conteneur de
l'application, avec ses connexions et son rôle applicatif sous RLS, comme la
purge ; la crontab ne porte aucun secret.

## Alternatives écartées

**Reconduire au lendemain du terme** (lecture littérale de l'ADR 023) : voir
la justification.

**Émettre automatiquement les factures du lot planifié** : contraire à
l'ADR 029 (l'équipe relit), et une facture émise ne se corrige que par avoir.

**Un service de planification tiers** : une dépendance et un compte de plus,
pour deux appels HTTP que la crontab du serveur fait déjà.

## Conséquences

- Migration 0033 (`contract_renewals`, `invoice_runs.created_by` facultatif),
  migration 0034 (isolation et droits du journal).
- À poser sur le VPS : les deux lignes de crontab (`infra/serveur/README.md`).
- L'ADR 029 ne dit plus vrai sur le lancement : le lot se lance aussi par la
  tâche planifiée.
- **À valider par le centre** : la reconduction inscrite dès le dernier jour
  de préavis passé ; le lot préparé chaque 1er du mois à 6 h.
