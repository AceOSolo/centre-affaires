import { redirect } from 'next/navigation'

/**
 * Le back-office est la seule porte d'entrée tant que le portail client n'est
 * pas ouvert (tranche 4). Le planning du jour est l'écran le plus consulté par
 * l'équipe du centre.
 */
export default function RootPage() {
  redirect('/reservations')
}
