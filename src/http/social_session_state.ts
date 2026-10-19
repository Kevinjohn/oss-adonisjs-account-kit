import { createHash } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { SocialTransactionError } from '../errors.js'
import { isSocialProviderName } from '../social_providers.js'
import type { SocialIntent, SocialProviderName } from '../types.js'

export interface SessionSocialState {
  verifier: string
  intent: SocialIntent
  provider: SocialProviderName
  expiresAt: number
}

interface PendingSessionState {
  key: string
  expiresAt: number
}

const pendingKey = 'accountKit.social.pendingStates'
const maxPendingStates = 8
const stateLifetimeMs = 10 * 60 * 1000

export interface SessionStore {
  get(key: string): unknown
  put(key: string, value: unknown): void
  forget(key: string): void
}

function session(context: HttpContext): SessionStore {
  const value = (context as HttpContext & { session?: SessionStore }).session
  if (!value?.get || !value.put || !value.forget)
    throw new Error('Managed social session flow requires persistent AdonisJS session middleware')
  return value
}

export function optionalSession(context: HttpContext): SessionStore | undefined {
  const value = (context as HttpContext & { session?: SessionStore }).session
  return value &&
    typeof value.get === 'function' &&
    typeof value.put === 'function' &&
    typeof value.forget === 'function'
    ? value
    : undefined
}

function stateKey(state: string): string {
  return `accountKit.social.${createHash('sha256').update(state).digest('hex')}`
}

function pendingStates(store: SessionStore): PendingSessionState[] {
  const raw = store.get(pendingKey)
  const now = Date.now()
  const states = Array.isArray(raw)
    ? raw.filter(
        (item): item is PendingSessionState =>
          item !== null &&
          typeof item === 'object' &&
          typeof item.key === 'string' &&
          typeof item.expiresAt === 'number'
      )
    : []
  const live = states.filter((item) => item.expiresAt > now)
  for (const item of states) if (item.expiresAt <= now) store.forget(item.key)
  if (live.length !== states.length) store.put(pendingKey, live)
  return live
}

export function rememberSessionState(
  context: HttpContext,
  state: string,
  value: Omit<SessionSocialState, 'expiresAt'> & { expiresAt?: number }
): void {
  const store = session(context)
  const key = stateKey(state)
  const expiresAt = value.expiresAt ?? Date.now() + stateLifetimeMs
  const pending = pendingStates(store).filter((item) => item.key !== key)
  while (pending.length >= maxPendingStates) {
    const oldest = pending.shift()!
    store.forget(oldest.key)
  }
  store.put(key, { ...value, expiresAt })
  store.put(pendingKey, [...pending, { key, expiresAt }])
}

export function forgetSessionState(context: HttpContext, state: string): void {
  const store = session(context)
  const key = stateKey(state)
  store.forget(key)
  store.put(
    pendingKey,
    pendingStates(store).filter((item) => item.key !== key)
  )
}

export function sessionState(context: HttpContext, state: string): SessionSocialState {
  const store = session(context)
  const pending = pendingStates(store)
  const key = stateKey(state)
  const stored = pending.some((item) => item.key === key) ? store.get(key) : undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    typeof (stored as SessionSocialState).verifier !== 'string' ||
    typeof (stored as SessionSocialState).intent !== 'string' ||
    !isSocialProviderName((stored as SessionSocialState).provider) ||
    typeof (stored as SessionSocialState).expiresAt !== 'number' ||
    (stored as SessionSocialState).expiresAt <= Date.now()
  )
    throw new SocialTransactionError()
  return stored as SessionSocialState
}
