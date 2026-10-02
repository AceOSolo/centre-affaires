import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { offerRequestedMessage } from '../facturation/offres-portail.ts'
import { portalBookingRequestMessage } from '../reservations/portail-notifications.ts'
import { renderTemplate } from './message-centre.ts'

/**
 * Messages au centre déclenchés depuis l'espace client (ADR 036, ADR 038) :
 * le modèle du centre remplace ses variables, et les textes par défaut disent
 * qui demande quoi, sans rien transporter d'autre (ADR 015).
 */
describe('messages au centre depuis l’espace client', () => {
  it('remplace les variables connues d’un modèle, laisse visibles les inconnues', () => {
    assert.equal(
      renderTemplate('{{client}} demande {{ offre }} — {{inconnue}}', { client: 'Atelier Durand', offre: 'Premium' }),
      'Atelier Durand demande Premium — {{inconnue}}',
    )
    assert.equal(renderTemplate('{{constructor}}', {}), '{{constructor}}')
  })

  it('dit à l’accueil qui demande quelle offre, et où préparer le contrat', () => {
    const message = offerRequestedMessage({
      centreName: 'Centre DOMOTOP',
      clientName: 'Atelier Durand',
      memberName: 'Jeanne Martin',
      offerName: 'Domiciliation Premium',
      link: 'https://centre.test/contrats/nouveau/offre?offre=1&client=2',
    })
    assert.equal(message.subject, 'Offre demandée : Domiciliation Premium — Atelier Durand')
    assert.match(message.text, /Jeanne Martin \(Atelier Durand\) demande l’offre « Domiciliation Premium »/)
    assert.match(message.text, /Préparer le contrat : https:\/\/centre\.test/)
    assert.equal(message.variables.offre, 'Domiciliation Premium')
  })

  it('dit à l’accueil la demande de réservation, son montant figé ou son absence', () => {
    const facts = {
      centreName: 'Centre DOMOTOP',
      clientName: 'Atelier Durand',
      memberName: 'Jeanne Martin',
      resourceName: 'Salle Europe',
      when: 'le mardi 13 octobre 2026, de 09:00 à 11:00',
    }
    const chiffree = portalBookingRequestMessage({ ...facts, amount: '48,00 €' })
    assert.equal(chiffree.subject, 'Demande de réservation à valider — Atelier Durand')
    assert.match(chiffree.text, /Montant figé sur la demande : 48,00 € TTC/)
    assert.match(chiffree.text, /bloqué jusqu’à votre réponse/)
    const nonChiffree = portalBookingRequestMessage({ ...facts, amount: null })
    assert.match(nonChiffree.text, /n’a pas été chiffré/)
    assert.equal(nonChiffree.variables.montant, '')
  })
})
