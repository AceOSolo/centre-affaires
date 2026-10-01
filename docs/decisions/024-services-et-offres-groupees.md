# ADR 024 — Catalogue de services, services souscrits et offres groupées

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Le centre vend plus que des ressources : la domiciliation et ses options,
l'ouverture et la numérisation du courrier, le standard téléphonique,
l'assistante, des campagnes d'appels (R18). Il les combine en offres
(« Domiciliation Premium : boîte aux lettres, réexpédition, dix numérisations
par mois », R09), et chaque acte du courrier doit remonter sur la facture
(R14), sans ressaisie du relevé (ADR 015).

Ce qui existait :

- les grilles tarifaires sont liées à un type de ressource (ADR 009) : un
  écran tactile ou un plateau-repas n'y entrait pas ;
- le relevé des ouvertures compte, il ne valorise rien (ADR 015) ;
- la fiche client ne dit rien des services souscrits (R07).

L'ADR 016 (décision D7) a retenu un objet « catalogue de services » distinct
des grilles, et des offres faites de lignes.

## Décision

### Le catalogue : `services`

Un service a un nom, une description, une **nature**, une unité de
facturation (`rate_unit`), un prix unitaire HT en centimes, un taux de TVA en
points de base (20 % par défaut), et deux états : `is_active` (proposé à la
souscription) et `deleted_at` (archivé).

- `package` : un forfait, dû par période — en général `month`.
- `act` : un acte, dû à chaque exécution, toujours à l'unité (contrainte
  `services_act_per_unit`).

Un service inactif reste facturé à ceux qui l'ont souscrit ; archivé, il sort
du catalogue et sa ligne reste (décision 6).

### Des codes stables pour ce que le code doit retrouver

`services.code`, facultatif, unique parmi les services vivants d'un centre.
La facturation retrouve les actes du courrier par leur code, jamais par un nom
(`serviceCodes`, `facturation/schema.ts`) :

| Code | Acte |
|---|---|
| `courrier.ouverture` | Ouverture et numérisation d'un pli (un seul acte, ADR 015) |
| `courrier.reexpedition` | Réexpédition d'un pli (R21, vague 3) |

**Aucun prix n'est inventé** (ADR 009) : le centre crée ces services et fixe
leur prix. Tant qu'un code n'a pas de service vivant, l'acte n'est pas
valorisé, et le lot de facturation le signale au lieu de facturer zéro.

### Les services souscrits : `subscribed_services`

Une ligne par client et par service : quantité, prix unitaire HT et TVA
**figés à la souscription**, remise éventuelle, quantité incluse par période
pour un acte (`included_quantity`), date de début, date de fin facultative,
contrat facultatif.

- **Ce qui est convenu ne se réécrit pas** (SQLSTATE `CA004`) : service, client,
  contrat, quantité, unité, prix, remise, TVA, inclus, début. On y met fin
  (`ends_on`) ou on l'archive, puis on souscrit aux nouvelles conditions.
  L'historique des prix d'un client se lit ainsi en lignes.
- **Pas deux fois le même service** pour le même client et le même contrat sur
  des périodes qui se recouvrent (contrainte d'exclusion
  `subscribed_services_no_overlap`) : deux lignes de standard s'écrivent
  quantité 2.
- **Le contrat est celui du client** : clé étrangère composite
  `(tenant_id, contract_id, client_id)`.

### Ce qu'un acte coûte

Pour un pli ouvert (`mail_items.opened_at` dans la période facturée, jour du
centre) :

1. la souscription vivante du client au service de l'acte, en vigueur ce
   jour-là, s'il y en a une : les `included_quantity` premiers actes de la
   période de facturation, par ordre d'ouverture, sont inclus ; les suivants
   sont dus à son prix figé ;
2. sinon, le prix du catalogue.

Un acte inclus figure tout de même sur la facture, à prix nul, avec la
mention « inclus » : le pli est ainsi consommé par la facture (il ne peut plus
être facturé, ADR 026) et le client voit ce que couvre son forfait.

### Les offres groupées : `offers` et `offer_items`

Une offre est un modèle commercial : nom, description, période de facturation
proposée, durée d'engagement proposée, devise. Active tant que `deleted_at` est
nul, archivée ensuite.

Une ligne d'offre vise **exactement une** cible — un type de ressource, une
ressource précise ou un service — avec une quantité, une unité, et **au plus
un** de : un prix forfaitaire, une remise en pourcentage, une remise en
montant (ADR 023). Aucun des trois : le prix du catalogue s'applique (grille
pour une ressource, prix du service).

Une offre ne facture rien. Un contrat en est tiré (`contracts.offer_id`), qui
copie ses lignes ; modifier ou archiver l'offre ne change aucun contrat.

| Ligne d'offre | Devient, dans le contrat tiré |
|---|---|
| Type de ressource ou ressource | Ligne de contrat (`contract_lines`), facturée en loyer |
| Service `package` | Ligne de contrat ciblant le service, facturée en forfait |
| Service `act`, quantité N | Souscription rattachée au contrat : `included_quantity = N`, prix du catalogue au-delà, remise de la ligne |

`contract_lines.offer_item_id` garde la trace de la ligne d'offre copiée.

### Droits

`services.gerer` (catalogue et offres) et `souscriptions.gerer` (souscrire un
client, y mettre fin) reviennent à l'exploitant : ils engagent des prix.
L'accueil voit les souscriptions sur la fiche client (`clients.gerer`).

## Justification

**Un catalogue plutôt qu'une extension de la grille** (D7). Une ligne de grille
répond à « combien coûte cette ressource pendant cette durée » ; un service n'a
ni ressource ni durée. Les mêler aurait rendu `resource_type` facultatif sur la
grille, et chaque calcul de réservation aurait dû écarter des lignes qui ne la
concernent pas.

**Le prix figé sur la souscription.** Le client a accepté un prix : une
révision du catalogue ne doit pas le changer sans avenant ni accord.

**Les actes inclus sur une souscription, pas sur une ligne de contrat.** Le
calcul des actes ne consulte qu'une source : il ne peut pas compter deux fois
les mêmes inclus, et une souscription sans contrat (un client qui ne prend que
la numérisation) se traite comme les autres.

**Des codes stables.** Le nom d'un service se change à l'écran ; un code ne
change pas, et la facturation ne dépend pas d'une faute de frappe.

## Alternatives écartées

**Une table par sorte de service** (forfait, acte) : le même catalogue, le même
prix, la même TVA, la même souscription, écrits deux fois.

**Les inclus en compteur décrémenté** (un solde de numérisations) : un état de
plus à tenir juste, quand la règle se recalcule depuis les plis de la période.
Les carnets prépayés de l'ADR 009 restent à cadrer à part.

**Des prix de services codés en dur** : contraire à l'ADR 009, et un second
centre aurait les prix du premier.

## Conséquences

- Les options facturées de l'ADR 009 (écran tactile, petit-déjeuner,
  collation) deviennent des services : reste à en saisir les prix.
- Le relevé des ouvertures (ADR 015) reste ; la facture le remplace comme
  source de facturation dès que le service `courrier.ouverture` existe.
- La fiche client montre les souscriptions en cours (R07).
- **À valider par le centre** : la liste des services et leurs prix, les
  inclus par offre, la règle « les N premiers actes de la période ».

## Mise en œuvre (vague 2) — services, souscriptions, offres

Ajoutée le 2026-10-01, sans changer la décision : elle dit comment les
écrans et le code l'appliquent, et les choix par défaut qu'ils ont dû faire.

### Écrans et droits

- **`/services`** : catalogue, archivés, création, modification, archivage.
  La nature d'un service ne change plus après sa création, ni un code posé :
  les souscriptions, les offres et la facturation s'y fient. Un code de
  `serviceCodes` sans service vivant est signalé en tête de liste, avec un
  lien qui préremplit sa création ; seul le prix reste à saisir.
- **`/offres`** : liste avec le prix par période, création, en-tête, lignes
  (ajout, modification, retrait logique), archivage. Le formulaire de ligne
  annonce, à chaque saisie, le prix de la ligne et le nouveau total de
  l'offre, calculés dans le navigateur par le même moteur que la page.
- **Fiche client** : section « Services souscrits » (en cours et à venir,
  historique replié), page « Souscrire un service », page de gestion d'une
  souscription.
- `services.gerer` (catalogue et offres) et `souscriptions.gerer` (souscrire,
  changer les conditions, mettre fin, annuler) restent à l'exploitant ;
  l'accueil lit la section sur la fiche client (`clients.gerer`).

### Prix d'une offre (`facturation/offres-prix.ts`)

- **Le prix d'une offre est celui d'une période de facturation.** La quantité
  d'une ligne est due à chaque période : un bureau dans une offre
  trimestrielle s'écrit trois mois. Aucun multiplicateur caché.
- **Prix unitaire** : le prix forfaitaire de la ligne, sinon le catalogue —
  la grille par défaut du centre si elle est en vigueur au jour du devis
  (dates de validité, ADR 023), la ligne nominative l'emportant sur celle du
  type ; le prix du service. Une ligne sans prix est signalée et sort du
  total : rien n'est inventé.
- **Remise** : par `lineNetAmountCents`, la règle d'arrondi unique de la base.
  Une remise qui rendrait la ligne négative est signalée.
- **Ligne d'acte** : N actes inclus par période, à 0 € dans le prix de
  l'offre ; le prix d'un acte au-delà est affiché. Pas de remise en montant
  sur un acte : elle vaut « par période », un acte n'en a pas.
- **TVA** : taux de la ligne, sinon du service, sinon du centre ; calculée
  comme sur la facture (`invoiceAmounts` : par taux, sur la somme des bases,
  l'écart d'arrondi porté par la ligne de plus forte valeur).
- L'écran montre aussi le prix catalogue de l'ensemble (actes inclus
  valorisés) et la remise qu'en fait l'offre, et le total sur la durée
  d'engagement quand elle compte un nombre entier de périodes.

### Souscriptions (`facturation/souscriptions-*.ts`)

- **Un acte se souscrit en quantité 1** : son prix est celui d'un acte
  au-delà des inclus, sa remise un pourcentage, ses inclus
  (`included_quantity`) un nombre d'actes par mois civil du centre.
- **Changer la quantité ou le prix** : la souscription prend fin la veille de
  la date d'effet, une nouvelle la suit aux nouvelles conditions (même
  client, service et contrat, même fin prévue), dans une transaction. Au
  premier jour, et si rien n'a été facturé, la souscription est annulée et
  remplacée. Jamais sur un jour déjà facturé : le dernier jour d'une ligne de
  facture qui la tient (brouillon compris, ni retirée ni libérée par un
  avoir) borne la date d'effet.
- **Fin** : au plus tôt le premier jour et le dernier jour facturé ; vide,
  sans fin. Prolonger sur la souscription qui prend la suite est refusé par
  la base (`subscribed_services_no_overlap`).
- **Annulation** (`deleted_at`) : seulement si aucune ligne de facture ne la
  tient ; sinon on y met fin. Elle reste dans l'historique, « Annulée ».
- **Valorisation des actes** : `priceActs` applique la règle « Ce qu'un acte
  coûte » ci-dessus. Si deux souscriptions au même acte sont en vigueur le
  même jour (deux contrats), la plus avantageuse pour le client l'emporte :
  celle qui a encore des inclus, puis le prix net le plus bas. La fiche
  client montre la consommation du mois pour `courrier.ouverture`, seul acte
  que l'application enregistre aujourd'hui.

### Données initiales

`facturation/services-attendus.ts` décrit `courrier.ouverture` : désignation,
acte, à l'unité, TVA 20 %. **Sans prix.** `infra/configurer-centre.mjs` le
crée au prix inscrit dans `PRIX_DES_SERVICES` — nul tant que le centre ne l'a
pas fixé : le service n'est alors pas créé et le script le signale — et ne
touche jamais un service déjà au catalogue. L'écran Services propose la même
création. Une migration de données aurait dû inventer un prix.

### À valider par le centre et l'expert-comptable

- Le prix de l'ouverture et de la numérisation d'un pli ; la TVA à 20 % des
  services et des lignes d'offre par défaut.
- La quantité d'une ligne d'offre due par période ; les actes inclus à 0 €
  dans le prix de l'offre.
- Les inclus comptés par mois civil ; la souscription la plus avantageuse
  quand deux sont en vigueur.
- Pas de remise en montant sur un acte.
