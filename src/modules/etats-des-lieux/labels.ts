import type {
  InspectionConditionLevel,
  InspectionFieldType,
  InspectionKind,
} from './schema.ts'

/**
 * Libellés des états des lieux (R06, ADR 039). Séparés des valeurs stockées :
 * celles-ci sont des identifiants de base, le vocabulaire du centre peut
 * changer sans elles.
 *
 * Module sans dépendance : les composants client l'importent sans tirer le
 * schéma Drizzle.
 */

export const inspectionKindLabels: Record<InspectionKind, string> = {
  entry: 'Entrée',
  exit: 'Sortie',
}

export const inspectionKindTitles: Record<InspectionKind, string> = {
  entry: 'État des lieux d’entrée',
  exit: 'État des lieux de sortie',
}

/**
 * Échelle de la note d'état, du meilleur au pire : l'ordre des clés est celui
 * de `inspection_condition_levels()` (migration 0039), vérifié par
 * `labels.test.ts`. La comparaison sortie / entrée s'en sert pour dire
 * « dégradé » ou « amélioré ».
 */
export const conditionLevelLabels: Record<InspectionConditionLevel, string> = {
  neuf: 'Neuf',
  bon: 'Bon état',
  usage: 'État d’usage',
  mauvais: 'Mauvais état',
}

export const conditionLevelOrder = Object.keys(conditionLevelLabels) as InspectionConditionLevel[]

export const fieldTypeLabels: Record<InspectionFieldType, string> = {
  text: 'Texte libre',
  number: 'Nombre',
  choice: 'Choix dans une liste',
  checkbox: 'Oui ou non',
  condition: 'Note d’état (neuf, bon, usage, mauvais)',
}

export const fieldTypeOrder = Object.keys(fieldTypeLabels) as InspectionFieldType[]

/**
 * État d'un état des lieux tel que l'équipe et le client le lisent : la
 * validation du client n'est pas un statut en base, mais une date.
 */
export type InspectionStage = 'draft' | 'to_sign' | 'signed' | 'withdrawn'

export function inspectionStage(inspection: {
  status: 'draft' | 'closed'
  signedAt: Date | string | null
  deletedAt: Date | string | null
}): InspectionStage {
  if (inspection.deletedAt) return 'withdrawn'
  if (inspection.status === 'draft') return 'draft'
  return inspection.signedAt ? 'signed' : 'to_sign'
}

export const inspectionStageLabels: Record<InspectionStage, string> = {
  draft: 'En saisie',
  to_sign: 'Clos — à valider par le client',
  signed: 'Validé par le client',
  withdrawn: 'Brouillon retiré',
}

/** Dans l'espace client, l'état clos non validé appelle une action. */
export const inspectionStageClientLabels: Record<Exclude<InspectionStage, 'draft' | 'withdrawn'>, string> = {
  to_sign: 'À valider',
  signed: 'Validé',
}

/**
 * Pastilles d'état, sur les bleus de la charte : un état des lieux à valider
 * n'est pas une erreur. Le libellé porte toujours le sens, la couleur ne fait
 * que le souligner (`CLAUDE.md`).
 */
export const inspectionStageStyles: Record<InspectionStage, string> = {
  draft: 'border border-border bg-white text-foreground',
  to_sign: 'border border-primary bg-white text-primary',
  signed: 'bg-primary text-primary-foreground',
  withdrawn: 'bg-muted text-muted-foreground',
}
