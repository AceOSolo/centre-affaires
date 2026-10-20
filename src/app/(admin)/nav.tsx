'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId } from 'react'

import type { Permission } from '../../lib/auth/permissions.ts'

type Entry = {
  href: string
  label: string
  permission: Permission
  /** Compteur de file d'attente affiché à côté du libellé. */
  counter?: 'pending' | 'mail'
}

// Les entrées sont rangées par usage, pas par ordre d'arrivée des tranches :
// ce qui se traite tous les jours en haut, les réglages en bas.
// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
const groups: { label: string; entries: Entry[] }[] = [
  {
    label: 'Au quotidien',
    entries: [
      { href: '/reservations', label: 'Planning', permission: 'reservations.gerer' },
      // Les demandes du site public bloquent un créneau tant qu'elles ne sont
      // pas traitées (ADR 005) : leur nombre est affiché en permanence.
      { href: '/demandes', label: 'Demandes', permission: 'demandes.traiter', counter: 'pending' },
      // Les demandes de courrier à traiter (ouverture, numérisation,
      // réexpédition) sont comptées : c'est une file d'attente (ADR 037).
      { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer', counter: 'mail' },
      // Entrées et sorties des ressources occupées ; les modèles s'y rejoignent (ADR 039).
      { href: '/etats-des-lieux', label: 'États des lieux', permission: 'etats-des-lieux.gerer' },
    ],
  },
  {
    label: 'Commercial',
    entries: [
      { href: '/clients', label: 'Clients', permission: 'clients.gerer' },
      { href: '/contrats', label: 'Contrats', permission: 'contrats.consulter' },
      { href: '/offres', label: 'Offres', permission: 'services.gerer' },
      { href: '/services', label: 'Services', permission: 'services.gerer' },
      { href: '/tarifs', label: 'Tarifs', permission: 'tarifs.gerer' },
    ],
  },
  {
    label: 'Facturation',
    entries: [
      { href: '/factures', label: 'Factures', permission: 'facturation.consulter' },
      // Règlements et export comptable (R16, ADR 030) : l'accueil consulte, l'exploitant pointe.
      { href: '/paiements', label: 'Règlements', permission: 'facturation.consulter' },
      { href: '/comptabilite', label: 'Comptabilité', permission: 'comptabilite.exporter' },
    ],
  },
  {
    label: 'Ressources',
    entries: [
      { href: '/ressources', label: 'Ressources', permission: 'ressources.gerer' },
      { href: '/disponibilites', label: 'Disponibilités', permission: 'horaires.gerer' },
      { href: '/ressources/annonces', label: 'Annonces du site', permission: 'ressources.gerer' },
      { href: '/ressources/agendas', label: 'Agendas Google', permission: 'agenda-google.gerer' },
    ],
  },
  {
    label: 'Suivi',
    entries: [
      { href: '/indicateurs', label: 'Indicateurs', permission: 'indicateurs.consulter' },
      // Journal des messages envoyés ; les modèles s'ouvrent depuis lui (ADR 038).
      { href: '/notifications', label: 'Messages', permission: 'notifications.consulter' },
    ],
  },
  {
    label: 'Administration',
    entries: [
      { href: '/equipe', label: 'Équipe', permission: 'equipe.gerer' },
      // Comptes créés sur le site, dont les inscriptions libres (ADR 045).
      // L'accueil y rattache ; bannir est réservé à l'exploitant (`comptes.gerer`).
      { href: '/comptes', label: 'Comptes', permission: 'comptes.rattacher' },
      { href: '/configuration', label: 'Configuration', permission: 'centre.configurer' },
    ],
  },
]

/**
 * Navigation du back-office, rangée par catégories. Client parce que l'entrée
 * active dépend de l'URL courante ; le reste de la coque reste rendu sur le
 * serveur.
 */
export function Nav({
  pendingCount = 0,
  mailRequestCount = 0,
  allowed,
}: {
  pendingCount?: number
  mailRequestCount?: number
  /** Droits du membre connecté (`permissionsOf`). */
  allowed: readonly Permission[]
}) {
  const pathname = usePathname()
  // La navigation est rendue deux fois (barre latérale, menu des écrans
  // étroits) : les identifiants des titres doivent rester uniques.
  const prefix = useId()

  // Une catégorie dont aucune entrée n'est permise disparaît avec son titre.
  const visibles = groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => allowed.includes(entry.permission)),
    }))
    .filter((group) => group.entries.length > 0)

  // Le plus long chemin qui correspond l'emporte : `/ressources/annonces` ne
  // doit pas allumer aussi l'entrée `/ressources`.
  const actif = visibles
    .flatMap((group) => group.entries)
    .filter((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href

  const counts = { pending: pendingCount, mail: mailRequestCount }

  return (
    <nav aria-label="Navigation principale" className="flex flex-col gap-5">
      {visibles.map((group) => {
        const titleId = `${prefix}-${group.label.replace(/\s+/g, '-')}`
        return (
          <div key={group.label} role="group" aria-labelledby={titleId}>
            <p
              id={titleId}
              className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.entries.map((entry) => {
                const active = entry.href === actif
                const count = entry.counter ? counts[entry.counter] : 0
                return (
                  <li key={entry.href}>
                    <Link
                      href={entry.href}
                      aria-current={active ? 'page' : undefined}
                      // L'entrée active ne se lit pas qu'à la couleur : graisse
                      // et filet à gauche la distinguent aussi.
                      className={`flex items-center justify-between gap-2 rounded-sm border-l-[3px] px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                        active
                          ? 'border-primary bg-accent/10 font-semibold text-primary'
                          : 'border-transparent font-medium text-foreground/80 hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <span>{entry.label}</span>
                      {count > 0 && (
                        <span
                          className="rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular"
                          aria-label={
                            entry.counter === 'pending'
                              ? `${count} demande${count > 1 ? 's' : ''} en attente`
                              : `${count} demande${count > 1 ? 's' : ''} de courrier à traiter`
                          }
                        >
                          {count}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}
