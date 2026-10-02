import type {
  NotificationAudience,
  NotificationCategory,
  NotificationDeliveryStatus,
  NotificationEvent,
  NotificationRelatedType,
} from './schema.ts'

/**
 * Catalogue des messages (R26, ADR 038) : pour chaque événement, son nom à
 * l'écran, les variables que son modèle peut citer et son texte par défaut.
 *
 * Module pur, sans base ni Next : l'éditeur des modèles l'importe côté
 * navigateur pour l'aperçu, le moteur côté serveur pour l'envoi, et les tests
 * le vérifient seul (`catalogue.test.ts`).
 *
 * Les textes par défaut s'appliquent tant que le centre n'a pas écrit son
 * modèle : un centre neuf prévient ses clients sans rien configurer. Ils
 * préviennent, ils ne transportent pas : ni document, ni contenu de pli, ni
 * expéditeur (ADR 015).
 */

/** Une variable citable dans un modèle, sous la forme `{{nom}}`. */
export type TemplateVariable = {
  name: string
  /** Ce qu'elle contient, tel que l'éditeur le montre. */
  label: string
  /** Valeur de l'aperçu. Fictive : jamais une donnée réelle (`CLAUDE.md`, RGPD). */
  example: string
  /**
   * Peut manquer : un lien quand l'adresse de l'application n'est pas
   * configurée, un motif que l'équipe n'a pas saisi. La ligne du corps qui la
   * cite n'est alors pas envoyée.
   */
  optional?: boolean
}

/** Variables communes, réutilisées d'un événement à l'autre. */
const centre: TemplateVariable = { name: 'centre', label: 'Nom du centre', example: 'Centre Horizon' }
const client: TemplateVariable = {
  name: 'client',
  label: 'Entreprise cliente',
  example: 'Atelier Exemple',
}
const lienEspace = (label: string): TemplateVariable => ({
  name: 'lien',
  label: `Lien vers ${label}`,
  example: 'https://centre.exemple/compte',
  optional: true,
})
const lienCentre = (label: string): TemplateVariable => ({
  name: 'lien',
  label: `Lien vers ${label} (back-office)`,
  example: 'https://centre.exemple/demandes',
  optional: true,
})
const natureCourrier: TemplateVariable = {
  name: 'nature',
  label: 'Nature du pli : lettre, recommandé, colis',
  example: 'recommandé',
}
const dateCourrier: TemplateVariable = {
  name: 'date',
  label: 'Date et heure de réception du pli, à l’heure du centre',
  example: '1 oct. 2026 à 09:30',
}
const demandeCourrier: TemplateVariable = {
  name: 'demande',
  label: 'Nature de la demande : ouverture et numérisation, numérisation, réexpédition',
  example: 'réexpédition',
}
const ressource: TemplateVariable = {
  name: 'ressource',
  label: 'Ressource réservée',
  example: 'Salle Atlas',
}
const creneau: TemplateVariable = {
  name: 'creneau',
  label: 'Jour et horaires, à l’heure du centre',
  example: 'lundi 5 octobre 2026, de 09:00 à 11:00',
}
const montantReservation: TemplateVariable = {
  name: 'montant',
  label: 'Montant du devis figé sur la réservation',
  example: '96,00 € TTC',
  optional: true,
}
const motif: TemplateVariable = {
  name: 'motif',
  label: 'Motif saisi par l’équipe',
  example: 'Salle fermée pour travaux ce jour-là.',
  optional: true,
}
const demandeur: TemplateVariable = {
  name: 'demandeur',
  label: 'Personne qui a fait la demande',
  example: 'Camille Martin',
}
const natureEtatDesLieux: TemplateVariable = {
  name: 'nature',
  label: 'Nature de l’état des lieux : d’entrée, de sortie',
  example: 'd’entrée',
}
const dateEtatDesLieux: TemplateVariable = {
  name: 'date',
  label: 'Date de l’état des lieux, à l’heure du centre',
  example: '2 oct. 2026 à 10:00',
}

const signature = '\n\n—\n{{centre}}'
const sansDocument = '\n\nPar confidentialité, ce message ne contient pas le document.'

/** Ce que l'éditeur montre et ce que le moteur accepte, événement par événement. */
export const eventVariables: Record<NotificationEvent, readonly TemplateVariable[]> = {
  mail_received: [centre, client, natureCourrier, dateCourrier, lienEspace('la boîte aux lettres de l’espace client')],
  mail_scanned: [centre, client, natureCourrier, dateCourrier, lienEspace('la boîte aux lettres de l’espace client')],
  mail_request_submitted: [
    centre,
    client,
    demandeCourrier,
    demandeur,
    natureCourrier,
    dateCourrier,
    lienCentre('la fiche du courrier'),
  ],
  mail_request_done: [
    centre,
    client,
    demandeCourrier,
    natureCourrier,
    dateCourrier,
    {
      name: 'suivi',
      label: 'Numéro de suivi de la réexpédition',
      example: '6A12345678901',
      optional: true,
    },
    lienEspace('la boîte aux lettres de l’espace client'),
  ],
  mail_request_refused: [
    centre,
    client,
    demandeCourrier,
    natureCourrier,
    dateCourrier,
    motif,
    lienEspace('la boîte aux lettres de l’espace client'),
  ],
  booking_request_submitted: [
    centre,
    { ...client, optional: true, label: 'Entreprise cliente, quand la demande lui est rattachée' },
    demandeur,
    ressource,
    creneau,
    { ...montantReservation, label: 'Montant annoncé au demandeur' },
    lienCentre('la file des demandes'),
  ],
  booking_request_accepted: [centre, client, ressource, creneau, montantReservation, lienEspace('« Mes réservations »')],
  booking_request_refused: [centre, client, ressource, creneau, motif, lienEspace('« Mes réservations »')],
  booking_confirmed: [centre, client, ressource, creneau, montantReservation, lienEspace('« Mes réservations »')],
  booking_cancelled: [centre, client, ressource, creneau, motif, lienEspace('« Mes réservations »')],
  invoice_issued: [
    centre,
    client,
    { name: 'document', label: 'Nature du document : facture, avoir', example: 'facture' },
    { name: 'numero', label: 'Numéro de la facture ou de l’avoir', example: 'FA-2026-0042' },
    { name: 'montant', label: 'Montant TTC', example: '1 260,00 €' },
    { name: 'date', label: 'Date d’émission', example: '01/10/2026' },
    { name: 'echeance', label: 'Date d’échéance', example: '31/10/2026', optional: true },
    lienEspace('« Mes factures » de l’espace client'),
  ],
  invoice_reminder: [
    centre,
    client,
    { name: 'numero', label: 'Numéro de la facture relancée', example: 'FA-2026-0042' },
    { name: 'montant', label: 'Reste dû', example: '1 260,00 €' },
    { name: 'echeance', label: 'Date d’échéance dépassée', example: '31/10/2026' },
    {
      name: 'objet',
      label: 'Objet de la relance, selon son palier',
      example: 'Relance — facture FA-2026-0042 échue le 31/10/2026',
    },
    {
      name: 'lettre',
      label: 'Texte complet de la relance : palier, reste dû, coordonnées bancaires, mentions légales',
      example:
        'Madame, Monsieur,\n\nSauf erreur de notre part, la facture FA-2026-0042, échue le 31/10/2026, reste impayée…',
    },
  ],
  contract_activated: [
    centre,
    client,
    { name: 'reference', label: 'Référence du contrat', example: 'CT-2026-0007' },
    { name: 'debut', label: 'Date de prise d’effet', example: '01/11/2026' },
    { name: 'ressource', label: 'Ressource du contrat', example: 'Bureau 12', optional: true },
    lienEspace('l’espace client'),
  ],
  inspection_to_sign: [
    centre,
    client,
    natureEtatDesLieux,
    { ...ressource, label: 'Ressource inspectée' },
    dateEtatDesLieux,
    lienEspace('l’état des lieux dans l’espace client'),
  ],
  inspection_signed: [
    centre,
    client,
    natureEtatDesLieux,
    { ...ressource, label: 'Ressource inspectée' },
    dateEtatDesLieux,
    { name: 'signataire', label: 'Personne qui a validé', example: 'Camille Martin' },
    {
      name: 'remarques',
      label: 'Mention des remarques du client, sans leur texte',
      example: 'Le client a ajouté des remarques.',
      optional: true,
    },
    lienCentre('l’état des lieux'),
  ],
  member_invited: [
    centre,
    client,
    { name: 'adresse', label: 'Adresse de la personne invitée', example: 'camille@exemple.fr' },
    { ...lienEspace('la page de connexion'), example: 'https://centre.exemple/auth/connexion' },
  ],
  offer_requested: [
    centre,
    client,
    { name: 'offre', label: 'Offre demandée', example: 'Domiciliation et bureau à la journée' },
    demandeur,
    { name: 'message', label: 'Message du client', example: 'Disponible à partir de novembre ?', optional: true },
    lienCentre('la fiche du client'),
  ],
}

export type DefaultTemplate = { subject: string; body: string }

/**
 * Textes par défaut. *À valider par le centre* (ADR 038) : ils reprennent ceux
 * de l'ADR 015 pour le courrier et l'invitation.
 */
export const defaultTemplates: Record<NotificationEvent, DefaultTemplate> = {
  mail_received: {
    subject: 'Nouveau courrier pour {{client}}',
    body:
      'Bonjour,\n\nUn courrier ({{nature}}) est arrivé au centre pour {{client}}, le {{date}}.\n\n' +
      'Vous pouvez le voir dans votre espace client et, si vous le souhaitez, en demander l’ouverture et la numérisation.' +
      '\n\nVotre boîte aux lettres : {{lien}}' +
      sansDocument +
      signature,
  },
  mail_scanned: {
    subject: 'Votre courrier a été numérisé — {{client}}',
    body:
      'Bonjour,\n\nLe courrier ({{nature}}) reçu le {{date}} pour {{client}} a été ouvert et numérisé. ' +
      'Vous pouvez le lire dans votre espace client.' +
      '\n\nVotre boîte aux lettres : {{lien}}' +
      sansDocument +
      signature,
  },
  mail_request_submitted: {
    subject: 'Demande de courrier ({{demande}}) — {{client}}',
    body:
      '{{demandeur}} demande pour {{client}} : {{demande}} du courrier ({{nature}}) reçu le {{date}}.' +
      '\n\nTraiter la demande : {{lien}}' +
      signature,
  },
  mail_request_done: {
    subject: 'Demande de courrier traitée ({{demande}}) — {{client}}',
    body:
      'Bonjour,\n\nVotre demande ({{demande}}) pour le courrier ({{nature}}) reçu le {{date}} a été traitée.' +
      '\n\nNuméro de suivi : {{suivi}}' +
      '\n\nLe détail est dans votre espace client : {{lien}}' +
      sansDocument +
      signature,
  },
  mail_request_refused: {
    subject: 'Demande de courrier non traitée ({{demande}}) — {{client}}',
    body:
      'Bonjour,\n\nVotre demande ({{demande}}) pour le courrier ({{nature}}) reçu le {{date}} n’a pas pu être traitée.' +
      '\n\nMotif : {{motif}}' +
      '\n\nVotre boîte aux lettres : {{lien}}' +
      signature,
  },
  booking_request_submitted: {
    subject: 'Demande de réservation — {{ressource}}, {{creneau}}',
    body:
      '{{demandeur}} demande à réserver {{ressource}} le {{creneau}}.' +
      '\n\nEntreprise : {{client}}' +
      '\nMontant annoncé : {{montant}}' +
      '\n\nValider ou refuser la demande : {{lien}}' +
      signature,
  },
  booking_request_accepted: {
    subject: 'Réservation confirmée — {{ressource}}, {{creneau}}',
    body:
      'Bonjour,\n\nVotre demande de réservation de {{ressource}} le {{creneau}} est acceptée : la réservation est confirmée.' +
      '\n\nMontant : {{montant}}' +
      '\n\nVos réservations : {{lien}}' +
      signature,
  },
  booking_request_refused: {
    subject: 'Demande de réservation non retenue — {{ressource}}, {{creneau}}',
    body:
      'Bonjour,\n\nVotre demande de réservation de {{ressource}} le {{creneau}} n’a pas pu être acceptée : le créneau est libéré.' +
      '\n\nMotif : {{motif}}' +
      '\n\nVos réservations : {{lien}}' +
      signature,
  },
  booking_confirmed: {
    subject: 'Réservation confirmée — {{ressource}}, {{creneau}}',
    body:
      'Bonjour,\n\nLa réservation de {{ressource}} le {{creneau}} pour {{client}} est confirmée.' +
      '\n\nMontant : {{montant}}' +
      '\n\nVos réservations : {{lien}}' +
      signature,
  },
  booking_cancelled: {
    subject: 'Réservation annulée — {{ressource}}, {{creneau}}',
    body:
      'Bonjour,\n\nLa réservation de {{ressource}} le {{creneau}} pour {{client}} est annulée.' +
      '\n\nMotif : {{motif}}' +
      '\n\nVos réservations : {{lien}}' +
      signature,
  },
  invoice_issued: {
    subject: 'Votre {{document}} {{numero}} — {{centre}}',
    body:
      'Bonjour,\n\nVotre {{document}} {{numero}} du {{date}} est disponible dans votre espace client.' +
      '\n\nMontant TTC : {{montant}}' +
      '\nÉchéance : {{echeance}}' +
      '\n\nVos factures : {{lien}}' +
      '\n\nPar confidentialité, ce message ne contient pas le document : il reste consultable dans votre espace.' +
      signature,
  },
  invoice_reminder: {
    // La lettre est celle qui s'affiche, s'imprime et s'inscrit au journal des
    // relances (ADR 030, ADR 034) : le modèle l'entoure, il ne la réécrit pas.
    subject: '{{objet}}',
    body: '{{lettre}}',
  },
  contract_activated: {
    subject: 'Votre contrat {{reference}} est en vigueur — {{centre}}',
    body:
      'Bonjour,\n\nLe contrat {{reference}} de {{client}} est activé. Il prend effet le {{debut}}.' +
      '\n\nRessource : {{ressource}}' +
      '\n\nVotre espace client : {{lien}}' +
      signature,
  },
  inspection_to_sign: {
    subject: 'État des lieux à valider — {{ressource}}',
    body:
      'Bonjour,\n\nL’état des lieux {{nature}} de {{ressource}}, fait le {{date}}, est disponible dans votre espace client. ' +
      'Merci de le relire et de le valider, en ajoutant vos remarques si besoin.' +
      '\n\nValider l’état des lieux : {{lien}}' +
      '\n\nPar confidentialité, ce message ne contient ni le document ni ses photos.' +
      signature,
  },
  inspection_signed: {
    subject: 'État des lieux validé — {{client}}, {{ressource}}',
    body:
      '{{signataire}} a validé pour {{client}} l’état des lieux {{nature}} de {{ressource}}, fait le {{date}}.' +
      '\n\n{{remarques}}' +
      '\n\nVoir l’état des lieux : {{lien}}' +
      signature,
  },
  member_invited: {
    subject: 'Votre espace client {{centre}}',
    body:
      'Bonjour,\n\n{{centre}} vous a ouvert un accès à l’espace client de {{client}} : le courrier reçu à son nom, et ses réservations.' +
      '\n\nPour l’activer, créez votre accès avec cette adresse ({{adresse}}) depuis la page de connexion, puis confirmez-la.' +
      '\n\n{{lien}}' +
      '\n\nSi vous n’attendiez pas ce message, ignorez-le : rien n’est ouvert tant que l’adresse n’est pas confirmée.' +
      signature,
  },
  offer_requested: {
    subject: 'Offre demandée — {{offre}}, {{client}}',
    body:
      '{{demandeur}} ({{client}}) s’intéresse à l’offre « {{offre}} » depuis son espace client.' +
      '\n\nMessage : {{message}}' +
      '\n\nFiche du client : {{lien}}' +
      signature,
  },
}

/** Nom de l'événement à l'écran. */
export const notificationEventLabels: Record<NotificationEvent, string> = {
  mail_received: 'Arrivée d’un courrier',
  mail_scanned: 'Courrier numérisé',
  mail_request_submitted: 'Demande de courrier déposée',
  mail_request_done: 'Demande de courrier traitée',
  mail_request_refused: 'Demande de courrier refusée',
  booking_request_submitted: 'Demande de réservation déposée',
  booking_request_accepted: 'Demande de réservation acceptée',
  booking_request_refused: 'Demande de réservation refusée',
  booking_confirmed: 'Réservation confirmée',
  booking_cancelled: 'Réservation annulée',
  invoice_issued: 'Facture ou avoir émis',
  invoice_reminder: 'Relance d’impayé',
  contract_activated: 'Contrat activé',
  inspection_to_sign: 'État des lieux à valider',
  inspection_signed: 'État des lieux validé par le client',
  member_invited: 'Accès à l’espace client ouvert',
  offer_requested: 'Offre demandée depuis l’espace client',
}

/** Quand le message part, et à qui : l'aide de l'écran des modèles. */
export const notificationEventDescriptions: Record<NotificationEvent, string> = {
  mail_received: 'À l’enregistrement d’un pli fermé, aux personnes de l’espace client.',
  mail_scanned: 'À l’ouverture d’un pli, ou à l’enregistrement d’un pli déjà numérisé.',
  mail_request_submitted: 'Quand un client demande l’ouverture, la numérisation ou la réexpédition d’un pli.',
  mail_request_done: 'Quand l’accueil a traité une demande de numérisation ou de réexpédition.',
  mail_request_refused: 'Quand l’accueil refuse une demande de courrier, ou que le pli est retiré.',
  booking_request_submitted: 'Quand une demande de réservation est déposée, depuis la page publique ou l’espace client.',
  booking_request_accepted: 'Quand l’équipe valide une demande de réservation d’un client.',
  booking_request_refused: 'Quand l’équipe refuse une demande de réservation d’un client.',
  booking_confirmed: 'Quand une réservation est enregistrée confirmée pour un client.',
  booking_cancelled: 'Quand l’équipe annule une réservation d’un client.',
  invoice_issued: 'À l’émission d’une facture ou d’un avoir. Le document reste dans l’espace client.',
  invoice_reminder: 'Quand l’équipe envoie une relance par courriel, aux contacts « factures » du client.',
  contract_activated: 'À l’activation d’un contrat.',
  inspection_to_sign: 'À la clôture d’un état des lieux, pour que le client le valide.',
  inspection_signed: 'Quand le client valide un état des lieux depuis son espace.',
  member_invited: 'Quand l’équipe ouvre un accès à l’espace client.',
  offer_requested: 'Quand un client demande une offre depuis son espace.',
}

export const notificationAudienceLabels: Record<NotificationAudience, string> = {
  client: 'Client',
  centre: 'Centre',
}

/** Catégories auxquelles une personne de l'espace client peut renoncer. */
export const notificationCategoryLabels: Record<NotificationCategory, string> = {
  mail: 'Courrier',
  bookings: 'Réservations',
  invoices: 'Factures',
  contracts: 'Contrats',
  inspections: 'États des lieux',
}

/** Ce que chaque catégorie couvre, dit à la personne qui règle ses préférences. */
export const notificationCategoryDescriptions: Record<NotificationCategory, string> = {
  mail: 'Arrivée d’un pli, numérisation, suite donnée à vos demandes de courrier.',
  bookings: 'Réservations confirmées ou annulées, réponse à vos demandes de réservation.',
  invoices: 'Facture ou avoir disponible dans votre espace.',
  contracts: 'Activation d’un contrat.',
  inspections: 'État des lieux à valider.',
}

export const notificationDeliveryStatusLabels: Record<NotificationDeliveryStatus, string> = {
  sent: 'Envoyé',
  failed: 'Échec',
  not_configured: 'Non envoyé : SMTP non configuré',
  skipped: 'Non envoyé',
}

export const notificationRelatedTypeLabels: Record<NotificationRelatedType, string> = {
  mail_item: 'Courrier',
  mail_request: 'Demande de courrier',
  booking: 'Réservation',
  invoice: 'Facture',
  contract: 'Contrat',
  inspection: 'État des lieux',
  client_member: 'Accès à l’espace client',
  offer: 'Offre',
}
