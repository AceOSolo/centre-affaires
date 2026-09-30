import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serveur autonome dans `.next/standalone` : le code et les seules
  // dépendances qu'il utilise, pour l'image Docker du serveur OVH (ADR 013).
  output: "standalone",
};

export default nextConfig;
