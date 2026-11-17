'use client'

import { useId, useMemo, useState } from 'react'

import { TestEmailForm, type TestEmailChoice } from './essai-courriel-form.tsx'
import { renderEmailHtml, type EmailBranding } from './gabarit.ts'
import { exampleValuesFor, renderMessage } from './rendu.ts'
import type { NotificationEvent } from './schema.ts'

type Width = 'ordinateur' | 'telephone'

const widths: Record<Width, { label: string; className: string }> = {
  ordinateur: { label: 'Ordinateur', className: 'w-full' },
  telephone: { label: 'Téléphone (375 px)', className: 'w-[375px] max-w-full' },
}

/**
 * Aperçu des courriels (ADR 080) : un modèle au choix, rempli de valeurs
 * d'exemple fictives, mis en page par le gabarit des envois — le même code,
 * exécuté ici dans le navigateur — avec le logo et la signature enregistrés.
 * Puis l'envoi de ce même exemple à sa propre adresse.
 *
 * Le cadre n'exécute rien (`sandbox` sans scripts) ; ses liens s'ouvrent dans
 * un nouvel onglet.
 */
export function EmailPreview({
  branding,
  templates,
  choices,
  origin,
  address,
  defaultEvent,
}: {
  branding: EmailBranding
  /** Modèle de chaque événement : celui du centre, ou le texte par défaut. */
  templates: Readonly<Record<string, { subject: string; body: string; active: boolean }>>
  choices: readonly TestEmailChoice[]
  /** Origine des liens d'exemple : celle du site. */
  origin: string
  /** Adresse du membre connecté, destinataire de l'essai ; nulle sans le droit d'en envoyer. */
  address: string | null
  defaultEvent: string
}) {
  const [event, setEvent] = useState(defaultEvent)
  const [width, setWidth] = useState<Width>('ordinateur')
  const [height, setHeight] = useState(720)
  const selectId = useId()
  const choice = choices.find((item) => item.value === event) ?? choices[0]
  const template = templates[choice.value]

  const html = useMemo(() => {
    const rendered = renderMessage(
      template,
      exampleValuesFor(choice.value as NotificationEvent, { centre: branding.centreName, origin }),
      choice.label,
    )
    return renderEmailHtml({ subject: rendered.subject, text: rendered.body }, branding, { preview: true })
  }, [template, choice, branding, origin])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-64 flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium text-foreground">
            Message à prévisualiser
          </label>
          <select
            id={selectId}
            value={choice.value}
            onChange={(change) => setEvent(change.target.value)}
            className="min-h-10 rounded-sm border border-border bg-white px-3 text-sm focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {choices.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div role="group" aria-label="Largeur de l’aperçu" className="flex gap-2">
          {(Object.keys(widths) as Width[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={width === key}
              onClick={() => setWidth(key)}
              className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:bg-primary/5 aria-pressed:text-primary"
            >
              {widths[key].label}
            </button>
          ))}
        </div>
      </div>

      {!template.active && (
        <p className="text-sm font-medium text-foreground">
          Ce message est désactivé dans les modèles : il ne part pas aux clients.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-muted p-2">
        <iframe
          // Rechargé à chaque largeur : la hauteur du message se remesure.
          key={width}
          title={`Aperçu du courriel « ${choice.label} »`}
          srcDoc={html}
          // Sans `allow-scripts` : rien ne s'exécute. `allow-same-origin` laisse
          // l'écran mesurer la hauteur du message.
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          onLoad={(load) => {
            const document = load.currentTarget.contentDocument
            const measured = document?.documentElement.scrollHeight
            if (measured && measured > 200) setHeight(measured + 8)
          }}
          style={{ height }}
          className={`mx-auto block rounded-md border-0 bg-white ${widths[width].className}`}
        />
      </div>

      {address && (
        <TestEmailForm key={choice.value} address={address} event={choice.value} eventLabel={choice.label} />
      )}
    </div>
  )
}
