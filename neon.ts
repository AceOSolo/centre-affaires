import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Neon Auth = Better Auth managé (schéma `neon_auth`, compatible RLS).
  // C'est la brique d'authentification prévue par l'ADR 001, pas un doublon.
  auth: true,

  // Scans de courrier et photos d'états des lieux. Privé : ces documents ne
  // sont jamais servis en accès direct, toujours via une URL signée côté app.
  buckets: {
    uploads: { access: "private" },
  },

  functions: {
    api: { name: "api", source: "./hello.ts" },
  },

  branch: (branch) => {
    // `production` porte les données réelles. `protected: true` serait la bonne
    // valeur ici, mais le plan gratuit n'autorise aucune branche protégée
    // (HTTP 422 au deploy). À réactiver au passage sur un plan payant.
    if (branch.isDefault) {
      return {};
    }
    // Branches déjà créées : jamais reconciliées au passage d'un deploy.
    if (branch.exists) {
      return {};
    }
    // `dev` est l'environnement de travail quotidien : permanent, donc sans TTL.
    // Les reglages de compute (autoscaling, suspendTimeout) sont refuses par le
    // plan gratuit : laisses aux defauts du projet.
    if (branch.name === "dev") {
      return {};
    }
    // Tout le reste (revue de PR, essai) est jetable et expire seul.
    return { ttl: "7d" };
  },
});
