---
name: secutop-brand
description: "Applique la direction artistique Secutop à toute création visuelle ou interface. Déclenche dès qu'il s'agit de concevoir, designer, coder ou produire un artefact pour Secutop, ses sous-marques (Secusoft, Formatop, Secuskills, Secuquizz, Secudiag, Caretop), ou quand l'utilisateur dit « ma boîte / mon entreprise / notre marque » dans un contexte Secutop : applications web, composants UI (React, HTML/CSS, Tailwind, Figma), landing pages, sites, dashboards, maquettes, infographies, posters, slides, emails, plaquettes, flyers, visuels réseaux sociaux, data viz, illustrations. À utiliser même sans demande explicite de « respecter la charte » — dès qu'une production portera l'identité Secutop, la charte s'applique par défaut pour garantir la cohérence visuelle globale à travers toutes les productions et tous les collaborateurs."
---

# Secutop — Direction artistique

Cette charte doit être appliquée à **toute** production visuelle ou interface qui portera l'identité Secutop ou l'une de ses sous-marques. Objectif : une cohérence visuelle globale et immédiatement reconnaissable, quelle que soit la personne qui produit et quel que soit le support (app, page web, infographie, slide, email, print).

## 1. Identité de marque

- **Nom** : Secutop
- **Baseline** : *You'll never work alone*
- **Site** : https://secutop.fr
- **Positionnement** : plateforme digitale multiservices en santé et sécurité au travail. Formation, DUERP, QHSE, référent externalisé (IPRP), QVT, accompagnement 360°, couverture nationale.
- **Sous-marques** : Secusoft (plateforme DUERP), Formatop (formation), Secuskills, Secuquizz, Secudiag, Caretop. Elles partagent la même DA que Secutop ; seul le logo dédié change.
- **Personnalité visuelle** : **pro, minimaliste, sérieux, carré**. Rigueur, clarté, confiance — jamais gadget, jamais criard.
- **Public** : dirigeants et responsables RH/QHSE d'entreprises et de collectivités. B2B sérieux.

## 2. Palette couleurs

| Rôle | Hex | Usage |
|---|---|---|
| Bleu clair Secutop | `#1FABE3` | Couleur principale d'accent, CTA, liens actifs, icônes, highlights, données clés dans les data viz |
| Bleu foncé Secutop | `#00487B` | Titres forts, header, fond de bloc "autorité", texte sur fond clair, seconde couleur d'accent |
| Blanc | `#FFFFFF` | Fond principal, respiration |

### Règles couleur (strictes)
- **Pas d'autre couleur chaude ou saturée hors palette.** Pas d'orange, pas de rouge, pas de violet, pas de vert fluo, pas de rose. Jamais.
- Le noir pur (`#000`) est à éviter pour le texte — utiliser un gris foncé neutre (ex : `#1A1A1A` ou `#222`) pour les longs textes sur fond blanc.
- Gris neutres autorisés pour bordures, backgrounds secondaires, textes secondaires : `#F7F9FB` (fond alterné), `#E5E9EE` (bordures/séparateurs), `#6B7280` (texte secondaire).
- **Dégradés** : à utiliser avec parcimonie, uniquement entre `#1FABE3` et `#00487B`, et jamais sur du texte.
- **Alertes sémantiques** (succès / erreur / warning) : autorisées car fonctionnelles, mais les garder désaturées (ex : `#16A34A`, `#DC2626`, `#D97706`) et réserver à l'UI state, jamais pour la marque.

## 3. Typographie

- **Famille** : `font-family: 'Rubik', Helvetica, Arial, 'DejaVu Sans', 'Liberation Sans', FreeSans, sans-serif;`
- **Rubik partout** : titres, corps, boutons, labels. Pas d'autre font secondaire.
- **Poids utilisés** :
  - `600/700` pour les titres (H1, H2, H3)
  - `500` pour les CTA et labels
  - `400` pour le corps de texte
  - `300` possible pour sous-titres discrets
- **Hiérarchie type** (web, base 16px) : H1 ~40–48px / H2 ~28–32px / H3 ~20–22px / body 16px / small 14px. Adapter au support mais respecter les rapports.
- **Line-height** généreux : 1.5 sur le body, 1.2 sur les titres.
- **Casse** : pas de `text-transform: uppercase` massif sauf petits labels ou picto-titres courts.

## 4. Logo & sous-marques

- Logo principal Secutop présent dans le header du site (`https://www.secutop.fr/wp-content/themes/seowp-child/images/logo.png`).
- **Clear space** : laisser au moins la hauteur du "S" du logo autour de celui-ci.
- **Ne jamais** : recolorer le logo, le déformer, le mettre sur un fond qui tue le contraste, ajouter d'ombre portée, tourner, mixer avec un autre logo sans séparateur.
- Sur fond sombre (`#00487B`) : utiliser la version blanche du logo.
- Les sous-marques (Secusoft, Formatop...) ont leurs propres logos à récupérer sur le site. Ne jamais reconstruire un logo de sous-marque "à la volée" — demander le fichier.

## 5. Iconographie

- **Style : outline blanc** sur fond bleu (`#1FABE3` ou `#00487B`), ou outline bleu sur fond blanc.
- Stroke width homogène (~1.5–2px), coins légèrement arrondis.
- **Pas d'icônes** : 3D, emojis colorés, flat multicolores, isométriques, hand-drawn, duotone gradient.
- Bibliothèque recommandée quand dispo : **Lucide** ou **Phosphor (outline)**. Heroicons outline aussi OK.
- Taille d'icône cohérente dans un même écran (ex : toutes à 20px ou toutes à 24px, pas un mix).

## 6. Imagerie

- **Photos réalistes** montrant de vrais professionnels en situation santé/sécurité au travail : formateurs, référents, salariés en EPI, équipements, environnements industriels/tertiaires réels.
- **Interdit : photos stock génériques** — le cliché « poignée de main en costume », « équipe diverse qui rigole autour d'un laptop », « ampoule idée », etc. Zéro.
- Privilégier : matière, texture, situations concrètes, regards, geste technique, terrain.
- Traitement : naturel, contrasté sans être trop saturé. Pas de filtre vintage, pas de noir & blanc sauf cas éditorial motivé.
- Ne jamais générer ou utiliser d'illustration « corporate memphis » (bonshommes colorés sans visage) — c'est l'inverse de l'ADN Secutop.

## 7. UI & interfaces (apps, pages web, dashboards)

Référence d'ambiance : **Airbnb** — clarté, aéré mais dense quand il le faut, typographie soignée, priorité au contenu.

### Layout
- **Responsive first**. Toujours. Mobile, tablette, desktop. Pas de "min-height" arbitraire qui casse le mobile.
- Aéré mais **pas de gros padding inutile**. Éviter les sections qui forcent l'utilisateur à scroller pour rien.
- Grille 12 colonnes classique sur desktop, stack sur mobile.
- Max-width de contenu lisible : ~1200–1280px, texte long ~65–75 caractères par ligne.

### Composants
- **Border-radius important** — c'est un signal fort de la marque. Valeurs types : `8px` (petits éléments : inputs, tags), `12–16px` (boutons, cartes), `20–24px` (grands conteneurs, modales, images). Jamais de coins carrés vifs sauf raison fonctionnelle.
- **Boutons** :
  - Primaire : fond `#1FABE3`, texte blanc, radius 12px, hover léger (assombrir 5–10%), pas de bordure, pas d'ombre lourde.
  - Secondaire : fond blanc, bordure `#1FABE3` 1px, texte `#1FABE3`.
  - Tertiaire/ghost : texte `#00487B` souligné au hover, pas de fond.
  - Padding standard : `12px 20px` sur bouton de base.
- **Cartes** : fond blanc, radius 16px, ombre très légère (`0 1px 3px rgba(0,0,0,0.06)` ou aucune), bordure 1px `#E5E9EE` quand ombre absente.
- **Inputs** : bordure 1px `#E5E9EE`, focus `#1FABE3` (2px ou ring), radius 8px, padding confortable.
- **Ombres** : discrètes. Pas d'ombres portées épaisses type "néomorphisme", pas de glow coloré.

### Espacement
- Échelle cohérente basée sur 4px : 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64.
- Aéré entre sections, compact à l'intérieur d'une section.

### Animations
- Sobres. Transitions 150–250ms, easing `ease-out`. Pas de bounce, pas de parallax lourd, pas de confettis.

## 8. Data viz & infographies

- Palette dérivée : `#1FABE3` en série principale, `#00487B` en série secondaire, puis nuances dérivées (`#7BC8E9`, `#005E9E`, `#CDE9F5`) si besoin de plus de séries. Éviter d'introduire du orange/vert/rouge pour "colorer" — rester dans la palette.
- Graphiques : grilles discrètes grises, axes fins, labels en Rubik. Pas de 3D, pas de skew, pas d'effet miroir.
- Infographies : utiliser la palette + l'iconographie outline. Toujours une structure claire (titre, chiffre clé, contexte, source).
- **Source de données** : toujours citée en bas, typo plus petite, gris moyen.

## 9. Ton éditorial (quand du texte accompagne le visuel)

- Ton **pro, direct, rassurant**. On parle de santé, sécurité et conformité — jamais de second degré ou de familiarité excessive.
- Vocabulaire métier : DUERP, QHSE, IPRP, EPI, article L4121-1, prévention des risques, habilitation électrique, CACES, PRAP, CSE, RPS.
- Phrases courtes. Verbes d'action. Claire valeur pour le client.
- Baseline présente : *You'll never work alone* — positionnée en fin de section ou en signature, jamais noyée dans le corps.

## 10. Do / Don't (référence rapide)

**Do**
- Bleu clair + bleu foncé + blanc, point final.
- Rubik en 400/500/600/700, hiérarchie claire.
- Border-radius généreux, layout aéré et responsive.
- Photos réelles et métier, icônes outline.
- Référence mentale : Airbnb pour l'UI, rapports sérieux type Bain/McKinsey pour les infographies.

**Don't**
- Jamais de photos stock génériques (poignées de main, ampoules, équipes qui applaudissent).
- Jamais de couleurs hors palette (pas d'orange, rouge, violet, etc. en décoration).
- Pas de coins carrés vifs systématiques.
- Pas de 3D, néomorphisme, glassmorphism lourd, illustrations corporate memphis.
- Pas d'emojis dans l'UI produit. OK en social/marketing ponctuel si cohérent.
- Pas de gros padding qui gonfle artificiellement la page.
- Pas de logo déformé, recoloré ou posé sans clear space.

## 11. Checklist avant de livrer

Avant de rendre une production Secutop, vérifier :

- [ ] Palette respectée : seulement `#1FABE3`, `#00487B`, blanc et gris neutres ?
- [ ] Typo Rubik partout avec les bons poids ?
- [ ] Border-radius cohérent sur boutons / cartes / inputs ?
- [ ] Icônes en style outline, taille homogène ?
- [ ] Imagerie réaliste, non générique ?
- [ ] Responsive testé mentalement (mobile → desktop) ?
- [ ] Logo correctement utilisé (version, clear space, fond) ?
- [ ] Ton éditorial pro et direct ?

Si un choix n'est pas couvert par cette charte, par défaut privilégier : **sobre > sophistiqué**, **carré > décoratif**, **clarté > fantaisie**. En cas de vrai doute, poser la question plutôt qu'improviser.
