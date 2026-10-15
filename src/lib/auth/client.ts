'use client'

import { createAuthClient } from 'better-auth/react'

/**
 * Client d'authentification côté navigateur.
 *
 * Sans `baseURL` : il s'adresse à `/api/auth` sur la même origine, donc à
 * cette application (ADR 042).
 */
export const authClient = createAuthClient()
