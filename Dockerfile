# Image de production, servie sur le VPS de production (ADR 013).
#
# Construite sur un poste, jamais sur le serveur (`infra/serveur/README.md`,
# section 4) : `next build` demande plus de mémoire qu'un petit VPS n'en a. Le build n'exige aucun secret ; les
# variables d'environnement sont lues à l'exécution, depuis le `.env` du
# serveur.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Dépendances d'exécution seules, pour l'outil de migration (voir plus bas).
FROM node:24-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
# `standalone` ne recopie ni les fichiers statiques du build ni `public/` :
# sans ces deux lignes, pages sans styles et logos introuvables.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Outillage d'exploitation (`node infra/migrer.ts`, configurer-centre,
# chiffrer-documents… lancés par le service `migrer` de
# infra/serveur/compose.yml). Il importe le schéma Drizzle et lit les fichiers
# SQL de `src/db`, que `standalone` ne recopie pas : on joint le code source de
# `src` (du TypeScript, que Node 24 exécute tel quel) et les dépendances
# d'exécution complètes (mysql2, drizzle-orm). Elles recouvrent celles, tracées
# en partie, de `standalone` : mêmes versions, issues du même package-lock.
COPY --from=deps-prod --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/infra ./infra
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node", "server.js"]
