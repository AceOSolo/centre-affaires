/**
 * Les flux qu'un centre échange avec son CRM (ADR 065).
 *
 * Module pur, sans base ni Next : le schéma (`schema.ts`), l'écran et les
 * routes `/api/<crm>/*` en tirent les mêmes listes, et les composants client
 * peuvent l'importer.
 *
 * Un flux est un échange métier, pas une route : les devis tiennent en trois
 * routes de l'API Dolibarr, les produits en une. Le sens est celui des données
 * (« du site vers le CRM »), pas celui de l'appel : les devis partent vers le
 * CRM, mais c'est le CRM qui vient les chercher (ADR 043).
 */

/**
 * Identifiants techniques, en anglais comme les autres valeurs de la base.
 * L'ordre est celui de l'écran. Les trois derniers sont la seconde tranche de
 * la passerelle (ADR 046 § 5, ADR 066) : coupés tant que la direction ne les
 * ouvre pas à l'écran, une fois le connecteur du CRM prêt.
 */
export const crmFlows = ['quotes', 'products', 'third_parties', 'contracts', 'consumptions'] as const
export type CrmFlowId = (typeof crmFlows)[number]

/** Sens des données : du site vers le CRM, ou du CRM vers le site. */
export type CrmFlowDirection = 'to_crm' | 'from_crm'

export type CrmFlowDefinition = {
  label: string
  /** Ce que le flux transporte, pour l'écran. */
  description: string
  direction: CrmFlowDirection
  /**
   * Activé tant que le centre n'a rien réglé. Vrai pour les flux qui
   * tournaient déjà avant l'écran (devis, produits) : la production ne doit
   * pas s'arrêter à la mise en ligne. Faux pour tout flux nouveau : il ne
   * s'ouvre qu'une fois le CRM prêt à le servir.
   */
  enabledByDefault: boolean
}

export const crmFlowDefinitions: Record<CrmFlowId, CrmFlowDefinition> = {
  quotes: {
    label: 'Devis',
    description: 'Les devis prêts, que le CRM vient chercher, puis leur reprise, leur issue et leur annulation.',
    direction: 'to_crm',
    enabledByDefault: true,
  },
  products: {
    label: 'Produits et tarifs',
    description: 'Les services du catalogue et les prix de la grille par défaut, envoyés par le CRM.',
    direction: 'from_crm',
    enabledByDefault: true,
  },
  third_parties: {
    label: 'Tiers',
    description:
      'Les entreprises clientes et leurs contacts, tenus dans le CRM : le site crée ou rapproche ses fiches (même SIRET), et reprend raison sociale, coordonnées et statut.',
    direction: 'from_crm',
    enabledByDefault: false,
  },
  contracts: {
    label: 'Contrats',
    description:
      'Les contrats du CRM : qui occupe quel bureau ou quelle boîte aux lettres, qui est domicilié, du … au …. L’occupation suit au planning.',
    direction: 'from_crm',
    enabledByDefault: false,
  },
  consumptions: {
    label: 'Consommations facturables',
    description:
      'Ce que le centre a fait pour ses clients, que le CRM facture : réservations sans devis (salles, bureaux, camion, matériel…), ouvertures, numérisations, réexpéditions et pages en plus du courrier. Le site ne facture rien.',
    direction: 'to_crm',
    enabledByDefault: false,
  },
}

export const crmFlowDirectionLabels: Record<CrmFlowDirection, string> = {
  to_crm: 'Du site vers le CRM',
  from_crm: 'Du CRM vers le site',
}

export function isCrmFlow(value: unknown): value is CrmFlowId {
  return typeof value === 'string' && (crmFlows as readonly string[]).includes(value)
}

/** Les flux ouverts quand le centre n'a rien réglé. */
export const defaultEnabledFlows: readonly CrmFlowId[] = crmFlows.filter(
  (flow) => crmFlowDefinitions[flow].enabledByDefault,
)

/**
 * Flux enregistrés pour un centre, relus depuis la base : une valeur inconnue
 * (flux retiré du code) est ignorée, l'ordre est celui du catalogue. Sans
 * réglage, les flux ouverts par défaut.
 */
export function readEnabledFlows(stored: unknown): CrmFlowId[] {
  if (!Array.isArray(stored)) return [...defaultEnabledFlows]
  return crmFlows.filter((flow) => stored.includes(flow))
}
