import { BuildingIcon, GlobeIcon, UsersIcon } from '../../components/ui/icons.tsx'
import type { BookingChannel } from './schema.ts'

/**
 * Canal d'une réservation (R05, ADR 018) : par où elle est arrivée.
 *
 * Toujours affiché en texte et en icône ensemble, jamais par la couleur ni par
 * l'icône seule (`CLAUDE.md`).
 */
export const bookingChannelLabels: Record<BookingChannel, string> = {
  staff: 'Accueil',
  client: 'Espace client',
  public: 'Page publique',
}

/** Précision affichée à côté du libellé, sur la fiche. */
export const bookingChannelDescriptions: Record<BookingChannel, string> = {
  staff: 'saisie par l’équipe du centre',
  client: 'déposée par le client depuis son espace',
  public: 'demandée depuis la page publique, sans compte',
}

const channelIcons: Record<BookingChannel, typeof BuildingIcon> = {
  staff: BuildingIcon,
  client: UsersIcon,
  public: GlobeIcon,
}

export function ChannelLabel({
  channel,
  detailed = false,
}: {
  channel: BookingChannel
  /** Ajoute la précision : « Accueil — saisie par l'équipe du centre ». */
  detailed?: boolean
}) {
  const Icon = channelIcons[channel]
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={16} className="shrink-0 text-primary" />
      <span>
        {bookingChannelLabels[channel]}
        {detailed && (
          <span className="text-muted-foreground"> — {bookingChannelDescriptions[channel]}</span>
        )}
      </span>
    </span>
  )
}
