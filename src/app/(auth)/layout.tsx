import Image from 'next/image'

import { currentTenant } from '../../lib/tenant.ts'

/**
 * Rendu à chaque visite : le nom et le logo viennent de la table `tenants`,
 * modifiable hors déploiement (`infra/configurer-centre.mjs`). Prérendu, l'écran
 * figerait le centre du jour de compilation et le build exigerait une base.
 */
export const dynamic = 'force-dynamic'

/**
 * Coque des écrans d'authentification : ni la navigation du back-office, à
 * laquelle on n'a pas encore droit, ni l'en-tête commercial du site public.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted px-5 py-12">
      <div className="w-full max-w-md">
        <div className="flex justify-center">
          {tenant.logoPath ? (
            <Image
              src={tenant.logoPath}
              alt={tenant.name}
              width={600}
              height={191}
              priority
              className="h-10 w-auto"
            />
          ) : (
            <p className="text-lg font-semibold tracking-tight text-primary">{tenant.name}</p>
          )}
        </div>
        <div className="mt-6 rounded-lg border border-border bg-background p-6 sm:p-8">
          {children}
        </div>
      </div>
    </div>
  )
}
