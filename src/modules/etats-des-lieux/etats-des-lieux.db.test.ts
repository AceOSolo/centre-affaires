import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INSPECTION_INVALID,
  DB_INSPECTION_LOCKED,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { expiredInspectionPhotos } from './conservation.ts'
import {
  findInspectionForAccounts,
  findPhotoForAccounts,
  listInspectionsForAccounts,
} from './queries.ts'
import { inspectionConditionLevels, type InspectionField } from './schema.ts'

/**
 * États des lieux (R06, R33, ADR 039), éprouvés contre la base sous
 * l'identité applicative : modèles par type de ressource, versionnés ; valeurs
 * conformes au modèle ; état clos figé, validé une fois par le client ; photos
 * sous portée client, conservées jusqu'au terme fixé par le centre. MySQL ne
 * filtre pas les lectures : la portée client tient aux filtres explicites des
 * requêtes de l'espace client (`queries.ts`), éprouvés ici.
 */
describe('états des lieux', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  /** Refus de portée client : écriture hors de la vue de l'entreprise. */
  const DB_SCOPE_VIOLATION = DB_INSUFFICIENT_PRIVILEGE

  const DURAND = '01a00000-0000-7000-8000-0000000a0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000a0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000a0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000a0d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000a0e01'
  const BUREAU = '01a00000-0000-7000-8000-0000000a0b01'
  const SALLE = '01a00000-0000-7000-8000-0000000a0b02'
  const CONTRAT_DURAND = '01a00000-0000-7000-8000-0000000a0f01'
  const CONTRAT_PETIT = '01a00000-0000-7000-8000-0000000a0f02'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, bases.app.db)

  /** Les lignes d'une requête : `execute` rend `[lignes, champs]` sous mysql2. */
  const lire = async (tx: Transaction, requete: ReturnType<typeof sql>) =>
    ((await tx.execute(requete)) as unknown as [Record<string, unknown>[]])[0]

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const CHAMPS: InspectionField[] = [
    { id: 'murs', label: 'Murs', type: 'condition', required: true },
    { id: 'cles', label: 'Clés remises', type: 'number', unit: 'clés', required: true },
    { id: 'proprete', label: 'Propreté', type: 'choice', options: ['Propre', 'À nettoyer'], required: true },
    { id: 'badge', label: 'Badge remis', type: 'checkbox', required: false },
    { id: 'remarques', label: 'Remarques', type: 'text', required: false },
  ]
  const COMPLET = { murs: 'bon', cles: 2, proprete: 'Propre', badge: true }

  /** Modèle d'un type, version 1 : rend l'identifiant de la version. */
  const modele = async (type = 'bureau', fields: unknown = CHAMPS): Promise<string> => {
    const templateId = uuidv7()
    const versionId = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into inspection_templates (id, resource_type, name)
        values (${templateId}, ${type}, ${`État des lieux ${type}`})`)
      await tx.execute(sql`
        insert into inspection_template_versions (id, template_id, version, name, fields, created_by)
        values (${versionId}, ${templateId}, 1, ${`État des lieux ${type}`}, ${JSON.stringify(fields)}, ${CAMILLE})`)
    })
    return versionId
  }

  /** État des lieux en brouillon, au titre du contrat du client. */
  const etat = async (
    versionId: string,
    {
      kind = 'entry',
      client = DURAND,
      resource = BUREAU,
      entry = null as string | null,
      values = {} as Record<string, unknown>,
    } = {},
  ): Promise<string> => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into inspections (id, kind, resource_id, client_id, contract_id, entry_inspection_id,
                                 template_version_id, \`values\`, created_by)
        values (${id}, ${kind}, ${resource}, ${client}, ${client === DURAND ? CONTRAT_DURAND : CONTRAT_PETIT},
                ${entry}, ${versionId}, ${JSON.stringify(values)}, ${CAMILLE})`),
    )
    return id
  }

  const clore = (id: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        update inspections set status = 'closed', closed_by = ${CAMILLE},
               \`values\` = ${JSON.stringify(COMPLET)}
         where id = ${id}`),
    )

  let photos = 0
  const photo = async (
    inspectionId: string,
    values: { fieldId?: string; contentType?: string; byteSize?: number; width?: number | null; height?: number | null } = {},
  ) => {
    photos += 1
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into inspection_photos (id, inspection_id, storage_key, encryption_key_version, content_type,
                                       byte_size, width, height, field_id, uploaded_by)
        values (${id}, ${inspectionId}, ${`etats-des-lieux/test/${photos}.jpg`}, 1,
                ${values.contentType ?? 'image/jpeg'}, ${values.byteSize ?? 180_000},
                ${'width' in values ? values.width : 1600}, ${'height' in values ? values.height : 1200},
                ${values.fieldId ?? null}, ${CAMILLE})`),
    )
    return id
  }

  const toutVider = () =>
    viderTables(
      bases.owner,
      'inspection_photo_views',
      'inspection_photos',
      'inspections',
      'inspection_template_versions',
      'inspection_templates',
      'bookings',
      'contracts',
      'client_members',
      'clients',
      'resources',
      'staff_members',
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base globale : l'identité
    // applicative de la base de test.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider()
    await bases.owner.client.query(
      'update tenants set inspection_photo_retention_months = 36, inspection_access_log_retention_months = 12 where id = ?',
      [DEFAULT_TENANT_ID],
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${CAMILLE}, 'camille@centre.fr')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'u-paul')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'B-EDL', 'Bureau 4'), (${SALLE}, 'salle', 'S-EDL', 'Salle Europe')`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents) values
          (${CONTRAT_DURAND}, ${DURAND}, 'EDL-1', 'bureau', '2026-01-01', 90000),
          (${CONTRAT_PETIT}, ${PETIT}, 'EDL-2', 'bureau', '2026-01-01', 90000)`)
    })
  })

  after(async () => {
    await toutVider()
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('modèles', () => {
    it('refuse un modèle mal formé, en disant pourquoi', async () => {
      const invalides: unknown[] = [
        [],
        {},
        [{ id: 'Murs', label: 'Murs', type: 'text', required: true }],
        [{ id: 'murs', label: ' ', type: 'text', required: true }],
        [{ id: 'murs', label: 'Murs', type: 'photo', required: true }],
        [{ id: 'murs', label: 'Murs', type: 'text' }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, unit: 'm²' }],
        [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['Seule'] }],
        [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['A', 'A'] }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, couleur: 'bleu' }],
        [
          { id: 'murs', label: 'Murs', type: 'text', required: true },
          { id: 'murs', label: 'Murs encore', type: 'text', required: false },
        ],
      ]
      for (const fields of invalides) {
        // Un trigger (CA011) : MySQL n'accepte pas une routine dans un `check`.
        assert.equal(await codeErreur(() => modele('bureau', fields)), DB_INSPECTION_INVALID, JSON.stringify(fields))
      }
      const [message] = await asTenant((tx) =>
        lire(tx, sql`
          select inspection_fields_error('[{"id":"etat","label":"État","type":"choice","required":true,"options":["Seule"]}]') as erreur`),
      )
      assert.match(message.erreur as string, /2 à 50 options/)
      await modele()
    })

    it('connaît l’échelle de la note d’état du code', async () => {
      // La fonction SQL porte l'échelle en dur : chaque niveau du code doit
      // être accepté, et un niveau inconnu refusé.
      const champs = JSON.stringify([{ id: 'murs', label: 'Murs', type: 'condition', required: true }])
      const erreur = async (niveau: string) => {
        const [row] = await asTenant((tx) =>
          lire(
            tx,
            sql`select inspection_values_error(${champs}, ${JSON.stringify({ murs: niveau })}, 0) as erreur`,
          ),
        )
        return row.erreur
      }
      for (const niveau of inspectionConditionLevels) assert.equal(await erreur(niveau), null, niveau)
      assert.match(String(await erreur('excellent')), /note d’état|note d'état/)
    })

    it('un modèle vivant par type, lisible depuis l’espace client mais écrit par le back-office', async () => {
      await modele('bureau')
      assert.equal(await codeErreur(() => modele('bureau')), DB_UNIQUE_VIOLATION)
      const vus = await asClients([DURAND], (tx) => lire(tx, sql`select fields from inspection_template_versions`))
      assert.equal(vus.length, 1)
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`insert into inspection_templates (resource_type, name) values ('salle', 'Intrus')`),
          ),
        ),
        DB_SCOPE_VIOLATION,
      )
    })

    it('garde la version avec laquelle un état des lieux est saisi, et la fige', async () => {
      const v1 = await modele()
      const id = await etat(v1)
      const [{ template_id: templateId }] = await asTenant((tx) =>
        lire(tx, sql`select template_id from inspection_template_versions where id = ${v1}`),
      )
      await asTenant((tx) =>
        tx.execute(sql`
          insert into inspection_template_versions (template_id, version, name, fields)
          values (${templateId as string}, 2, 'État des lieux bureau',
                  '[{"id":"sol","label":"Sol","type":"condition","required":true}]')`),
      )
      const [row] = await asTenant((tx) =>
        lire(tx, sql`select template_version_id from inspections where id = ${id}`),
      )
      assert.equal(row.template_version_id, v1)
      // Les valeurs suivent sa version, pas la nouvelle.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update inspections set \`values\` = '{"sol":"bon"}' where id = ${id}`),
          ),
        ),
        DB_INSPECTION_INVALID,
      )
      // Ni la version d'un état des lieux, ni le contenu d'une version ne changent.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              update inspections set template_version_id = (
                select id from inspection_template_versions where version = 2) where id = ${id}`),
          ),
        ),
        DB_INSPECTION_LOCKED,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update inspection_template_versions set fields = '[]' where id = ${v1}`),
          ),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`delete from inspection_template_versions where id = ${v1}`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('saisie et clôture', () => {
    it('refuse le modèle d’un autre type de ressource', async () => {
      const v1 = await modele('bureau')
      assert.equal(await codeErreur(() => etat(v1, { resource: SALLE })), DB_INSPECTION_INVALID)
    })

    it('vérifie chaque valeur contre le modèle', async () => {
      const v1 = await modele()
      const invalides = [
        { inconnu: 'x' },
        { cles: 'deux' },
        { proprete: 'Impeccable' },
        { murs: 'excellent' },
        { badge: 'oui' },
      ]
      for (const values of invalides) {
        assert.equal(await codeErreur(() => etat(v1, { values })), DB_INSPECTION_INVALID, JSON.stringify(values))
      }
      // En brouillon, un champ obligatoire peut attendre.
      await etat(v1, { values: { murs: 'usage', remarques: null } })
    })

    it('exige les champs obligatoires à la clôture, puis la date', async () => {
      const v1 = await modele()
      const id = await etat(v1, { values: { murs: 'bon' } })
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update inspections set status = 'closed', closed_by = ${CAMILLE} where id = ${id}`),
          ),
        ),
        DB_INSPECTION_INVALID,
      )
      await clore(id)
      const [row] = await asTenant((tx) => lire(tx, sql`select status, closed_at from inspections where id = ${id}`))
      assert.equal(row.status, 'closed')
      assert.ok(row.closed_at)
    })

    it('naît brouillon', async () => {
      const v1 = await modele()
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into inspections (kind, status, resource_id, client_id, contract_id, template_version_id,
                                       created_by, closed_at, closed_by)
              values ('entry', 'closed', ${BUREAU}, ${DURAND}, ${CONTRAT_DURAND}, ${v1}, ${CAMILLE}, CURRENT_TIMESTAMP(3), ${CAMILLE})`),
          ),
        ),
        DB_INSPECTION_INVALID,
      )
    })

    it('exige la réservation ou le contrat du client qui occupe', async () => {
      const v1 = await modele()
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into inspections (kind, resource_id, client_id, contract_id, template_version_id, created_by)
              values ('entry', ${BUREAU}, ${DURAND}, ${CONTRAT_PETIT}, ${v1}, ${CAMILLE})`),
          ),
        ),
        DB_FOREIGN_KEY_VIOLATION,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into inspections (kind, resource_id, client_id, template_version_id, created_by)
              values ('entry', ${BUREAU}, ${DURAND}, ${v1}, ${CAMILLE})`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
    })

    it('rattache une sortie à l’entrée close du même client, une seule fois', async () => {
      const v1 = await modele()
      const entree = await etat(v1)
      assert.equal(await codeErreur(() => etat(v1, { kind: 'exit', entry: entree })), DB_INSPECTION_INVALID)
      await clore(entree)
      assert.equal(
        await codeErreur(() => etat(v1, { kind: 'exit', entry: entree, client: PETIT })),
        DB_FOREIGN_KEY_VIOLATION,
      )
      await etat(v1, { kind: 'exit', entry: entree })
      assert.equal(await codeErreur(() => etat(v1, { kind: 'exit', entry: entree })), DB_UNIQUE_VIOLATION)
    })
  })

  describe('état clos', () => {
    it('ne change plus une fois clos', async () => {
      const id = await etat(await modele())
      await clore(id)
      for (const changement of [
        sql`\`values\` = '{"murs":"mauvais","cles":2,"proprete":"Propre"}'`,
        sql`observations = 'Ajout après coup'`,
        sql`performed_at = date_sub(CURRENT_TIMESTAMP(3), interval 1 day)`,
      ]) {
        assert.equal(
          await codeErreur(() =>
            asTenant((tx) => tx.execute(sql`update inspections set ${changement} where id = ${id}`)),
          ),
          DB_INSPECTION_LOCKED,
        )
      }
    })

    it('le client le valide une fois, depuis son espace, avec ses réserves', async () => {
      const id = await etat(await modele())
      await clore(id)
      // Des réserves au-delà de 2 000 caractères : la base les refuse, comme la saisie (ADR 041).
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              update inspections set signed_by_member_id = ${JEANNE}, client_remarks = repeat('x', 2001)
               where id = ${id}`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
      await asClients([DURAND], (tx) =>
        tx.execute(sql`
          update inspections set signed_by_member_id = ${JEANNE}, client_remarks = 'Rayure sur la porte',
                 signed_at = '2020-01-01'
           where id = ${id}`),
      )
      const [row] = await asTenant((tx) =>
        lire(tx, sql`
          select signed_by_member_id, client_remarks,
                 signed_at > date_sub(CURRENT_TIMESTAMP(3), interval 1 minute) as date_du_jour
            from inspections where id = ${id}`),
      )
      assert.equal(row.signed_by_member_id, JEANNE)
      assert.equal(Number(row.date_du_jour), 1)
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`update inspections set client_remarks = 'Autre chose' where id = ${id}`),
          ),
        ),
        DB_INSPECTION_LOCKED,
      )
    })

    it('ne se supprime pas', async () => {
      const id = await etat(await modele())
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`delete from inspections where id = ${id}`))),
        DB_INSPECTION_LOCKED,
      )
    })
  })

  describe('photos', () => {
    it('se déposent, se légendent et se retirent sur un brouillon ; plus sur un état clos', async () => {
      const id = await etat(await modele())
      const premiere = await photo(id, { fieldId: 'murs' })
      await asTenant((tx) =>
        tx.execute(sql`update inspection_photos set caption = 'Mur nord' where id = ${premiere}`),
      )
      await clore(id)
      assert.equal(await codeErreur(() => photo(id)), DB_INSPECTION_LOCKED)
      for (const changement of [sql`caption = 'Autre'`, sql`deleted_at = CURRENT_TIMESTAMP(3)`]) {
        assert.equal(
          await codeErreur(() =>
            asTenant((tx) => tx.execute(sql`update inspection_photos set ${changement} where id = ${premiere}`)),
          ),
          DB_INSPECTION_LOCKED,
        )
      }
    })

    it('illustrent un champ du modèle', async () => {
      const id = await etat(await modele())
      assert.equal(await codeErreur(() => photo(id, { fieldId: 'plafond' })), DB_INSPECTION_INVALID)
    })

    it('n’acceptent qu’une image compressée, chiffrée, d’un type accepté', async () => {
      const id = await etat(await modele())
      for (const values of [{ contentType: 'text/html' }, { byteSize: 0 }, { byteSize: 10 * 1024 * 1024 + 1 }]) {
        assert.equal(await codeErreur(() => photo(id, values)), DB_CHECK_VIOLATION, JSON.stringify(values))
      }
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into inspection_photos (inspection_id, storage_key, encryption_key_version, content_type,
                                             byte_size, width, height, uploaded_by)
              values (${id}, 'etats-des-lieux/clair.jpg', 0, 'image/jpeg', 100, 10, 10, ${CAMILLE})`),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
    })

    it('acceptent un PDF sans dimensions, figé comme une photo à la clôture (ADR 056)', async () => {
      const id = await etat(await modele())
      const pdf = { contentType: 'application/pdf', width: null, height: null }
      const document = await photo(id, { ...pdf, fieldId: 'murs' })
      await photo(id, pdf)
      // Une photo a ses dimensions, un PDF n'en a pas.
      assert.equal(await codeErreur(() => photo(id, { ...pdf, width: 800, height: 600 })), DB_CHECK_VIOLATION)
      assert.equal(await codeErreur(() => photo(id, { width: null, height: null })), DB_CHECK_VIOLATION)
      await clore(id)
      assert.equal(await codeErreur(() => photo(id, pdf)), DB_INSPECTION_LOCKED)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update inspection_photos set caption = 'Plan' where id = ${document}`)),
        ),
        DB_INSPECTION_LOCKED,
      )
    })

    it('ne se suppriment pas', async () => {
      const id = await photo(await etat(await modele()))
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`delete from inspection_photos where id = ${id}`))),
        DB_INSPECTION_LOCKED,
      )
    })
  })

  describe('portée client', () => {
    it('une entreprise ne voit que ses états des lieux clos, et leurs photos', async () => {
      // Sans RLS, la portée est celle des requêtes de l'espace client : elles
      // filtrent sur `client_id`, `status = 'closed'` et `deleted_at is null`.
      const v1 = await modele()
      const clos = await etat(v1)
      const photoClos = await photo(clos)
      await clore(clos)
      const sortie = await etat(v1, { kind: 'exit', entry: clos })
      const photoBrouillon = await photo(sortie)
      const autre = await etat(v1, { client: PETIT })
      const photoAutre = await photo(autre)
      await clore(autre)

      const liste = await listInspectionsForAccounts(durand)
      assert.deepEqual(
        liste.map((row) => row.id),
        [clos],
      )
      assert.ok(await findPhotoForAccounts(photoClos, durand))
      // La photo d'un brouillon, et celle d'une autre entreprise : introuvables.
      assert.equal(await findPhotoForAccounts(photoBrouillon, durand), undefined)
      assert.equal(await findPhotoForAccounts(photoAutre, durand), undefined)
      // Ni le brouillon de sortie, ni l'état d'une autre entreprise, ni leur lien.
      assert.equal(await findInspectionForAccounts(sortie, durand), undefined)
      assert.equal(await findInspectionForAccounts(autre, durand), undefined)
      const detail = await findInspectionForAccounts(clos, durand)
      assert.ok(detail)
      assert.equal(detail.exit, null)
      // Réciproquement : l'autre entreprise ne voit que le sien.
      const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]
      assert.deepEqual(
        (await listInspectionsForAccounts(petit)).map((row) => row.id),
        [autre],
      )
    })

    it('ne saisit rien depuis son espace', async () => {
      const v1 = await modele()
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              insert into inspections (kind, resource_id, client_id, contract_id, template_version_id, created_by)
              values ('entry', ${BUREAU}, ${DURAND}, ${CONTRAT_DURAND}, ${v1}, ${CAMILLE})`),
          ),
        ),
        DB_INSPECTION_LOCKED,
      )
      const id = await etat(v1)
      await clore(id)
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              insert into inspection_photos (inspection_id, storage_key, encryption_key_version, content_type,
                                             byte_size, width, height, uploaded_by)
              values (${id}, 'etats-des-lieux/client.jpg', 1, 'image/jpeg', 100, 10, 10, ${CAMILLE})`),
          ),
        ),
        DB_INSPECTION_LOCKED,
      )
    })

    it('journalise les consultations, sans correction, et seulement des photos de l’entreprise', async () => {
      const v1 = await modele()
      const sien = await etat(v1)
      const photoDurand = await photo(sien)
      await clore(sien)
      const autre = await etat(v1, { client: PETIT })
      const photoPetit = await photo(autre)
      await clore(autre)

      await asClients([DURAND], (tx) =>
        tx.execute(sql`
          insert into inspection_photo_views (photo_id, viewer, client_member_id, auth_user_id)
          values (${photoDurand}, 'client', ${JEANNE}, 'u-jeanne')`),
      )
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            tx.execute(sql`
              insert into inspection_photo_views (photo_id, viewer, client_member_id, auth_user_id)
              values (${photoPetit}, 'client', ${JEANNE}, 'u-jeanne')`),
          ),
        ),
        DB_SCOPE_VIOLATION,
      )
      for (const ecriture of [
        sql`update inspection_photo_views set auth_user_id = 'autre'`,
        sql`delete from inspection_photo_views`,
      ]) {
        assert.equal(await codeErreur(() => asTenant((tx) => tx.execute(ecriture))), DB_INSUFFICIENT_PRIVILEGE)
      }
    })
  })

  describe('conservation des photos', () => {
    /** Recule la clôture d'un état des lieux, sous le propriétaire (hors de l'application). */
    const reculerCloture = async (id: string, mois: number) => {
      const connection = await bases.owner.client.getConnection()
      try {
        await connection.query("set @app_anonymization = 'on'")
        await connection.query(
          'update inspections set closed_at = TIMESTAMPADD(MONTH, ?, CURRENT_TIMESTAMP(3)) where id = ?',
          [-mois, id],
        )
      } finally {
        await connection.query('set @app_anonymization = null').catch(() => {})
        connection.release()
      }
    }

    it('court depuis la clôture de la sortie : l’entrée reste la preuve tant que dure l’occupation', async () => {
      const v1 = await modele()
      const entree = await etat(v1)
      const photoEntree = await photo(entree)
      await clore(entree)
      const sortie = await etat(v1, { kind: 'exit', entry: entree })
      const photoSortie = await photo(sortie)
      await clore(sortie)
      const seule = await etat(v1, { client: PETIT })
      const photoSeule = await photo(seule)
      await clore(seule)
      // Une entrée sans sortie, close il y a dix ans : toujours gardée.
      await reculerCloture(seule, 120)

      const echues = () => asTenant((tx) => expiredInspectionPhotos(tx, 200))
      assert.deepEqual(
        (await echues()).map((row) => row.id),
        [],
      )

      await reculerCloture(sortie, 37)
      assert.deepEqual(
        (await echues()).map((row) => row.id).sort(),
        [photoEntree, photoSortie].sort(),
      )

      // Le fichier effacé par le code, la ligne marquée par la base.
      const [marquee] = await asTenant((tx) =>
        lire(tx, sql`select mark_inspection_photo_purged(${photoSortie}) as purgee`),
      )
      assert.equal(Number(marquee.purgee), 1)
      const [refusee] = await asTenant((tx) =>
        lire(tx, sql`select mark_inspection_photo_purged(${photoSeule}) as purgee`),
      )
      assert.equal(Number(refusee.purgee), 0)
      const [row] = await asTenant((tx) =>
        lire(tx, sql`select deleted_at from inspection_photos where id = ${photoSortie}`),
      )
      assert.ok(row.deleted_at)
    })

    it('purge le journal des consultations au terme de la durée du centre', async () => {
      const id = await etat(await modele())
      const photoId = await photo(id)
      await clore(id)
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into inspection_photo_views (photo_id, viewer, staff_member_id, auth_user_id, viewed_at)
          values (${photoId}, 'staff', ${CAMILLE}, 'u-camille', TIMESTAMPADD(MONTH, -13, CURRENT_TIMESTAMP(3))),
                 (${photoId}, 'staff', ${CAMILLE}, 'u-camille', CURRENT_TIMESTAMP(3))`)
      })
      const [purge] = await asTenant((tx) =>
        lire(tx, sql`select purge_expired_inspection_photo_views() as purged`),
      )
      assert.equal(Number(purge.purged), 1)
    })
  })
})
