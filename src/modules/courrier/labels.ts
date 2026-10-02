import type { OpeningOrigin } from './regles.ts'
import type {
  MailKind,
  MailRequestKind,
  MailRequestStatus,
  MailScanSide,
  MailStatus,
} from './schema.ts'

/** Libellés d'affichage, séparés des valeurs stockées. */
export const mailKindLabels: Record<MailKind, string> = {
  lettre: 'Lettre',
  recommande: 'Recommandé',
  colis: 'Colis',
  autre: 'Autre',
}

/** Vu du centre : ce qu'il reste à faire. */
export const mailStatusLabels: Record<MailStatus, string> = {
  received: 'Fermé',
  opening_requested: 'Ouverture demandée',
  opened: 'Ouvert et numérisé',
}

/** Vu du client : ce qu'il peut attendre. */
export const mailStatusClientLabels: Record<MailStatus, string> = {
  received: 'Reçu, non ouvert',
  opening_requested: 'Ouverture demandée',
  opened: 'Numérisé',
}

/**
 * Progression portée par les bleus de marque, comme les réservations (ADR 004) :
 * gris tant que rien n'est demandé, aplat clair quand une action est attendue,
 * bleu foncé plein une fois le pli numérisé. Toujours accompagnée du libellé.
 */
export const mailStatusStyles: Record<MailStatus, string> = {
  received: 'bg-muted text-muted-foreground',
  opening_requested: 'bg-accent/15 text-primary',
  opened: 'bg-primary text-primary-foreground',
}

export const mailScanSideLabels: Record<MailScanSide, string> = {
  envelope: 'Enveloppe',
  content: 'Contenu',
}

export const openingOriginLabels: Record<OpeningOrigin, string> = {
  client: 'Demande du client',
  centre: 'Initiative du centre',
}

/* -------------------------------------------------------------------------- */
/* Demandes sur un pli (R21, R24, ADR 037)                                    */
/* -------------------------------------------------------------------------- */

/** Nature d'une demande, vue du centre comme du client. */
export const mailRequestKindLabels: Record<MailRequestKind, string> = {
  open_and_scan: 'Ouverture et numérisation',
  scan: 'Numérisation',
  forward: 'Réexpédition',
}

/** Vu du centre : où en est le traitement. */
export const mailRequestStatusLabels: Record<MailRequestStatus, string> = {
  requested: 'À traiter',
  in_progress: 'En cours',
  done: 'Faite',
  refused: 'Refusée',
  cancelled: 'Annulée',
}

/** Vu du client : ce qu'il peut attendre. */
export const mailRequestStatusClientLabels: Record<MailRequestStatus, string> = {
  requested: 'Envoyée au centre',
  in_progress: 'En cours de traitement',
  done: 'Faite',
  refused: 'Refusée par le centre',
  cancelled: 'Annulée',
}

/**
 * Mêmes bleus que l'état des plis (ADR 004) : aplat clair tant que le centre
 * doit agir, bleu foncé plein une fois faite, gris pour ce qui n'aura pas lieu.
 * Toujours accompagné du libellé et d'une icône.
 */
export const mailRequestStatusStyles: Record<MailRequestStatus, string> = {
  requested: 'bg-accent/15 text-primary',
  in_progress: 'bg-accent/15 text-primary',
  done: 'bg-primary text-primary-foreground',
  refused: 'bg-muted text-foreground',
  cancelled: 'bg-muted text-muted-foreground',
}
