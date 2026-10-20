import { createHash, randomBytes } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError } from 'adonisjs-account-kit'
import { requiredString } from '#services/social_request'
import { authStrategy } from '#services/auth_strategy'

/** The browser's PKCE verifier, kept in the session between redirect and callback. */
export type BrowserTransaction = { state: string; verifier: string }
type BrowserContinuation = { continuation: string; verifier: string }

const transactionKey = 'socialTransaction'
const continuationKey = 'socialContinuation'

const isBrowser = () => authStrategy() === 'session'

/** A fresh PKCE verifier. */
export const pkceVerifier = () => randomBytes(32).toString('base64url')
/** The PKCE S256 challenge for `verifier`. */
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

/**
 * Session clients get a server-held verifier; token clients send their own `clientChallenge`.
 * Call `remember` with the begin result's state to keep the verifier for the callback.
 */
export function beginBrowserTransaction(ctx: HttpContext) {
  const verifier = isBrowser() ? pkceVerifier() : undefined
  const clientChallenge = verifier
    ? pkceChallenge(verifier)
    : requiredString(ctx.request.input('clientChallenge'), 'clientChallenge')
  return {
    clientChallenge,
    remember(state: string) {
      if (verifier) ctx.session.put(transactionKey, { state, verifier })
    },
  }
}

/** The pending session transaction for this callback state; undefined for token clients. */
export function pendingBrowserTransaction(
  ctx: HttpContext,
  state: string
): BrowserTransaction | undefined {
  if (!isBrowser()) return undefined
  const pending = ctx.session.get(transactionKey) as BrowserTransaction | undefined
  if (pending?.state !== state) throw new InvalidInputError('Invalid social transaction')
  return pending
}

export function forgetBrowserTransaction(ctx: HttpContext) {
  ctx.session.forget(transactionKey)
}

/** Carries the transaction's verifier over to the registration continuation. */
export function rememberBrowserContinuation(
  ctx: HttpContext,
  continuation: string,
  pending: BrowserTransaction
) {
  ctx.session.put(continuationKey, { continuation, verifier: pending.verifier })
}

/** The pending session continuation for this request; undefined for token clients. */
export function pendingBrowserContinuation(
  ctx: HttpContext,
  continuation: string
): BrowserContinuation | undefined {
  if (!isBrowser()) return undefined
  const pending = ctx.session.get(continuationKey) as BrowserContinuation | undefined
  if (pending?.continuation !== continuation) {
    throw new InvalidInputError('Invalid social continuation')
  }
  return pending
}

export function forgetBrowserContinuation(ctx: HttpContext) {
  ctx.session.forget(continuationKey)
}
