import type { Metadata } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";

// Charte Secutop : Rubik partout, aucune police secondaire. Chargée par
// next/font, donc servie depuis notre domaine — jamais depuis le CDN Google.
const rubik = Rubik({
  variable: "--font-rubik",
  subsets: ["latin"],
  fallback: [
    "Helvetica",
    "Arial",
    "DejaVu Sans",
    "Liberation Sans",
    "FreeSans",
    "sans-serif",
  ],
});

export const metadata: Metadata = {
  // Gabarit : chaque page ajoute son nom devant celui du centre.
  title: {
    default: "Centre d'affaires",
    template: "%s · Centre d'affaires",
  },
  description:
    "Gestion des ressources, réservations et contrats du centre d'affaires.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="fr"
      className={`${rubik.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
