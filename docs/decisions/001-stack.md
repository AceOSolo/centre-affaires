# ADR 001 — Choix de la stack

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Application de gestion de centre d'affaires à développer depuis zéro. Usage
interne au démarrage, un seul centre, une équipe de développement réduite.
Perspective de commercialisation en SaaS multi-centres à moyen terme.

Contraintes : deux interfaces distinctes (back-office staff et portail client),
un domaine métier riche (réservations, contrats, facturation, documents), des
données personnelles et des documents sensibles soumis au RGPD.

## Décision

- **Next.js 16 / App Router / TypeScript**, une seule application servant les
  deux interfaces via des route groups
- **PostgreSQL 17** avec **Drizzle ORM**
- **better-auth** pour l'authentification et les rôles
- **Vercel** pour l'hébergement applicatif, **Neon** pour la base, en région EU
- Monorepo, organisation du code par domaine métier

## Justification

Une seule application plutôt que deux services séparés : le back-office et le
portail partagent le même modèle métier, les mêmes règles de disponibilité et
les mêmes tarifs. Les séparer imposerait une API interne et une duplication de
la logique pour un bénéfice nul à cette échelle.

PostgreSQL plutôt qu'une autre base : les contraintes d'exclusion sur plages
temporelles (`EXCLUDE USING gist`) résolvent nativement le problème central du
produit, le double-booking. Le JSONB permet les attributs variables des
ressources et les formulaires d'états des lieux sans table par type. Le Row
Level Security prépare le multi-tenant.

Drizzle plutôt que Prisma : migrations en SQL lisible et éditable, ce qui est
nécessaire pour poser des contraintes d'exclusion et des politiques RLS que les
ORM à schéma déclaratif ne savent pas exprimer.

## Alternatives écartées

**Laravel + Filament** : génère une large part du back-office CRUD
automatiquement et aurait fait gagner plusieurs semaines sur les écrans
d'administration. Écarté par préférence pour un écosystème TypeScript unique
sur les deux interfaces. À reconsidérer si le volume d'écrans de gestion
devient le goulot d'étranglement.

**Solution existante (ERP open source, SaaS de coworking)** : couvre la
réservation et la facturation, mais aucune ne gère la domiciliation et la
gestion de courrier, qui sont un besoin central ici. La personnalisation aurait
coûté plus que le développement.

**Microservices** : volume de trafic et taille d'équipe sans rapport avec le
coût opérationnel. Un monolithe modulaire, découpé par domaine, permet
d'extraire un service plus tard si un besoin réel apparaît.

## Conséquences

Positives : une seule base de code, un seul déploiement, un modèle métier
partagé sans synchronisation. Le multi-tenant est préparé sans être payé tout
de suite.

Négatives : dépendance à Vercel pour le déploiement, avec un coût qui monte si
le trafic augmente fortement. Sortie possible vers un conteneur Docker
autohébergé, à documenter si la question se pose.

Le back-office devra être construit écran par écran, sans génération
automatique. C'est le coût principal de ce choix.
