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

Secutop dispose d'une charte graphique établie, qui s'applique à toute production
portant son identité. Cet outil en fait partie. La charte n'est donc pas un choix
ouvert par cet ADR : elle est une contrainte d'entrée.

## Décision

**La direction artistique est celle de Secutop**, reproduite dans
`.claude/skills/secutop-brand/SKILL.md` et faisant autorité sur tout ce qu'elle
couvre : palette (`#1FABE3`, `#00487B`, blanc, gris neutres), typographie Rubik,
rayons généreux, iconographie outline, ton éditorial. Cet ADR ne tranche que ce
que la charte ne couvre pas.

**Socle de composants : shadcn/ui** (primitives Radix + Tailwind), dont le code
est copié dans le dépôt et nous appartient. Ses valeurs par défaut sont
retouchées à la charte au moment de l'installation : rayon de base à 12px et non
8px, jetons de couleur déjà définis dans `globals.css`.

**Exception à « pas de dossier `components/` global »** : `src/components/ui/`
accueille les primitives sans métier (bouton, champ, dialogue, tableau, popover,
sélecteur de date). Tout composant qui connaît une ressource, une réservation ou
un contrat reste dans son module. La règle de `CLAUDE.md` visait les composants
métier ; elle continue de s'appliquer à eux sans changement.

**Les états de réservation sont portés par les bleus de marque**, pas par un code
vert/rouge : disponible en fond blanc bordé, réservé en `#1FABE3`, confirmé en
`#00487B`, annulé en gris `#F7F9FB`, conflit en `#DC2626`. Chaque état porte en
plus un libellé — la couleur ne suffit jamais.

**Pas de thème sombre.** Le bloc `prefers-color-scheme: dark` hérité du scaffold
est retiré.

## Justification

**shadcn plutôt que des composants maison.** L'application a besoin d'un dialogue
avec piège de focus, d'un combobox, d'un sélecteur de date et d'un tableau
triable, tous pilotables au clavier. Ce sont précisément les composants qu'on
écrit mal à la main, et l'accessibilité clavier est une contrainte non négociable
ici : l'équipe du centre saisit des réservations toute la journée. Radix résout ce
problème, et le modèle copier-coller de shadcn évite la dépendance à une
bibliothèque qui imposerait son design — ce qui compte doublement quand une
charte impose déjà le sien.

Les dépendances ajoutées (primitives Radix, `class-variance-authority`, `clsx`,
`tailwind-merge`) sont justifiées par cet ADR, comme l'exige `CLAUDE.md`. Elles
n'ont aucune emprise sur le modèle métier.

**Pourquoi une exception plutôt qu'un contournement.** On pourrait disperser les
primitives dans les modules, mais un bouton n'appartient à aucun domaine, et le
dupliquer par module contredit l'esprit de la règle bien plus que de créer un
dossier pour lui. La frontière est nette et vérifiable : si le composant importe
quelque chose de `src/modules/`, il n'a rien à faire dans `src/components/ui/`.

**Pourquoi les bleus pour les statuts.** L'usage courant code la disponibilité en
vert et l'occupation en rouge. La charte l'interdit : hors alerte fonctionnelle,
aucune couleur ne sort de la palette. Or un créneau réservé n'est pas une erreur,
c'est le fonctionnement normal du centre — le peindre en rouge serait faux sur le
fond autant que sur la forme. Le rouge reste donc au seul conflit, c'est-à-dire à
la situation que la contrainte d'exclusion en base est censée rendre impossible.

**Polices auto-hébergées, jamais en CDN.** `next/font` télécharge Rubik au build
et la sert depuis notre domaine. Un `@import` vers `fonts.googleapis.com` — ce
que recommandent la charte elle-même dans sa formulation CSS et la plupart des
générateurs de design system — enverrait l'adresse IP de chaque utilisateur à
Google à chaque page. Le projet impose l'hébergement en région EU ; la règle en
découle et prime sur la formulation de la charte, qui vise le cas général.

**Pas de police monospace.** La charte est explicite : Rubik partout, pas de
seconde famille. Le besoin réel derrière une monospace dans cet outil est
l'alignement des montants et des horaires en colonne, qui se règle avec
`font-variant-numeric: tabular-nums` sur Rubik.

**Pas de thème sombre.** La charte ne définit aucune palette sombre et pose le
blanc comme fond principal. Garder le bloc du scaffold reviendrait à servir, à la
moitié des visiteurs, une interface hors charte composée de couleurs que personne
n'a choisies. L'ajouter demanderait une extension de la charte, pas une décision
de développeur.

## Alternatives écartées

**Tout écrire à la main en Tailwind pur.** Aucune dépendance nouvelle, respect
littéral des règles existantes. Écarté parce que le coût réel n'est pas le
bouton, c'est le dialogue modal avec gestion du focus, le combobox et le
sélecteur de date. Les écrire correctement représente plusieurs semaines, et les
écrire à moitié produit exactement les défauts d'accessibilité qu'on veut
interdire.

**Une bibliothèque complète (Mantine, MUI).** Le plus rapide sur les écrans CRUD
du back-office. Écartée parce qu'elle impose son design et son système de thème,
qu'il faudrait ensuite combattre sur chaque écran pour revenir à la charte.

**Garder Geist**, la police du scaffold. Écartée sans hésitation : la charte
impose Rubik, et une police n'est pas un détail d'implémentation mais un élément
d'identité.

**Laravel + Filament**, déjà écarté à l'ADR 001, aurait rendu cette décision
inutile en générant le back-office. C'est le coût assumé du choix TypeScript.

## Conséquences

Positives : les écrans de la tranche 1 démarrent sur des primitives accessibles
et déjà à la charte. Le code des composants nous appartient, donc aucune montée
de version subie. Les jetons de `globals.css` donnent au calendrier un
vocabulaire d'états avant qu'il soit écrit.

Négatives : `src/components/ui/` est une entorse à une règle de structure, et les
entorses appellent les entorses. La frontière doit être tenue à la revue — un
composant qui importe un module métier n'y a pas sa place.

L'échelle de rayons de Tailwind est redéfinie dans `globals.css` : `rounded-md`
vaut 12px et non 6px. Tout exemple de code copié depuis la documentation shadcn
ou Tailwind rendra donc des coins plus arrondis que sur les captures d'origine.
C'est voulu.

shadcn génère des fichiers en `kebab-case` (`button.tsx`) exportant des
composants en `PascalCase`. C'est leur convention, on la garde telle quelle pour
que la CLI reste utilisable ; la règle `PascalCase` de `CLAUDE.md` porte sur le
nom du composant, pas sur celui du fichier.

L'installation (`npx shadcn@latest init`) n'est pas faite par cet ADR. Elle a
lieu au premier écran qui en a besoin, conformément à la règle « une tranche va de
la base à l'écran ».

La charte vit dans `.claude/`, qui est ignoré par git : elle n'est donc pas
partagée par le dépôt. Si l'équipe s'agrandit, la déplacer dans `docs/` devient
nécessaire.
