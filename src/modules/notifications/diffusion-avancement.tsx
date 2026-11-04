'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Tant qu'un message part par paquets (ADR 060), la page de son envoi se
 * relit d'elle-même toutes les cinq secondes : l'avancement s'y lit sans
 * recharger. Par interrogation, comme la cloche (ADR 059) : pas de websocket.
 */
export function RefreshWhileSending({ active, seconds = 5 }: { active: boolean; seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => router.refresh(), seconds * 1000)
    return () => window.clearInterval(timer)
  }, [active, seconds, router])
  return null
}
