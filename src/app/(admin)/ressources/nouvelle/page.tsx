import Link from 'next/link'

import { ResourceForm } from '../../../../modules/ressources/resource-form.tsx'

export const metadata = { title: 'Nouvelle ressource' }

export default function NewResourcePage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/ressources"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← Ressources
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle ressource</h1>
      </div>
      <ResourceForm />
    </div>
  )
}
