# ADR 004 — Socle d'interface

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Le projet n'avait aucune consigne d'interface. `CLAUDE.md` fixait Tailwind, les
route groups et la localisation des composants ; rien sur les couleurs, la
typographie, les formulaires, les tableaux ou l'accessibilité. `src/app/` était
resté le scaffold `create-next-app` intact.

La tranche 1 (ressources + calendrier + réservation en back-office) commence, et
le calendrier de disponibilité est l'écran le plus difficile du produit : grille
temporelle dense, états multiples par créneau, conflits à rendre visibles. Le
construire sans conventions revient à les figer par accident dans le premier
écran.

Deux populations aux besoins opposés, déjà actées à l'ADR 001 : le back-office
est utilisé toute la journée par l'équipe du centre, au clavier, sur grand écran ;
le portail client est consulté ponctuellement, souvent au téléphone, par des gens
qui ne seront jamais formés.

## Décision

**Socle de composants : shadcn/ui** (primitives Radix + Tailwind), dont le code
est copié dans le dépôt et nous appartient.

**Exception à « pas de dossier `components/` global »** : `src/components/ui/`
accueille les primitives sans métier (bouton, champ, dialogue, tableau, popover,
sélecteur de date). Tout composant qui connaît une ressource, une réservation ou
un contrat reste dans son module. La règle de `CLAUDE.md` visait les composants
métier ; elle continue de s'appliquer à eux sans changement.

**Typographie : Geist**, déjà en place, chargée par `next/font`. Pas de
changement.

**Direction visuelle : dense et sobre.** Flat + Swiss style, hiérarchie portée
par l'espacement et le poids de la typographie plutôt que par la couleur et les
ombres. Le back-office est un outil de travail, pas une vitrine.

**La couleur porte le statut, jamais seule.** Le domaine réservation impose une
palette sémantique : disponible, réservé, confirmé, annulé, conflit. Chaque état
est signalé par au moins deux canaux — couleur *et* texte ou icône.

## Justification

**shadcn plutôt que des composants maison.** L'application a besoin d'un dialogue
avec piège de focus, d'un combobox, d'un sélecteur de date et d'un tableau
triable, tous pilotables au clavier. Ce sont précisément les composants qu'on
écrit mal à la main, et l'accessibilité clavier est une contrainte non négociable
ici : l'équipe du centre saisit des réservations toute la journée. Radix résout ce
problème, et le modèle copier-coller de shadcn évite la dépendance à une
bibliothèque qui imposerait son design.

Les dépendances ajoutées (primitives Radix, `class-variance-authority`, `clsx`,
`tailwind-merge`) sont justifiées par cet ADR, comme l'exige `CLAUDE.md`. Elles
n'ont aucune emprise sur le modèle métier.

**Pourquoi une exception plutôt qu'un contournement.** On pourrait disperser les
primitives dans les modules, mais un bouton n'appartient à aucun domaine, et le
dupliquer par module contredit l'esprit de la règle bien plus que de créer un
dossier pour lui. La frontière est nette et vérifiable : si le composant importe
quelque chose de `src/modules/`, il n'a rien à faire dans `src/components/ui/`.

**Pourquoi garder Geist.** L'outil UI/UX consulté recommandait Inter, mais sa
justification (« Best For: Spatial computing, AR/VR, glassmorphism ») ne tient
pas pour un back-office. Geist est déjà chargée, neutre et lisible en corps
petit. Changer coûterait une migration pour rien.

**Polices auto-hébergées, jamais en CDN.** `next/font` télécharge les fichiers au
build et les sert depuis notre domaine. Un `@import` vers
`fonts.googleapis.com` — ce que recommandent la plupart des générateurs de design
system — enverrait l'adresse IP de chaque utilisateur à Google à chaque page. Le
projet impose l'hébergement en région EU ; cette règle en découle directement.

## Alternatives écartées

**Tout écrire à la main en Tailwind pur.** Aucune dépendance nouvelle, respect
littéral des règles existantes. Écarté parce que le coût réel n'est pas le
bouton, c'est le dialogue modal avec gestion du focus, le combobox et le
sélecteur de date. Les écrire correctement représente plusieurs semaines, et les
écrire à moitié produit exactement les défauts d'accessibilité qu'on veut
interdire.

**Une bibliothèque complète (Mantine, MUI).** Le plus rapide sur les écrans CRUD
du back-office. Écarté parce qu'elle impose son design et son système de thème
aux *deux* interfaces : le portail client doit pouvoir diverger visuellement du
back-office sans combattre la bibliothèque.

**Laravel + Filament**, déjà écarté à l'ADR 001, aurait rendu cette décision
inutile en générant le back-office. C'est le coût assumé du choix TypeScript.

## Conséquences

Positives : les écrans de la tranche 1 démarrent sur des primitives accessibles
plutôt que sur des `div`. Le code des composants nous appartient, donc aucune
montée de version subie. La palette sémantique donne au calendrier un vocabulaire
d'états avant qu'il soit écrit.

Négatives : `src/components/ui/` est une entorse à une règle de structure, et les
entorses appellent les entorses. La frontière doit être tenue à la revue — un
composant qui importe un module métier n'y a pas sa place.

shadcn génère des fichiers en `kebab-case` (`button.tsx`) exportant des
composants en `PascalCase`. C'est leur convention, on la garde telle quelle pour
que la CLI reste utilisable ; la règle `PascalCase` de `CLAUDE.md` porte sur le
nom du composant, pas sur celui du fichier.

L'installation (`npx shadcn@latest init`) n'est pas faite par cet ADR. Elle a
lieu au premier écran qui en a besoin, conformément à la règle « une tranche va de
la base à l'écran ».
