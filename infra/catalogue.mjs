/**
 * Catalogue du centre : ressources réelles, horaires d'ouverture et grille
 * tarifaire publique.
 *
 *   node --env-file=.env.local infra/catalogue.mjs
 *
 * À ne pas confondre avec `seed-demo.mjs`, qui pose un jeu fictif pour le
 * développement local. Ici, ce sont les données de configuration du centre :
 * elles ont vocation à être écrites sur la base de production, une fois, puis
 * entretenues depuis le back-office. Aucune donnée personnelle — rien que le
 * parc et les prix affichés publiquement.
 *
 * Le script est idempotent : il peut être relancé après une correction des
 * tableaux ci-dessous sans créer de doublon. Il ne supprime jamais une
 * ressource ; retirer un bureau du parc se fait à l'écran, avec le statut
 * `retired` qui préserve l'historique des réservations (décision 6).
 *
 * Il se connecte avec le rôle applicatif, donc sous les politiques d'isolation
 * par centre.
 */
import postgres from 'postgres'

const DEFAULT_TENANT_ID = '01999f00-0000-7000-8000-000000000001'

// ---------------------------------------------------------------------------
// Ressources
// ---------------------------------------------------------------------------

/** Les deux salles de réunion, telles qu'elles sont annoncées publiquement. */
const SALLES = [
  {
    code: 'SAL-MB',
    nom: 'Salle Mont Blanc',
    description: 'Salle de réunion, formation ou séminaire. Aménageable.',
    capacite: 14,
    attributs: { superficieM2: 30 },
  },
  {
    code: 'SAL-AE',
    nom: 'Salle Albert Einstein',
    description: 'Salle de réunion, formation ou séminaire. Aménageable.',
    capacite: 16,
    // Superficie non publiée. Mieux vaut un champ absent qu'un chiffre inventé :
    // `describeAttributes()` ignore ce qui manque.
    attributs: {},
  },
]

/**
 * Les neuf bureaux.
 *
 * `flex: true` ouvre le bureau à la réservation au poste : le script crée alors
 * une ressource par poste (« BUR-03-P1 », « BUR-03-P2 »). Ce n'est pas une
 * coquetterie de modélisation. La contrainte d'exclusion `bookings_no_overlap`
 * interdit deux réservations qui se chevauchent sur un même `resource_id` : un
 * bureau partagé déclaré comme une seule ressource verrait sa deuxième
 * réservation rejetée par la base. Une ressource = une chose réservable seule.
 *
 * Postes et superficies ne sont pas publiés : à compléter avec le plan du
 * centre. Un bureau marqué `flex` sans `postes` arrête le script plutôt que de
 * deviner.
 */
const BUREAUX = [
  { code: 'BUR-01', nom: 'Bureau 1', postes: null, flex: false },
  { code: 'BUR-02', nom: 'Bureau 2', postes: null, flex: false },
  { code: 'BUR-03', nom: 'Bureau 3', postes: null, flex: false },
  { code: 'BUR-04', nom: 'Bureau 4', postes: null, flex: false },
  { code: 'BUR-05', nom: 'Bureau 5', postes: null, flex: false },
  { code: 'BUR-06', nom: 'Bureau 6', postes: null, flex: false },
  { code: 'BUR-07', nom: 'Bureau 7', postes: null, flex: false },
  { code: 'BUR-08', nom: 'Bureau 8', postes: null, flex: false },
  { code: 'BUR-09', nom: 'Bureau 9', postes: null, flex: false },
]

/**
 * Boîtes aux lettres de domiciliation. Le site annonce « une quarantaine » ;
 * le nombre exact se corrige ici.
 */
const NOMBRE_DE_BOITES = 40

/** Développe les bureaux en ressources réservables. */
function ressourcesBureaux() {
  return BUREAUX.flatMap((bureau) => {
    const attributs = bureau.postes === null ? {} : { postes: bureau.postes }

    if (!bureau.flex) {
      return [
        {
          type: 'bureau',
          code: bureau.code,
          nom: bureau.nom,
          description: 'Bureau équipé, loué entier.',
          capacite: bureau.postes,
          attributs,
        },
      ]
    }

    if (!bureau.postes) {
      throw new Error(
        `${bureau.code} est marqué « flex » sans nombre de postes : impossible de savoir ` +
          'combien de ressources créer. Renseigner `postes` dans infra/catalogue.mjs.',
      )
    }

    return Array.from({ length: bureau.postes }, (_, index) => ({
      type: 'bureau',
      code: `${bureau.code}-P${index + 1}`,
      nom: `${bureau.nom} — poste ${index + 1}`,
      description: 'Poste en flex office, réservable à la demi-journée.',
      capacite: 1,
      attributs: { postes: 1 },
    }))
  })
}

function catalogue() {
  return [
    ...SALLES.map((salle) => ({ type: 'salle', ...salle })),
    ...ressourcesBureaux(),
    ...Array.from({ length: NOMBRE_DE_BOITES }, (_, index) => {
      const numero = String(index + 1).padStart(2, '0')
      return {
        type: 'boite_aux_lettres',
        code: `BAL-${numero}`,
        nom: `Boîte aux lettres ${numero}`,
        description: 'Domiciliation.',
        capacite: null,
        attributs: {},
      }
    }),
  ]
}

// ---------------------------------------------------------------------------
// Horaires
// ---------------------------------------------------------------------------

/**
 * Ouverture du lundi au samedi, 8h à 22h. Remplace les 9h-18h du lundi au
 * vendredi posés par défaut à la migration 0011.
 *
 * Ce sont les horaires du centre entier (`resource_id` nul). Une ressource qui
 * ouvre autrement se règle à l'écran, ligne par ligne.
 */
const JOURS_OUVERTS = [1, 2, 3, 4, 5, 6]
const OUVERTURE = '08:00'
const FERMETURE = '22:00'

// ---------------------------------------------------------------------------
// Tarifs
// ---------------------------------------------------------------------------

/**
 * Grille publique, en centimes et hors taxes (décision 5, et la TVA n'est pas
 * encore modélisée — voir ADR 006).
 *
 * `resourceId` nul : le prix vaut pour tout le type. Une salle plus chère que
 * l'autre demanderait une ligne nominative, qui l'emporte (`resolveRate()`).
 * Les deux salles sont au même prix, une ligne par unité suffit.
 */
const GRILLE = 'Tarifs publics 2026'
const TARIFS = [
  { type: 'salle', unite: 'half_day', centimes: 9_000 },
  { type: 'salle', unite: 'day', centimes: 13_000 },
  // « À partir de 7 € HT le poste par demi-journée » : c'est un prix plancher,
  // ce qui est exactement ce qu'un tarif de type veut dire ici.
  { type: 'bureau', unite: 'half_day', centimes: 700 },
  { type: 'boite_aux_lettres', unite: 'month', centimes: 3_000 },
]

// ---------------------------------------------------------------------------

const url = process.env.APP_DATABASE_URL
if (!url) {
  console.error(
    'APP_DATABASE_URL manquant. Lancer `node infra/provision-role-applicatif.mjs` au préalable.',
  )
  process.exit(1)
}

const sql = postgres(url, { prepare: false })

/** Ouvre une transaction dans le contexte du centre, comme `withTenant()`. */
const inTenant = (run) =>
  sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${DEFAULT_TENANT_ID}, true)`
    return run(tx)
  })

try {
  const ressources = catalogue()

  const compteurs = await inTenant(async (tx) => {
    let creees = 0

    for (const { type, code, nom, description, capacite, attributs } of ressources) {
      // Le code identifie la ressource dans le centre. Relancer le script après
      // un renommage met à jour la ligne existante au lieu d'en créer une
      // seconde ; les réservations déjà posées la suivent.
      const [row] = await tx`
        insert into resources (resource_type, code, name, description, capacity, attributes)
        values (${type}, ${code}, ${nom}, ${description}, ${capacite}, ${tx.json(attributs)})
        on conflict (tenant_id, code) where deleted_at is null
        do update set resource_type = excluded.resource_type,
                      name = excluded.name,
                      description = excluded.description,
                      capacity = excluded.capacity,
                      attributes = excluded.attributes
        returning (xmax = 0) as inseree`
      if (row.inseree) creees += 1
    }

    // Les horaires du centre sont remplacés en bloc : une ligne oubliée du jeu
    // précédent laisserait le samedi fermé sans que rien ne le signale.
    await tx`delete from opening_hours where resource_id is null`
    for (const jour of JOURS_OUVERTS) {
      await tx`
        insert into opening_hours (resource_id, weekday, opens_at, closes_at)
        values (null, ${jour}, ${OUVERTURE}, ${FERMETURE})`
    }

    const [creee] = await tx`
      insert into rate_plans (name, is_default)
      select ${GRILLE}, true
      where not exists (
        select 1 from rate_plans where is_default and deleted_at is null
      )
      returning id`

    const [grille] = creee
      ? [creee]
      : await tx`select id from rate_plans where is_default and deleted_at is null`

    for (const { type, unite, centimes } of TARIFS) {
      await tx`
        insert into rate_plan_items (rate_plan_id, resource_type, resource_id, unit, amount_cents)
        values (${grille.id}, ${type}, null, ${unite}, ${centimes})
        on conflict (rate_plan_id, resource_type, unit) where resource_id is null
        do update set amount_cents = excluded.amount_cents`
    }

    return { creees, total: ressources.length }
  })

  console.log(
    `${compteurs.total} ressources au catalogue (${compteurs.creees} créées, ` +
      `${compteurs.total - compteurs.creees} mises à jour).`,
  )
  console.log(`Ouverture : ${JOURS_OUVERTS.length} jours par semaine, ${OUVERTURE}–${FERMETURE}.`)
  console.log(`Grille « ${GRILLE} » : ${TARIFS.length} lignes.`)
} finally {
  await sql.end()
}
