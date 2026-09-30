# Image de production, servie sur le VPS de production (ADR 013).
#
# Construite par la CI, jamais sur le serveur : `next build` demande plus de
# mémoire qu'un petit VPS n'en a. Le build n'exige aucun secret ; les
# variables d'environnement sont lues à l'exécution, depuis le `.env` du
# serveur.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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
USER node
EXPOSE 3000
CMD ["node", "server.js"]
