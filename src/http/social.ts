import { createHash, randomBytes } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.js'
import { InvalidInputError, SocialTransactionError } from '../errors.js'
import type {
  CurrentAccountInput,
  SensitivePurpose,
  SocialBeginInput,
  SocialIntent,
  SocialProviderName,
  SocialCallbackResult,
  Trx,
} from '../types.js'
import type { ManagedGuard, ManagedHandler } from './managed.js'
import type { ManagedEndpointName } from './routes.js'
import {
  socialBeginValidator,
  socialCallbackValidator,
  socialConfirmationValidator,
  socialPasswordProofValidator,
  socialRegistrationValidator,
  socialTokenValidator,
  socialUnlinkValidator,
} from './validators.js'

export interface ManagedSocialExtension {
  /** Public provider inventory, without client credentials or account data. */
  providers: readonly SocialProviderName[]
  /** Application creation policy; never inferred from a client body. */
  admit?: (
    profile: { provider: SocialProviderName; subject: string; email: string },
    trx: Trx
  ) => Promise<void>
  /** Optional trusted reader for a signed, visitor-local hint; never read account information. */
  lastUsedMethod?(context: HttpContext): Promise<'password' | SocialProviderName | null>
  /** Optional signed visitor-local writer called only after a credential is established. */
  rememberLastUsedMethod?(
    context: HttpContext,
    method: 'password' | SocialProviderName
  ): Promise<void>
}

interface SessionSocialState {
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

interface SessionStore {
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

function optionalSession(context: HttpContext): SessionStore | undefined {
  const value = (context as HttpContext & { session?: SessionStore }).session
  return value &&
    typeof value.get === 'function' &&
    typeof value.put === 'function' &&
    typeof value.forget === 'function'
    ? value
    : undefined
}

/** A server-held visitor preference, never an account lookup or authentication signal. */
export async function rememberManagedMethod(
  context: HttpContext,
  method: 'password' | SocialProviderName,
  extension?: ManagedSocialExtension
): Promise<void> {
  try {
    optionalSession(context)?.put('accountKit.social.lastUsedMethod', method)
    await extension?.rememberLastUsedMethod?.(context, method)
  } catch {
    // A visitor preference cannot turn an established credential into a failed login.
  }
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

function rememberSessionState(
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

function forgetSessionState(context: HttpContext, state: string): void {
  const store = session(context)
  const key = stateKey(state)
  store.forget(key)
  store.put(
    pendingKey,
    pendingStates(store).filter((item) => item.key !== key)
  )
}

function providerName(value: string, enabled: readonly SocialProviderName[]): SocialProviderName {
  if ((value !== 'google' && value !== 'github') || !enabled.includes(value))
    throw new InvalidInputError('Unsupported social provider')
  return value
}

function identityId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid identity ID')
  return id
}

function sessionState(context: HttpContext, state: string): SessionSocialState {
  const store = session(context)
  const pending = pendingStates(store)
  const key = stateKey(state)
  const stored = pending.some((item) => item.key === key) ? store.get(key) : undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    typeof (stored as SessionSocialState).verifier !== 'string' ||
    typeof (stored as SessionSocialState).intent !== 'string' ||
    !['google', 'github'].includes((stored as SessionSocialState).provider) ||
    typeof (stored as SessionSocialState).expiresAt !== 'number' ||
    (stored as SessionSocialState).expiresAt <= Date.now()
  )
    throw new SocialTransactionError()
  return stored as SessionSocialState
}

function safeIdentity(identity: {
  id: number
  provider: SocialProviderName
  email: string | null
  emailVerified: boolean
}) {
  return {
    id: identity.id,
    provider: identity.provider,
    email: identity.email,
    emailVerified: identity.emailVerified,
  }
}

function safeResult(result: SocialCallbackResult): Record<string, unknown> {
  if (result.status === 'reauthenticated') return { status: result.status, proof: result.proof }
  if (result.status === 'link_required') return { status: result.status }
  if ('continuation' in result) return { status: 'new', continuation: result.continuation }
  if ('emailVerificationRequired' in result)
    return { status: 'new', emailVerificationRequired: true }
  return { status: result.status }
}

/** Session guards get a server-held verifier; token guards must supply their own challenge. */
function newChallenge<Credential>(
  guard: ManagedGuard<Credential>,
  clientChallenge?: string
): { verifier: string | null; clientChallenge: string } {
  const verifier = guard.strategy === 'session' ? randomBytes(32).toString('base64url') : null
  const challenge = verifier
    ? createHash('sha256').update(verifier).digest('base64url')
    : clientChallenge
  if (!challenge) throw new InvalidInputError('Client challenge is required')
  return { verifier, clientChallenge: challenge }
}

/** Session flows redeem the handoff in-request; token flows return the code for `auth.oauth.token`. */
async function finishHandoff<Credential>(
  context: HttpContext,
  social: AccountKit['socialAuthentication'],
  guard: ManagedGuard<Credential>,
  extension: ManagedSocialExtension,
  methodsEnabled: boolean,
  result: SocialCallbackResult,
  saved: SessionSocialState | null
): Promise<unknown> {
  const { response } = context
  if ('handoffCode' in result && result.handoffCode) {
    if (saved) {
      const established = await social.redeemHandoff({
        code: result.handoffCode,
        verifier: saved.verifier,
        guard: guard.forRequest(context),
      })
      if (methodsEnabled) await rememberManagedMethod(context, saved.provider, extension)
      return response.ok({ status: result.status, account: established.account })
    }
    return response.ok({ status: result.status, code: result.handoffCode })
  }
  return response.ok(safeResult(result))
}

interface SocialRequest<Credential> {
  name: ManagedEndpointName
  context: HttpContext
  social: AccountKit['socialAuthentication']
  guard: ManagedGuard<Credential>
  extension: ManagedSocialExtension
  methodsEnabled: boolean
}

type SocialHandler = <Credential>(request: SocialRequest<Credential>) => Promise<unknown>

const oauthCallback: SocialHandler = async ({
  name,
  context,
  social,
  guard,
  extension,
  methodsEnabled,
}) => {
  const { request, params } = context
  const provider = providerName(params.provider, extension.providers)
  const isPost = name === 'auth.oauth.complete'
  const providerCode = request.input('code')
  if (request.input('error') || typeof providerCode !== 'string' || !providerCode)
    throw new SocialTransactionError()
  const input = isPost
    ? await request.validateUsing(socialCallbackValidator)
    : {
        state: request.input('state') as string,
        intent: undefined,
      }
  if (typeof input.state !== 'string') throw new SocialTransactionError()
  if (isPost && input.intent && !['login', 'link', 'reauth', 'confirm'].includes(input.intent))
    throw new SocialTransactionError()
  const saved = guard.strategy === 'session' ? sessionState(context, input.state) : null
  if (saved && saved.provider !== provider) throw new SocialTransactionError()
  const intent = saved?.intent ?? (input.intent as SocialIntent | undefined) ?? 'login'
  if (guard.strategy === 'access_tokens' && !isPost && intent !== 'login')
    throw new SocialTransactionError()
  const current: CurrentAccountInput | undefined =
    intent === 'login' || intent === 'confirm' ? undefined : await guard.current(context)
  const result = await social.callback({
    state: input.state,
    provider,
    intent,
    current,
    callback: context,
  })
  if (saved) {
    forgetSessionState(context, input.state)
    if ('continuation' in result && result.continuation)
      rememberSessionState(context, result.continuation, saved)
  }
  return finishHandoff(context, social, guard, extension, methodsEnabled, result, saved)
}

const socialHandlers = {
  'auth.methods': async ({ context, extension }) => {
    const stored = optionalSession(context)?.get('accountKit.social.lastUsedMethod')
    const hinted = extension.lastUsedMethod ? await extension.lastUsedMethod(context) : stored
    const lastUsedMethod =
      hinted === 'password' || extension.providers.includes(hinted as SocialProviderName)
        ? hinted
        : null
    return context.response.ok({
      providers: extension.providers,
      lastUsedMethod,
    })
  },
  'auth.oauth.redirect': async ({ context, social, guard, extension }) => {
    const { request, response, params } = context
    const provider = providerName(params.provider, extension.providers)
    const input = await request.validateUsing(socialBeginValidator)
    if (!['login', 'link', 'reauth'].includes(input.intent ?? 'login'))
      throw new InvalidInputError('Invalid social intent')
    if (
      input.purpose &&
      !['social_link', 'social_unlink', 'password_change', 'email_change'].includes(input.purpose)
    )
      throw new InvalidInputError('Invalid social proof purpose')
    const intent = (input.intent ?? 'login') as SocialBeginInput['intent']
    const current = intent === 'login' ? undefined : await guard.current(context)
    const { verifier, clientChallenge } = newChallenge(guard, input.clientChallenge)
    const beginInput = {
      provider,
      intent,
      current,
      purpose: input.purpose as SensitivePurpose | undefined,
      proof: input.proof,
      clientChallenge,
      context,
    }
    const result = await social.begin(beginInput)
    if (verifier) rememberSessionState(context, result.state, { verifier, intent, provider })
    return response.ok({ authorizationUrl: result.url })
  },
  'auth.oauth.confirmation': async ({ context, social, guard, extension }) => {
    const { request, response, params } = context
    const provider = providerName(params.provider, extension.providers)
    const input = await request.validateUsing(socialConfirmationValidator)
    const { verifier, clientChallenge } = newChallenge(guard, input.clientChallenge)
    const confirmation = {
      provider,
      verificationToken: input.verificationToken,
      clientChallenge,
      context,
    }
    const result = await social.beginConfirmation(confirmation)
    if (verifier)
      rememberSessionState(context, result.state, { verifier, intent: 'confirm', provider })
    return response.ok({ authorizationUrl: result.url })
  },
  'auth.oauth.callback': oauthCallback,
  'auth.oauth.complete': oauthCallback,
  'auth.oauth.registration': async ({ context, social, guard, extension, methodsEnabled }) => {
    const input = await context.request.validateUsing(socialRegistrationValidator)
    const saved = guard.strategy === 'session' ? sessionState(context, input.continuation) : null
    const result = await social.completeRegistration({
      continuation: input.continuation,
      email: input.email,
      registrationData: input.registrationData,
      admit: extension.admit,
    })
    if (saved) forgetSessionState(context, input.continuation)
    return finishHandoff(context, social, guard, extension, methodsEnabled, result, saved)
  },
  'auth.oauth.token': async ({ context, social, guard, extension, methodsEnabled }) => {
    const input = await context.request.validateUsing(socialTokenValidator)
    const result = await social.redeemHandoff({
      code: input.code,
      verifier: input.verifier,
      guard: guard.forRequest(context),
    })
    if (
      methodsEnabled &&
      'provider' in result &&
      (result.provider === 'google' || result.provider === 'github') &&
      extension.providers.includes(result.provider)
    )
      await rememberManagedMethod(context, result.provider, extension)
    return context.response.ok({
      account: result.account,
      token: guard.publicCredential!(result.credential),
    })
  },
  'account.socialProof.password': async ({ context, social, guard }) => {
    const input = await context.request.validateUsing(socialPasswordProofValidator)
    if (
      !['social_link', 'social_unlink', 'password_change', 'email_change'].includes(input.purpose)
    )
      throw new InvalidInputError('Invalid social proof purpose')
    const proof = await social.provePassword({
      current: await guard.current(context),
      password: input.password,
      purpose: input.purpose as SensitivePurpose,
    })
    return context.response.ok({ proof })
  },
  'account.socialIdentities.list': async ({ context, social, guard }) => {
    const identities = await social.list({ current: await guard.current(context) })
    return context.response.ok({ identities: identities.map(safeIdentity) })
  },
  'account.socialIdentities.unlink': async ({ context, social, guard }) => {
    const input = await context.request.validateUsing(socialUnlinkValidator)
    await social.unlink({
      current: await guard.current(context),
      identityId: identityId(context.params.id),
      proof: input.proof,
    })
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, SocialHandler>>

export type ManagedSocialEndpointName = keyof typeof socialHandlers

/** Dispatch only after the managed router has applied guard, CSRF, throttle and no-store policy. */
export async function executeManagedSocial<Credential>(
  name: ManagedSocialEndpointName,
  context: HttpContext,
  social: AccountKit['socialAuthentication'],
  guard: ManagedGuard<Credential>,
  extension: ManagedSocialExtension,
  methodsEnabled = true
): Promise<unknown> {
  return socialHandlers[name]({ name, context, social, guard, extension, methodsEnabled })
}

const managedSocialRoute: ManagedHandler = ({ route, context, kit, options, methodsEnabled }) =>
  executeManagedSocial(
    route.name as ManagedSocialEndpointName,
    context,
    kit.socialAuthentication,
    options.guard,
    options.extensions!.social!,
    methodsEnabled
  )

/** The managed router's entries for every social endpoint, keyed like `socialHandlers`. */
export const managedSocialHandlers = Object.fromEntries(
  Object.keys(socialHandlers).map((name) => [name, managedSocialRoute])
) as Record<ManagedSocialEndpointName, ManagedHandler>
