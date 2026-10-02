import { formatInspectionValue } from './champs.ts'
import type { InspectionPhotoRow } from './queries.ts'
import type { InspectionField, InspectionValues } from './schema.ts'

/**
 * Lecture d'un état des lieux : chaque champ de sa version, sa valeur et ses
 * photos, puis les observations et les photos d'ensemble. Sert au
 * back-office, à la vue imprimable et à l'espace client — seul le chemin des
 * photos change (`photoBase`), chacun avec son contrôle et son journal.
 *
 * Composant serveur : aucune interaction.
 */
export function InspectionValuesView({
  fields,
  values,
  observations,
  photos,
  photoBase,
  purgedPhotoCount = 0,
  photoRetentionMonths,
}: {
  fields: readonly InspectionField[]
  values: InspectionValues
  observations: string | null
  photos: readonly InspectionPhotoRow[]
  photoBase: string
  purgedPhotoCount?: number
  photoRetentionMonths?: number
}) {
  const general = photos.filter((photo) => photo.fieldId === null)
  return (
    <div className="flex flex-col gap-4">
      <dl className="divide-y divide-border rounded-lg border border-border bg-white print:break-inside-auto">
        {fields.map((field) => {
          const value = formatInspectionValue(field, values[field.id])
          const own = photos.filter((photo) => photo.fieldId === field.id)
          return (
            <div key={field.id} className="flex flex-col gap-2 px-5 py-3 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-4 print:break-inside-avoid">
              <dt className="text-sm text-muted-foreground">{field.label}</dt>
              <dd className="flex flex-col gap-2 text-sm">
                {value === null ? (
                  <span className="text-muted-foreground">Non renseigné</span>
                ) : (
                  <span className={`${field.type === 'number' ? 'tabular' : ''} whitespace-pre-line font-medium`}>
                    {value}
                  </span>
                )}
                {own.length > 0 && <PhotoGallery photos={own} photoBase={photoBase} subject={field.label} />}
              </dd>
            </div>
          )
        })}
        <div className="flex flex-col gap-2 px-5 py-3 sm:grid sm:grid-cols-[14rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted-foreground">Observations</dt>
          <dd className="whitespace-pre-line text-sm">
            {observations || <span className="text-muted-foreground">Aucune</span>}
          </dd>
        </div>
      </dl>

      {(general.length > 0 || purgedPhotoCount > 0) && (
        <section aria-labelledby="photos-ensemble-titre" className="flex flex-col gap-2">
          <h3 id="photos-ensemble-titre" className="text-sm font-semibold tracking-tight">
            Photos d’ensemble
          </h3>
          {general.length > 0 && (
            <PhotoGallery photos={general} photoBase={photoBase} subject="vue d’ensemble" />
          )}
          {purgedPhotoCount > 0 && (
            <p className="text-sm text-muted-foreground">
              {purgedPhotoCount} photo{purgedPhotoCount > 1 ? 's' : ''} effacée
              {purgedPhotoCount > 1 ? 's' : ''} au terme de leur durée de conservation
              {photoRetentionMonths ? ` (${photoRetentionMonths} mois après la sortie)` : ''}.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

/** Vignettes cliquables : chaque affichage passe par la route, qui journalise. */
export function PhotoGallery({
  photos,
  photoBase,
  subject,
}: {
  photos: readonly InspectionPhotoRow[]
  photoBase: string
  subject: string
}) {
  return (
    <ul className="flex flex-wrap gap-3">
      {photos.map((photo, index) => {
        const href = `${photoBase}/${photo.id}`
        const alt = photo.caption ?? `Photo ${index + 1} — ${subject}`
        return (
          <li key={photo.id} className="w-40 print:w-56">
            <figure className="flex flex-col gap-1">
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- photo déchiffrée et journalisée par la route, pas d'optimisation d'image */}
                <img
                  src={href}
                  alt={alt}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  className="h-28 w-full object-cover print:h-auto"
                />
                <span className="sr-only"> (ouvrir en grand dans un nouvel onglet)</span>
              </a>
              {photo.caption && <figcaption className="text-xs text-muted-foreground">{photo.caption}</figcaption>}
            </figure>
          </li>
        )
      })}
    </ul>
  )
}
