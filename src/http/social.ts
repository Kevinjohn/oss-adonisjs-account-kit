import type { HttpContext } from '@adonisjs/core/http'
import { E_ACCOUNT_KIT_INVALID_INPUT, E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID } from '../errors.ts'
import { isSocialProviderName } from '../social_providers.ts'
import { isSensitivePurpose, isSocialBeginIntent, isSocialIntent } from '../social_enums.ts'
import type {
  CurrentAccountInput,
  SensitivePurpose,
  SocialBeginInput,
  SocialIntent,
  SocialProviderName,
  SocialCallbackResult,
  Trx,
} from '../types.ts'
import type { ManagedGuard, ManagedHandler } from './managed_types.ts'
import type { ManagedEndpointName } from './routes.ts'
import {
  socialBeginValidator,
  socialCallbackValidator,
  socialConfirmationValidator,
  socialRegistrationValidator,
  socialTokenValidator,
} from './validators.ts'
import { rememberManagedMethod } from './last_used_method.ts'
import {
  forgetSessionState,
  rememberSessionState,
  requireSessionState,
  type SessionSocialState,
} from './social_session_state.ts'
import { generateVerifierAndChallenge } from './pkce_verifier.ts'
import {
  managedSocialAccountHandlers,
  type SocialHandler,
  type SocialRequest,
} from './managed_social_account_handlers.ts'

export { rememberManagedMethod } from './last_used_method.ts'

/** Social sign-in options for `registerManagedRoutes`, passed as `extensions.social`. */
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

function requireEnabledProviderName(
  value: string,
  enabled: readonly SocialProviderName[]
): SocialProviderName {
  if (!isSocialProviderName(value) || !enabled.includes(value))
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Unsupported social provider')
  return value
}

function projectSocialCallbackResult(result: SocialCallbackResult): Record<string, unknown> {
  if (result.status === 'reauthenticated') return { status: result.status, proof: result.proof }
  if (result.status === 'link_required') return { status: result.status }
  if ('continuation' in result) return { status: 'new', continuation: result.continuation }
  if ('emailVerificationRequired' in result)
    return { status: 'new', emailVerificationRequired: true }
  return { status: result.status }
}

/** Session guards get a server-held verifier; token guards must supply their own challenge. */
function resolveClientChallenge<Credential>(
  guard: ManagedGuard<Credential>,
  clientChallenge?: string
): { verifier: string | null; clientChallenge: string } {
  if (guard.strategy === 'session') {
    const { verifier, challenge } = generateVerifierAndChallenge()
    return { verifier, clientChallenge: challenge }
  }
  if (!clientChallenge) throw new E_ACCOUNT_KIT_INVALID_INPUT('Client challenge is required')
  return { verifier: null, clientChallenge }
}

/** Session flows redeem the handoff in-request; token flows return the code for `auth.oauth.token`. */
async function finishHandoff<Credential>({
  context,
  social,
  guard,
  extension,
  methodsEnabled,
  result,
  saved,
}: Omit<SocialRequest<Credential>, 'name'> & {
  result: SocialCallbackResult
  saved: SessionSocialState | null
}): Promise<unknown> {
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
  return response.ok(projectSocialCallbackResult(result))
}

const completeOAuthCallback: SocialHandler = async ({
  name,
  context,
  social,
  guard,
  extension,
  methodsEnabled,
}) => {
  const { request, params } = context
  const provider = requireEnabledProviderName(params.provider, extension.providers)
  const isPost = name === 'auth.oauth.complete'
  const providerCode = request.input('code')
  if (request.input('error') || typeof providerCode !== 'string' || !providerCode)
    throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const input = isPost
    ? await request.validateUsing(socialCallbackValidator)
    : {
        state: request.input('state') as string,
        intent: undefined,
      }
  if (typeof input.state !== 'string') throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  if (isPost && input.intent && !isSocialIntent(input.intent))
    throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const saved = guard.strategy === 'session' ? requireSessionState(context, input.state) : null
  if (saved && saved.provider !== provider) throw new E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID()
  const intent = saved?.intent ?? (input.intent as SocialIntent | undefined) ?? 'login'
  const current: CurrentAccountInput | undefined =
    intent === 'login' || intent === 'confirm' ? undefined : await guard.current(context)
  const result = await social.callback({
    state: input.state,
    provider,
    intent,
    current,
    callback: context,
    admit: extension.admit,
  })
  if (saved) {
    forgetSessionState(context, input.state)
    // The continuation gets a fresh lifetime, like its database row; it does not inherit begin's.
    if ('continuation' in result && result.continuation)
      rememberSessionState(context, result.continuation, {
        verifier: saved.verifier,
        intent: saved.intent,
        provider: saved.provider,
      })
  }
  return finishHandoff({ context, social, guard, extension, methodsEnabled, result, saved })
}

const socialHandlers = {
  ...managedSocialAccountHandlers,
  'auth.oauth.redirect': async ({ context, social, guard, extension }) => {
    const { request, response, params } = context
    const provider = requireEnabledProviderName(params.provider, extension.providers)
    const input = await request.validateUsing(socialBeginValidator)
    if (!isSocialBeginIntent(input.intent ?? 'login'))
      throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid social intent')
    if (input.purpose && !isSensitivePurpose(input.purpose))
      throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid social proof purpose')
    const intent = (input.intent ?? 'login') as SocialBeginInput['intent']
    const current = intent === 'login' ? undefined : await guard.current(context)
    const { verifier, clientChallenge } = resolveClientChallenge(guard, input.clientChallenge)
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
    const provider = requireEnabledProviderName(params.provider, extension.providers)
    const input = await request.validateUsing(socialConfirmationValidator)
    const { verifier, clientChallenge } = resolveClientChallenge(guard, input.clientChallenge)
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
  'auth.oauth.callback': completeOAuthCallback,
  'auth.oauth.complete': completeOAuthCallback,
  'auth.oauth.registration': async ({ context, social, guard, extension, methodsEnabled }) => {
    const input = await context.request.validateUsing(socialRegistrationValidator)
    const saved =
      guard.strategy === 'session' ? requireSessionState(context, input.continuation) : null
    const result = await social.completeRegistration({
      continuation: input.continuation,
      email: input.email,
      registrationData: input.registrationData,
      admit: extension.admit,
    })
    if (saved) forgetSessionState(context, input.continuation)
    return finishHandoff({ context, social, guard, extension, methodsEnabled, result, saved })
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
      isSocialProviderName(result.provider) &&
      extension.providers.includes(result.provider)
    )
      await rememberManagedMethod(context, result.provider, extension)
    return context.response.ok({
      account: result.account,
      token: guard.publicCredential!(result.credential),
    })
  },
} satisfies Partial<Record<ManagedEndpointName, SocialHandler>>

export type ManagedSocialEndpointName = keyof typeof socialHandlers

/** Dispatch only after the managed router has applied guard, CSRF, throttle and no-store policy. */
export async function executeManagedSocial<Credential>({
  name,
  methodsEnabled = true,
  ...request
}: Omit<SocialRequest<Credential>, 'name' | 'methodsEnabled'> & {
  name: ManagedSocialEndpointName
  methodsEnabled?: boolean
}): Promise<unknown> {
  return socialHandlers[name]({ ...request, name, methodsEnabled })
}

const executeManagedSocialRoute: ManagedHandler = ({
  route,
  context,
  kit,
  options,
  methodsEnabled,
}) =>
  executeManagedSocial({
    name: route.name as ManagedSocialEndpointName,
    context,
    social: kit.socialAuthentication,
    guard: options.guard,
    extension: options.extensions!.social!,
    methodsEnabled,
  })

/** The managed router's entries for every social endpoint, keyed like `socialHandlers`. */
export const managedSocialHandlers = Object.fromEntries(
  Object.keys(socialHandlers).map((name) => [name, executeManagedSocialRoute])
) as Record<ManagedSocialEndpointName, ManagedHandler>
