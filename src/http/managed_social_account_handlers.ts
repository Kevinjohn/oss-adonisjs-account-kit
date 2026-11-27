import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.ts'
import { E_ACCOUNT_KIT_INVALID_INPUT } from '../errors.ts'
import { isSensitivePurpose } from '../social_enums.ts'
import type { SensitivePurpose, SocialProviderName } from '../types.ts'
import type { ManagedGuard } from './managed_types.ts'
import type { ManagedEndpointName } from './routes.ts'
import type { ManagedSocialExtension } from './social.ts'
import { socialPasswordProofValidator, socialUnlinkValidator } from './validators.ts'
import { requirePositiveId } from './positive_id.ts'
import { getOptionalSession } from './session_access.ts'

export interface SocialRequest<Credential> {
  name: ManagedEndpointName
  context: HttpContext
  social: AccountKit['socialAuthentication']
  guard: ManagedGuard<Credential>
  extension: ManagedSocialExtension
  methodsEnabled: boolean
}
export type SocialHandler = <Credential>(request: SocialRequest<Credential>) => Promise<unknown>

function projectSocialIdentity(identity: {
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

export const managedSocialAccountHandlers = {
  'auth.methods': async ({ context, extension }) => {
    const stored = getOptionalSession(context)?.get('accountKit.social.lastUsedMethod')
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
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.socialProof.password': async ({ context, social, guard }) => {
    const input = await context.request.validateUsing(socialPasswordProofValidator)
    if (!isSensitivePurpose(input.purpose))
      throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid social proof purpose')
    const proof = await social.provePassword({
      current: await guard.current(context),
      password: input.password,
      purpose: input.purpose as SensitivePurpose,
    })
    return context.response.ok({ proof })
  },
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.socialIdentities.list': async ({ context, social, guard }) => {
    const identities = await social.list({ current: await guard.current(context) })
    return context.response.ok({ identities: identities.map(projectSocialIdentity) })
  },
  /** @throws {AggregateError} If transaction work and cleanup fail before a commit is confirmed. */
  'account.socialIdentities.unlink': async ({ context, social, guard }) => {
    const input = await context.request.validateUsing(socialUnlinkValidator)
    await social.unlink({
      current: await guard.current(context),
      identityId: requirePositiveId(context.params.id, 'identity'),
      proof: input.proof,
    })
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, SocialHandler>>
