import { pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { purgeExpiredMailScans, purgeExpiredMailScanViews } from '../courrier/conservation.ts'
import {
  purgeExpiredInspectionPhotos,
  purgeExpiredInspectionPhotoViews,
} from '../etats-des-lieux/conservation.ts'
import { purgeExpiredNotificationDeliveries } from '../notifications/queries.ts'
import { anonymizeExpiredPublicRequests } from '../reservations/conservation.ts'
import {
  anonymizeExpiredClients,
  anonymizeRemovedMembers,
  type ExpiredClientsReport,
  type RemovedMembersReport,
} from './anonymisation.ts'
import { anonymizationLogLine } from './bilan.ts'

/**
 * Tâche de nuit de conservation (RGPD : R22, R29, R33 ; ADR 015, 020, 038,
 * 039, 040) : ce qui est arrivé au terme de sa durée est effacé ou anonymisé,
 * selon les durées du centre (`tenants`).
 *
 * Chaque étape a sa transaction et son propre filet : l'échec de l'une — le
 * stockage injoignable, une erreur de la base sur une ligne — ne retient pas
 * les autres. Le bilan garde ce qui a été fait, `null` pour une étape en
 * échec, et la liste des étapes à reprendre ; la nuit suivante les rejoue.
 *
 * Ordre : d'abord tout ce qui ne dépend que de la base, puis ce qui touche au
 * stockage, pour qu'une panne du stockage ne retarde aucune purge du journal.
 *
 * Le journal de l'application ne reçoit que des nombres et des noms d'étape :
 * jamais le détail d'une erreur de la base, qui peut citer la ligne refusée.
 */

export type NightlyConservationReport = {
  /** Coordonnées des demandeurs de la page publique effacées (ADR 020). */
  publicRequests: number | null
  /** Entreprises, contacts, accès et expéditeurs anonymisés (ADR 040). */
  anonymizedClients: ExpiredClientsReport | null
  /** Accès et membres de l'équipe retirés, anonymisés (ADR 040). */
  anonymizedMembers: RemovedMembersReport | null
  /** Messages du journal des envois purgés (ADR 038). */
  notificationDeliveries: number | null
  /** Consultations des numérisations purgées du journal d'accès (ADR 015). */
  views: number | null
  /** Consultations des photos d'états des lieux purgées (ADR 039). */
  inspectionPhotoViews: number | null
  /** Numérisations du courrier purgées, fichier compris (ADR 015, 020). */
  scans: number | null
  /** Photos d'états des lieux purgées, fichier compris (ADR 039). */
  inspectionPhotos: number | null
  /** Étapes en échec, dans l'ordre où elles ont été tentées. */
  failed: NightlyStep[]
}

export type NightlyStep = Exclude<keyof NightlyConservationReport, 'failed'>

type Logger = Pick<Console, 'info' | 'error'>

/** Le message d'une erreur, sans son détail : code SQL et première phrase. */
function errorSummary(error: unknown): string {
  const code = pgErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return code ? `${code} ${message}` : message
}

export async function runNightlyConservation(
  tenantId: string,
  removeObject: (key: string) => Promise<void>,
  log: Logger = console,
): Promise<NightlyConservationReport> {
  const report: NightlyConservationReport = {
    publicRequests: null,
    anonymizedClients: null,
    anonymizedMembers: null,
    notificationDeliveries: null,
    views: null,
    inspectionPhotoViews: null,
    scans: null,
    inspectionPhotos: null,
    failed: [],
  }

  const step = async <K extends NightlyStep>(
    name: K,
    run: (tx: Transaction) => Promise<NonNullable<NightlyConservationReport[K]>>,
  ) => {
    try {
      report[name] = (await withTenant(tenantId, run)) as NightlyConservationReport[K]
    } catch (error) {
      report.failed.push(name)
      log.error(`Conservation : l’étape « ${name} » a échoué et sera reprise la nuit prochaine (${errorSummary(error)}).`)
    }
  }

  // La base seule.
  await step('publicRequests', anonymizeExpiredPublicRequests)
  await step('anonymizedClients', anonymizeExpiredClients)
  await step('anonymizedMembers', anonymizeRemovedMembers)
  if (report.anonymizedClients && report.anonymizedMembers) {
    log.info(anonymizationLogLine(report.anonymizedClients, report.anonymizedMembers))
  }
  await step('notificationDeliveries', purgeExpiredNotificationDeliveries)
  await step('views', purgeExpiredMailScanViews)
  await step('inspectionPhotoViews', purgeExpiredInspectionPhotoViews)
  // Puis le stockage : le fichier est effacé avant que la base ne marque la
  // ligne, si bien qu'une panne laisse la ligne à reprendre.
  await step('scans', (tx) => purgeExpiredMailScans(tx, removeObject))
  await step('inspectionPhotos', (tx) => purgeExpiredInspectionPhotos(tx, removeObject))
  return report
}
