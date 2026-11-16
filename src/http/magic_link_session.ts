/** Constant-size browser binding shared by outstanding managed magic links. */
import { isClientVerifier } from '../client_challenge.js'
import { newVerifier } from './pkce_verifier.js'
import type { SessionStore } from './session_access.js'

const key = 'accountKit.magicLink.verifier'
type Binding = { verifier: string; outstanding: number; expiresAt: number }

function read(session: SessionStore): Binding | undefined {
  const value = session.get(key)
  // Older releases stored one verifier without a retention deadline.
  if (isClientVerifier(value)) return { verifier: value, outstanding: 1, expiresAt: 0 }
  if (value && typeof value === 'object') {
    const binding = value as Binding
    if (
      isClientVerifier(binding.verifier) &&
      Number.isSafeInteger(binding.outstanding) &&
      binding.outstanding > 0 &&
      Number.isFinite(binding.expiresAt) &&
      binding.expiresAt > Date.now()
    )
      return binding
  }
  if (value !== undefined) session.forget(key)
}

export function magicLinkVerifier(session: SessionStore, create: false): string | undefined
export function magicLinkVerifier(session: SessionStore, create?: true): string
export function magicLinkVerifier(session: SessionStore, create = true): string | undefined {
  return read(session)?.verifier ?? (create ? newVerifier().verifier : undefined)
}

export function acknowledgeMagicLink(session: SessionStore, verifier: string, expiresAt: number) {
  const previous = read(session)
  session.put(key, {
    verifier,
    outstanding: Math.min((previous?.outstanding ?? 0) + 1, Number.MAX_SAFE_INTEGER),
    expiresAt: Math.max(previous?.expiresAt ?? 0, expiresAt),
  } satisfies Binding)
}

export function consumeMagicLink(session: SessionStore) {
  const binding = read(session)
  if (!binding || binding.outstanding <= 1) session.forget(key)
  else session.put(key, { ...binding, outstanding: binding.outstanding - 1 })
}
