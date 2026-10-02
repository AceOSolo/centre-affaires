import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serveur autonome dans `.next/standalone` : le code et les seules
  // dépendances qu'il utilise, pour l'image Docker du VPS de production (ADR 013).
  output: "standalone",
  experimental: {
    // Numérisations de courrier : jusqu'à deux fichiers de 10 Mo par envoi,
    // enveloppe et contenu, plus l'habillage multipart (ADR 015). Les deux
    // limites vont ensemble : `proxy.ts` couvre `/courrier`, et au-delà de la
    // sienne il tronquerait le corps sans erreur.
    serverActions: { bodySizeLimit: "21mb" },
    proxyClientMaxBodySize: "21mb",
  },
};

export default nextConfig;
