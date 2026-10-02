import type { ResourceType } from '../ressources/schema.ts'
import type { InspectionField } from './schema.ts'

/**
 * Modèles de départ, un par type de ressource (R06, ADR 039).
 *
 * Ils servent tant que le centre n'a rien publié : l'écran des modèles les
 * propose à l'exploitant, qui les ajuste avant de les publier ; et le premier
 * état des lieux d'un type sans modèle publie celui-ci tel quel, en version 1,
 * pour que l'accueil ne soit jamais bloqué.
 *
 * Les observations générales ne figurent pas dans les champs : chaque état des
 * lieux a les siennes (`inspections.observations`), quel que soit le modèle.
 *
 * Choix *à valider* par le centre, comme l'échelle de la note d'état.
 */
export type DefaultTemplate = { name: string; fields: InspectionField[] }

const cles = (required: boolean): InspectionField => ({
  id: 'cles',
  label: 'Clés et badges remis',
  type: 'number',
  unit: 'clés',
  required,
  help: 'Nombre de clés, badges et télécommandes remis au client, ou rendus par lui.',
})

const etatGeneral: InspectionField = {
  id: 'etat_general',
  label: 'État général',
  type: 'condition',
  required: true,
}

const proprete: InspectionField = {
  id: 'proprete',
  label: 'Propreté',
  type: 'choice',
  options: ['Propre', 'À nettoyer'],
  required: false,
}

export const defaultTemplates: Record<ResourceType, DefaultTemplate> = {
  vehicule: {
    name: 'État des lieux — véhicule',
    fields: [
      {
        id: 'kilometrage',
        label: 'Kilométrage',
        type: 'number',
        unit: 'km',
        required: true,
        help: 'Relevé au compteur, sans arrondi.',
      },
      {
        id: 'carburant',
        label: 'Niveau de carburant',
        type: 'choice',
        options: ['Vide', '1/4', '1/2', '3/4', 'Plein'],
        required: true,
        help: 'Pour un véhicule électrique, le niveau de charge de la batterie.',
      },
      {
        id: 'proprete_interieure',
        label: 'Propreté intérieure',
        type: 'choice',
        options: ['Propre', 'Correcte', 'Sale'],
        required: true,
      },
      {
        id: 'proprete_exterieure',
        label: 'Propreté extérieure',
        type: 'choice',
        options: ['Propre', 'Correcte', 'Sale'],
        required: true,
      },
      { id: 'carrosserie', label: 'Carrosserie', type: 'condition', required: true },
      {
        id: 'dommages',
        label: 'Dommages constatés',
        type: 'text',
        required: false,
        help: 'Rayures, chocs, impacts : emplacement et taille. Joignez une photo de chacun.',
      },
      cles(true),
      {
        id: 'papiers_a_bord',
        label: 'Papiers du véhicule à bord',
        type: 'checkbox',
        required: false,
      },
    ],
  },
  bureau: {
    name: 'État des lieux — bureau',
    fields: [
      etatGeneral,
      { id: 'murs_sols', label: 'Murs, sols et plafonds', type: 'condition', required: true },
      {
        id: 'equipements',
        label: 'Équipements',
        type: 'condition',
        required: true,
        help: 'Mobilier, éclairage, prises, chauffage et climatisation.',
      },
      {
        id: 'equipements_detail',
        label: 'Équipements présents',
        type: 'text',
        required: false,
        help: 'Inventaire : bureaux, sièges, rangements, écrans.',
      },
      cles(true),
      proprete,
    ],
  },
  salle: {
    name: 'État des lieux — salle de réunion',
    fields: [
      etatGeneral,
      {
        id: 'equipements',
        label: 'Équipements',
        type: 'condition',
        required: true,
        help: 'Écran, visioconférence, tables, chaises, tableau.',
      },
      {
        id: 'equipements_detail',
        label: 'Équipements présents',
        type: 'text',
        required: false,
      },
      cles(false),
      proprete,
    ],
  },
  casier: {
    name: 'État des lieux — casier',
    fields: [
      etatGeneral,
      { id: 'serrure', label: 'Serrure', type: 'condition', required: true },
      cles(true),
      { id: 'casier_vide', label: 'Casier vidé', type: 'checkbox', required: false },
    ],
  },
  boite_aux_lettres: {
    name: 'État des lieux — boîte aux lettres',
    fields: [
      etatGeneral,
      { id: 'serrure', label: 'Serrure', type: 'condition', required: true },
      cles(true),
      {
        id: 'etiquette',
        label: 'Étiquette au nom du client',
        type: 'checkbox',
        required: false,
      },
    ],
  },
}
