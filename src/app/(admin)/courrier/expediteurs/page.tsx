import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { findSenderListSettings } from '../../../../modules/courrier/expediteurs-queries.ts'
import { SenderListForm } from '../../../../modules/courrier/expediteurs-liste-form.tsx'

export const metadata = { title: 'Expéditeurs proposés' }

const notices: Record<string, string> = {
  enregistree: 'Liste enregistrée. L’accueil la voit dès sa prochaine saisie.',
  retablie: 'Liste par défaut rétablie : la liste de départ et les expéditeurs les plus saisis au centre.',
}

/**
 * Réglage des expéditeurs proposés à la saisie du courrier (ADR 079, recette
 * du 17/11) : la liste suggérée dans le champ « Expéditeur » de la saisie
 * groupée, du formulaire pli par pli, de la fiche et de la tournée. Ouvert
 * depuis Réglages, au droit de la configuration du centre.
 */
export default async function ExpediteursPage({ searchParams }: { searchParams: Promise<{ fait?: string }> }) {
  await requirePermission('centre.configurer')
  const [{ fait }, settings] = await Promise.all([searchParams, findSenderListSettings()])

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <LienRetour href="/reglages" label="Réglages" />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Expéditeurs proposés</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          La liste que l’accueil se voit proposer en tapant l’expéditeur d’un pli, dans cet ordre. En tête
          viennent toujours les expéditeurs déjà saisis pour l’entreprise du pli. La saisie reste libre :
          un expéditeur absent de la liste se tape tel quel.
        </p>
        {!settings.customized && (
          <p className="mt-2 max-w-[70ch] text-sm">
            Liste par défaut : les expéditeurs les plus saisis au centre, puis une liste de départ. Enregistrée,
            elle devient la vôtre et ne change plus d’elle-même.
          </p>
        )}
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      <SenderListForm list={settings.list} customized={settings.customized} frequent={settings.frequentMissing} />
    </div>
  )
}
