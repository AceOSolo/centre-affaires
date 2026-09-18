'use client'

import { createAuthClient } from '@neondatabase/auth/next'

/**
 * Client d'authentification côté navigateur.
 *
 * Sans argument : il s'adresse au relais `/api/auth` de cette application, donc
 * à la même origine. L'URL du service Neon reste côté serveur.
 */
export const authClient = createAuthClient()
