import type { HttpContext } from '@adonisjs/core/http'
import type { AccountKit } from '../account_kit.js'
import { InvalidInputError } from '../errors.js'
import { isSensitivePurpose } from '../social_enums.js'
import type { SensitivePurpose, SocialProviderName } from '../types.js'
import type { ManagedGuard } from './managed_types.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedSocialExtension } from './social.js'
import { socialPasswordProofValidator, socialUnlinkValidator } from './validators.js'
import { positiveId } from './positive_id.js'
import { optionalSession } from './session_access.js'

export interface SocialRequest<Credential> {
  name: ManagedEndpointName
  context: HttpContext
  social: AccountKit['socialAuthentication']
  guard: ManagedGuard<Credential>
  extension: ManagedSocialExtension
  methodsEnabled: boolean
}
export type SocialHandler = <Credential>(request: SocialRequest<Credential>) => Promise<unknown>

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

export const managedSocialAccountHandlers = {
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
  'account.socialProof.password': async ({ context, social, guard }) => {
    const input = await context.request.validateUsing(socialPasswordProofValidator)
    if (!isSensitivePurpose(input.purpose))
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
      identityId: positiveId(context.params.id, 'identity'),
      proof: input.proof,
    })
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, SocialHandler>>
