import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serveur autonome dans `.next/standalone` : le code et les seules
  // dépendances qu'il utilise, pour l'image Docker du VPS de production (ADR 013).
  output: "standalone",
  experimental: {
    // Numérisations de courrier : jusqu'à deux fois 10 Mo par envoi,
    // enveloppe et contenu — un fichier, ou des photos réunies en PDF
    // (ADR 055) —, plus l'habillage multipart (ADR 015). Les deux
    // limites vont ensemble : `proxy.ts` couvre `/courrier`, et au-delà de la
    // sienne il tronquerait le corps sans erreur.
    serverActions: { bodySizeLimit: "21mb" },
    proxyClientMaxBodySize: "21mb",
  },
  // Ne pas annoncer la technique du serveur à qui sonde le site.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Aucune page ne s'affiche dans le cadre d'un autre site : un faux
          // site ne peut pas faire cliquer un client connecté à son insu.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Les adresses des pages (identifiants de courrier, de contrat)
          // ne partent pas vers les sites tiers.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "microphone=(), geolocation=(), browsing-topics=()" },
          // HTTPS seulement, retenu un an par le navigateur. Sans
          // `includeSubDomains` : d'autres sous-domaines du domaine ne sont
          // peut-être pas servis en HTTPS.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
