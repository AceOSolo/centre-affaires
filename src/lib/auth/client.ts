'use client'

import { inferAdditionalFields } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Client d'authentification côté navigateur.
 *
 * Sans `baseURL` : il s'adresse à `/api/auth` sur la même origine, donc à
 * cette application (ADR 042).
 *
 * `companyName` : raison sociale saisie à l'inscription libre (ADR 045),
 * déclarée aussi côté serveur (`server.ts`, `user.additionalFields`).
 */
export const authClient = createAuthClient({
  plugins: [inferAdditionalFields({ user: { companyName: { type: 'string', required: false } } })],
})
