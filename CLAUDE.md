# CLAUDE.md

## Produit

Application de gestion de centre d'affaires. Outil interne dans un premier
temps (un seul centre), conçu pour pouvoir devenir un SaaS multi-centres sans
réécriture.

Deux populations d'utilisateurs :

- **staff** : équipe du centre (back-office complet)
- **client** : entreprises locataires (portail en libre-service)

Six domaines fonctionnels, tous présents dans l'arborescence dès le départ :
ressources, réservations, clients, contrats, facturation, courrier,
états des lieux.

## Stack

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS
- PostgreSQL 17 + Drizzle ORM
- better-auth
- Hébergement : Vercel (app) + Neon (base), **région EU obligatoire**
- Stockage fichiers : S3 européen (scans de courrier, photos d'états des lieux)

## Structure

```
src/
  app/
    (admin)/        back-office staff
    (portail)/      espace client
  modules/          code métier, un dossier par domaine
    ressources/
    reservations/
    clients/
    contrats/
    facturation/
    courrier/
    etats-des-lieux/
  db/
    migrations/
  lib/              utilitaires transverses
docs/
  decisions/        un ADR par décision structurante
infra/
```

Le code est organisé **par domaine métier, pas par couche technique**. Chaque
module contient son schéma Drizzle, ses règles métier, ses actions serveur et
ses composants. Pas de dossier `components/` global.

## Décisions non négociables

Ne pas remettre en question sans écrire un nouvel ADR.

### 1. `tenant_id` sur toutes les tables métier

Même en mono-centre. Colonne `tenant_id` non nulle, valeur par défaut pointant
sur le tenant unique. Row Level Security Postgres activé.

Raison : le passage en multi-centres est prévu. Ajouter la colonne aujourd'hui
coûte une heure, l'ajouter après deux ans de données coûte une migration à
risque sur toutes les tables.

### 2. Ressources polymorphes en une seule table

Une table `resources` avec un `resource_type` (salle, bureau, casier, véhicule,
boîte aux lettres) et une colonne `attributes` en JSONB pour les champs
spécifiques (kilométrage, numéro de casier, superficie).

**Jamais une table par type de ressource.** Le calendrier de disponibilité, les
réservations et la facturation sont communs à tous les types ; les dupliquer
par type multiplie le code par cinq pour rien.

### 3. Anti-double-réservation au niveau base

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
ADD CONSTRAINT bookings_no_overlap
EXCLUDE USING gist (
  resource_id WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status <> 'cancelled');
```

La contrainte d'exclusion rend le chevauchement impossible quelles que soient
les erreurs applicatives ou la concurrence. Ne jamais la remplacer par une
vérification en code.

Bornes `[)` : une réservation qui finit à 10h00 et une qui commence à 10h00 ne
se chevauchent pas.

### 4. Tout en UTC en base, fuseau à l'affichage

Colonnes `timestamptz`. Les centres d'affaires peuvent être dans des fuseaux
différents et les horaires de réservation traversent les changements d'heure.

### 5. Montants en centimes, entiers

Jamais de flottant pour de l'argent. `integer` en centimes, devise stockée à
côté.

### 6. Pas de suppression physique

`deleted_at` sur les entités métier. Un contrat, une facture ou un état des
lieux doivent rester consultables après coup, y compris pour des raisons
légales.

## Facturation

Hors scope de la V1 (outil interne). Mais la réforme française impose la
réception de factures électroniques depuis septembre 2026 et l'émission pour
les TPE/PME au 1er septembre 2027.

Conséquence sur les choix dès maintenant : les factures sont stockées en
**données structurées**, pas en PDF généré. Le PDF est une vue, pas la source
de vérité. L'émission passera par une plateforme agréée, jamais par du code
maison.

## RGPD

Le module courrier manipule des documents sensibles (scans de courrier
d'entreprises domiciliées). Contraintes appliquées partout :

- Hébergement et stockage en région EU
- Durées de conservation définies par type de donnée
- Journal d'accès sur la consultation des scans de courrier
- Pas de données réelles en environnement de développement

## UX/UI

**La direction artistique est celle de Secutop**, dans
`.claude/skills/secutop-brand/SKILL.md`. Elle fait autorité sur la palette, la
typographie, les rayons, l'iconographie, l'imagerie et le ton. À lire avant de
produire le moindre écran ; en cas de contradiction avec ce qui suit, elle prime,
sauf sur la règle des polices auto-hébergées ci-dessous.

Rappel des points structurants, tous déjà appliqués dans `src/app/globals.css` :
`#1FABE3` et `#00487B` sur blanc et rien d'autre, Rubik partout, rayons généreux
(8px inputs, 12px boutons, 16px cartes, 24px grands conteneurs), icônes Lucide
outline de taille homogène, transitions 150–250ms en `ease-out`.

Socle de composants et cas non couverts par la charte : ADR 004. Règles de
travail quotidien :

### Non négociable

- **Accessibilité clavier.** Toute action réalisable à la souris l'est au
  clavier, dans un ordre de tabulation qui suit l'ordre visuel. Focus visible
  partout, y compris dans les dialogues. Jamais d'`outline-none` sans
  remplacement.
- **Jamais l'information par la couleur seule.** Un statut se lit par la couleur
  *et* par du texte ou une icône. Vaut en premier lieu pour les états de
  réservation et les erreurs de formulaire.
- **Les états de réservation sont portés par les bleus de marque**, jamais par un
  code vert/rouge : jetons `--statut-disponible`, `--statut-reserve`,
  `--statut-confirme`, `--statut-annule`, et `--statut-conflit` pour le seul cas
  anormal. Un créneau réservé n'est pas une erreur.
- **Contraste 4,5:1 minimum** sur le texte courant.
- **Tout libellé est visible.** Un `placeholder` n'est pas un label.
- **`prefers-reduced-motion` respecté.** L'animation sert à expliquer un
  changement d'état, jamais à décorer.

### Formulaires

- Champ = label associé + contrôle. Avec shadcn : `Field` + `FieldLabel`, pas
  l'ancien `FormItem`.
- Erreur annoncée aux lecteurs d'écran (`role="alert"` ou `aria-live`), placée
  près du champ concerné.
- En cas d'échec de soumission, un résumé des erreurs en haut du formulaire,
  focusable, avec un lien vers chaque champ invalide. Les erreurs en ligne sont
  conservées, pas remplacées.
- Toute soumission rend un état : chargement, puis succès ou échec.

### Tableaux et listes

- Vrai `<table>` sémantique pour des données tabulaires, jamais une grille de
  `div`.
- Enveloppe `overflow-x-auto` — le corps de page ne défile jamais
  horizontalement.
- Sélection multiple et actions groupées dès qu'une action se répète ligne par
  ligne.
- Un état vide dit quoi faire ensuite, il ne laisse pas un écran blanc.

### Mise en page

- Back-office : dense, desktop-first, l'espace vertical est précieux. C'est le
  cas « dense quand il le faut » de la charte, pas une licence pour tasser.
- Portail client : mobile-first, vérifié à 375 px.
- Largeur de contenu lisible ~1200–1280 px, texte long 65–75 caractères.
- Échelle d'espacement 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Aéré entre sections,
  compact à l'intérieur d'une section.
- Cibles de pointage : 24 px minimum sur le web, 44 px sur le portail au
  téléphone, 8 px d'écart entre deux cibles adjacentes.
- Réserver la place des contenus asynchrones — pas de saut de mise en page au
  chargement.

### Localisation

- `lang="fr"`, interface en français.
- Dates et montants au format français. Les dates sont converties du UTC vers le
  fuseau du centre à l'affichage, les montants des centimes vers l'euro. Jamais
  l'inverse en base (décisions 4 et 5).

### Ressources

- Polices via `next/font` uniquement. Jamais d'`@import` vers
  `fonts.googleapis.com`, **y compris la formulation CSS de la charte** : cela
  transmet l'IP de l'utilisateur à Google et contredit la contrainte
  d'hébergement EU.
- Pas de police monospace. Pour aligner montants et horaires en colonne, la
  classe `.tabular` (`font-variant-numeric: tabular-nums`) sur Rubik.
- Icônes Lucide en outline, stroke 1,5–2px, taille homogène dans un écran. Pas
  d'emoji dans l'UI produit.
- Pas de thème sombre : la charte n'en définit aucun.

### Outillage

Le plugin `ui-ux-pro-max` est installé et sert à sourcer une règle avant de
trancher :

```bash
python "$CLAUDE_PLUGIN_ROOT/.claude/skills/ui-ux-pro-max/scripts/search.py" \
  "<requête>" --domain ux          # règles UX et accessibilité
  "<requête>" --stack nextjs       # ou --stack shadcn
```

Les bases sont indexées sur du vocabulaire technique anglais : une requête
métier ne renvoie rien. Son mode `--design-system` produit des structures de
landing page et ne convient pas à ce produit — ne pas l'utiliser.

## Conventions

- Nommage base de données : `snake_case`, tables au pluriel
- Nommage TypeScript : `camelCase`, composants en `PascalCase`
- Identifiants : UUID v7 (ordonnés temporellement, meilleurs index que v4)
- Migrations : générées par Drizzle, jamais éditées après application
- Branches : `feat/`, `fix/`, `chore/` — pas de commit direct sur `main`
- Un ADR dans `docs/decisions/` à chaque décision structurante

## Commandes

```bash
npm run dev              # serveur de développement
docker compose up -d     # base Postgres locale
npx drizzle-kit generate # générer une migration
npx drizzle-kit migrate  # appliquer les migrations
npx tsc --noEmit         # vérification des types
npm run lint
```

## Ordre de construction

Une tranche = de la base à l'écran, déployée en production, utilisable. Jamais
« toutes les tables, puis toutes les API, puis tout le front ».

1. Ressources + calendrier + réservation en back-office
2. Clients + grilles tarifaires + contrats
3. Facturation récurrente
4. Portail client (réservation en ligne)
5. Courrier et domiciliation
6. États des lieux

## Attentes vis-à-vis de l'assistant

- Proposer le changement minimal qui résout le problème
- Signaler quand une demande contredit une décision ci-dessus plutôt que de
  l'appliquer silencieusement
- Écrire un test pour toute règle métier (disponibilité, tarif, prorata)
- Pas de dépendance nouvelle sans justification explicite
