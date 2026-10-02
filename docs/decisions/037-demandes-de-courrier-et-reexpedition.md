# ADR 037 — Demandes de courrier : ouverture, numérisation, réexpédition, historique et facturation

**Date** : 2026-10-02
**Statut** : accepté — précise l'ADR 015 (une table des demandes à côté du pli)
et l'ADR 026 (une source de facturation de plus) ; les choix marqués « à
valider » attendent le centre

## Contexte

L'ADR 015 a posé la demande d'ouverture **sur le pli** : `mail_items.status =
'opening_requested'`, `opening_requested_at`, `opening_requested_by`. Trois
défauts en découlent (R21, R24, `docs/roadmap.md`) :

- **une seule demande par pli** : après l'ouverture, plus rien ne se demande
  — ni une numérisation de pages oubliées, ni une réexpédition ;
- **la réexpédition est absente** ;
- **une annulation efface la trace** : annuler remettait
  `opening_requested_at` à nul, et l'historique du client (R24) perdait la
  demande.

La facturation des actes (R14, ADR 029) facture l'ouverture **par le pli**
(`invoice_lines.mail_item_id`, `courrier.ouverture`), une fois, hors avoir.

## Décision

### Une table des demandes, un pli en reçoit plusieurs

`mail_requests` : une ligne par demande, jamais supprimée.

| Nature (`mail_request_kind`) | Sur quel pli | Qui la dépose | Facturée |
|---|---|---|---|
| `open_and_scan` | fermé | le client seul (`requested_by_member_id`) | **par le pli**, à l'ouverture (`courrier.ouverture`) — jamais par la demande |
| `scan` | déjà ouvert | le client, ou l'accueil sur consigne (`requested_by_staff_id`) | par la demande, `courrier.numerisation` |
| `forward` | ni retiré ni réexpédié | le client, ou l'accueil sur consigne | par la demande, `courrier.reexpedition`, et les frais d'affranchissement relevés |

Au plus **une demande en cours par pli et par nature**
(`mail_requests_pending_key`) : deux clics, deux collègues, une demande. Une
demande en cours est `requested` ou `in_progress`.

La demande porte le client du pli, recopié pour la portée client et tenu égal
par la clé étrangère `(tenant_id, mail_item_id, client_id)`. Les personnes
(`requested_by_member_id`, `cancelled_by_member_id`) relèvent de cette
entreprise (clé étrangère vers `client_members (tenant_id, client_id, id)`).

L'accueil qui ouvre de lui-même un pli (consigne par téléphone, numérisation
prévue au contrat) l'ouvre directement, sans demande, comme avant
(ADR 015) : `open_and_scan` exige une personne du client
(`mail_requests_opening_by_client`).

### États, dates et auteurs, tenus par la base

`mail_request_status` : `requested` → `in_progress` → `done` ;
`requested`/`in_progress` → `refused` ; `requested` → `cancelled`. Les trois
derniers sont définitifs.

| Transition | Auteur exigé | Date posée par la base |
|---|---|---|
| dépôt | `requested_by_member_id` ou `requested_by_staff_id` (un seul) | `requested_at` |
| prise en charge | `started_by_staff_id` | `started_at` |
| faite | `completed_by_staff_id` | `completed_at` |
| refusée | `refused_by_staff_id` et `refusal_reason` (nul seulement pour un refus posé par la base) | `refused_at` |
| annulée | `cancelled_by_member_id` ou `cancelled_by_staff_id` (un seul) | `cancelled_at` |

Le trigger `mail_requests_guard` (migration 0041) refuse le reste (`CA008`) :
retour en arrière, auteur manquant, demande sur un pli retiré ou réexpédié,
ouverture d'un pli déjà ouvert, numérisation seule d'un pli fermé, et tout
changement du pli, de la nature, de la date, de l'auteur, de la consigne ou
de l'adresse de réexpédition. Les dates sont celles de la base : un
`requested_at` écrit par le code est remplacé. Sous portée client, seules la
création et l'annulation d'une demande `requested`, au nom d'une personne de
l'entreprise, passent. Le rôle applicatif n'a pas `DELETE`.

**Une réexpédition se clôt la dernière** : tant qu'une autre demande attend
sur le pli, elle ne se termine pas. Réexpédié, le pli a quitté le centre :
aucune demande ne s'y dépose plus.

### L'adresse de réexpédition est figée

`forward_recipient`, `forward_address_line1`, `forward_address_line2`,
`forward_postal_code`, `forward_city`, `forward_country` sont saisis à la
demande et ne changent plus : la demande prouve où le client a demandé
d'envoyer. Une autre adresse, c'est une autre demande. Le portail propose
l'adresse de la dernière réexpédition de l'entreprise ; il n'y a pas
d'adresse de réexpédition sur la fiche client (*à valider*).

`forward_tracking_number` et les **frais d'affranchissement réels**
(`postage_cents`, `postage_currency`) se relèvent à l'envoi, sur une
réexpédition faite, et restent modifiables tant qu'aucune facture ne tient la
demande (`CA008` ensuite).

### Le pli garde un résumé de sa demande d'ouverture

`mail_items.status = 'opening_requested'` et `opening_requested_*` restent :
la file de l'accueil, le compteur de la navigation, l'origine au relevé
(`openingOrigin`) les lisent. Ils deviennent le **résumé** de la demande
d'ouverture en cours, tenu par la base :

- une demande `open_and_scan` déposée met le pli en `opening_requested` ;
- annulée ou refusée, le pli redevient `received`, **la demande reste** ;
- l'ouverture du pli (`opened_at` posé par le code) clôt la demande en
  cours : faite, à la date et par l'auteur de l'ouverture ;
- le retrait du pli (`deleted_at`) refuse ses demandes en cours, sans
  auteur, motif « Courrier retiré : enregistré par erreur. ».

Le code ne peut plus écrire le résumé (`mail_items_guard_request_summary`,
`CA008`) : c'est ce qui rend impossible l'annulation sans trace.

**Reprise** : chaque pli qui portait une demande d'ouverture en reçoit la
ligne — en cours si le pli est fermé, faite (date et auteur de l'ouverture)
s'il a été ouvert, refusée s'il a été retiré. Le même geste s'applique à tout
pli inséré avec une demande (import, tests).

### Une numérisation demandée a son propre contenu

`mail_scans.mail_request_id` désigne la demande qui a produit un contenu
(même pli, clé étrangère). L'unicité devient : une enveloppe par pli ; un
contenu par pli **et par demande** — celui de l'ouverture (demande
d'ouverture, ou nul pour une ouverture d'office), puis un par numérisation
demandée.

### Une demande faite se facture une fois, hors avoir

`invoice_lines.mail_request_id`, avec la garantie des plis de la vague 2
(ADR 026) :

- au plus **une ligne vivante par demande et par nature de ligne**
  (`invoice_lines_mail_request_key` : un `act`, et pour une réexpédition un
  `other` de frais), libérée par un avoir émis ;
- la garde des lignes (`invoice_lines_guard`, `CA003`) exige une demande du
  client facturé, **faite** — jamais `refused`, `cancelled` ni en cours —, et
  qui n'est pas une ouverture ;
- une ligne `act` porte le service de la nature
  (`mail_request_service_code()` : `courrier.numerisation`,
  `courrier.reexpedition`) ; une ligne `other` refacture les frais
  d'affranchissement **au centime relevé**, une fois, sans remise, dans la
  devise de la facture ;
- une ligne ne porte jamais à la fois un pli et une demande
  (`invoice_lines_one_mail_source`).

La règle des actes inclus (`priceActs`, ADR 024) s'applique aux
numérisations et aux réexpéditions comme aux ouvertures, par leur service.

## Justification

**Pourquoi l'ouverture reste facturée par le pli.** Un pli ne s'ouvre qu'une
fois : la date sur le pli rend le doublon impossible par construction
(ADR 015). Facturer aussi la demande d'ouverture ferait deux sources pour un
même acte ; le lot de la vague 2 continue de lire `mail_items.opened_at`.

**Pourquoi garder le résumé sur le pli.** Le retirer obligeait à réécrire la
file, le compteur, le relevé, l'espace client et leurs tests, pour une
information que la base peut tenir d'accord. Le garde la rend fiable.

**Pourquoi deux lignes pour une réexpédition.** L'acte (la prestation du
centre) et l'affranchissement (un débours au réel) n'ont ni le même prix, ni
peut-être la même TVA : l'expert-comptable dira si l'affranchissement est un
débours hors TVA (*à valider*).

**Pourquoi l'accueil peut déposer une numérisation ou une réexpédition.** Une
consigne par téléphone doit laisser la même trace, et la même source de
facturation, qu'une demande depuis l'espace.

## Alternatives écartées

**Une colonne de plus par nature sur le pli.** Toujours une seule demande de
chaque sorte, et l'annulation toujours sans trace.

**Supprimer la demande annulée.** Contraire à la décision 6 et à R24.

**Un état « réexpédié » sur le pli.** Il se lit dans ses demandes ; une
colonne de plus pourrait les contredire.

**Une adresse de réexpédition sur la fiche client.** Utile, mais c'est une
donnée personnelle de plus à tenir et à anonymiser ; la dernière demande
fournit la proposition.

## Conséquences

- `requestOpening` et `cancelOpeningRequest` (courrier/queries.ts) écrivent
  désormais dans `mail_requests`. Le reste de la tranche courrier construit :
  la file des demandes (`mail_requests_queue_idx`), la numérisation seule et
  la réexpédition côté client et accueil, l'historique des demandes (R24),
  le lien `mail_scans.mail_request_id` à l'ouverture demandée et à la
  numérisation, les courriels (ADR 038).
- La facturation ajoute au lot les demandes faites de la période
  (`mail_requests_done_idx`), et à `services-attendus.ts` les services
  `courrier.numerisation` et `courrier.reexpedition` (constantes
  `serviceCodes.mailScan`, `serviceCodes.mailForwarding`).
- Erreurs à traduire : `CA008` (demande refusée par la base), `23505`
  (demande déjà en cours, ou demande déjà facturée), `CA003` (ligne de
  facture refusée).
- *À valider par le centre* : le prix des deux nouveaux services, le
  traitement des frais d'affranchissement (débours ou prestation), l'absence
  d'adresse de réexpédition sur la fiche.
