import { redirect } from 'next/navigation'

/**
 * Entrée de l'espace client : la boîte aux lettres, rubrique la plus consultée
 * par les entreprises domiciliées. Les réservations sont à côté.
 */
export default function ComptePage() {
  redirect('/compte/courrier')
}
