'use server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { parseQuoteDiscount, type BookingQuote } from '../facturation/devis.ts'
import { quote } from '../facturation/devis-queries.ts'

/** Ce que le formulaire de réservation affiche avant validation (R11). */
export type BookingQuotePreview =
  | { status: 'priced'; quote: BookingQuote }
  | { status: 'unpriced'; message: string }
  | { status: 'invalid'; field?: 'discountValue'; message: string }

export type BookingQuotePreviewInput = {
  resourceId: string
  date: string
  startTime: string
  endTime: string
  clientId: string
  contractId: string
  discountKind: string
  discountValue: string
}

/**
 * Devis annoncé par le formulaire de réservation du back-office, avant
 * l'envoi : la même fonction (`quote()`) que celle qui le figera à
 * l'écriture. Une action serveur s'invoque depuis n'importe quel chemin : le
 * droit est revérifié ici (ADR 008, ADR 019).
 */
export async function previewBookingQuoteAction(
  input: BookingQuotePreviewInput,
): Promise<BookingQuotePreview> {
  await requirePermission('reservations.gerer')
  if (!isUuid(input.resourceId)) return { status: 'invalid', message: 'Choisir une ressource.' }

  const timeZone = await currentTimeZone()
  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = wallClockToUtc(`${input.date}T${input.startTime}`, timeZone)
    endsAt = wallClockToUtc(`${input.date}T${input.endTime}`, timeZone)
  } catch {
    return { status: 'invalid', message: 'Date ou horaires illisibles.' }
  }

  const discount = parseQuoteDiscount(input.discountKind, input.discountValue)
  if (!discount.ok) return { status: 'invalid', field: 'discountValue', message: discount.message }

  const result = await quote({
    resourceId: input.resourceId,
    startsAt,
    endsAt,
    clientId: isUuid(input.clientId) ? input.clientId : null,
    contractId: isUuid(input.contractId) ? input.contractId : null,
    discount: discount.discount,
  })
  if (result.ok) return { status: 'priced', quote: result.quote }
  if (result.reason === 'remise-invalide' || result.reason === 'remise-excessive') {
    return { status: 'invalid', field: 'discountValue', message: result.message }
  }
  return { status: 'unpriced', message: result.message }
}
