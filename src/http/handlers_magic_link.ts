/** Managed handlers for the magic-link capability: request, link inspection and completion. */
import type { HttpContext } from '@adonisjs/core/http'
import {
  E_ACCOUNT_KIT_CLIENT_CHALLENGE_REQUIRED,
  E_ACCOUNT_KIT_MAGIC_LINK_VERIFIER_REQUIRED,
} from '../errors.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import {
  sendInvalidProofResponse,
  renderIssuedAccountBody,
  reportCommittedFailure,
  translate,
} from './response_helpers.js'
import { magicLinkCompleteValidator, magicLinkRequestValidator } from './validators.js'
import { deriveClientChallenge } from '../client_challenge.js'
import {
  resolveMagicLinkVerifier,
  acknowledgeMagicLink,
  consumeMagicLink,
} from './magic_link_session.js'
import { requireSession } from './session_access.js'

function requireMagicLinkSession(context: HttpContext) {
  return requireSession(
    context,
    'Managed magic links require persistent AdonisJS session middleware'
  )
}

export const magicLinkHandlers = {
  /** Session guards keep the verifier server-side, so the link works in any tab of that browser. */
  'auth.magicLink.request': async ({ route, context, kit, options }) => {
    const { request, response } = context
    const input = await request.validateUsing(magicLinkRequestValidator)
    let clientChallenge = input.clientChallenge
    let verifier: string | undefined
    if (options.guard.strategy === 'session') {
      // Checked before the request so a missing session refuses the call without issuing a link.
      verifier = resolveMagicLinkVerifier(requireMagicLinkSession(context))
      clientChallenge = deriveClientChallenge(verifier)
    }
    if (!clientChallenge) throw new E_ACCOUNT_KIT_CLIENT_CHALLENGE_REQUIRED()
    try {
      await kit.magicLink.request({ email: input.email, clientKey: request.ip(), clientChallenge })
    } catch (error) {
      // Known and unknown addresses must answer alike, whatever failed after the commit.
      if (!reportCommittedFailure(context, route.name, error)) throw error
    }
    // Stored only once the link is issued: a refused request must not orphan the live link.
    if (verifier)
      acknowledgeMagicLink(
        requireMagicLinkSession(context),
        verifier,
        kit.managedHttp.magicLinkExpiresAt()
      )
    return response.accepted({
      message: translate(
        context,
        'account_kit.magic_link_requested',
        'If the account exists, a sign-in link will be sent.'
      ),
    })
  },
  'auth.magicLink.inspect': async ({ context, kit, options }) =>
    (await kit.magicLink.inspect({ token: context.params.token }))
      ? context.response.ok({ valid: true })
      : sendInvalidProofResponse(context, 'magicLink', options.extensions?.message),
  'auth.magicLink.complete': async ({ context, kit, options, representIssued }) => {
    const { request, response, params } = context
    const input = await request.validateUsing(magicLinkCompleteValidator)
    let verifier = input.verifier
    if (options.guard.strategy === 'session') {
      verifier = resolveMagicLinkVerifier(requireMagicLinkSession(context), false)
    }
    if (!verifier) throw new E_ACCOUNT_KIT_MAGIC_LINK_VERIFIER_REQUIRED()
    const result = await kit.magicLink.complete(
      { token: params.token, verifier },
      options.guard.forRequest(context)
    )
    // Failed or replayed completions leave other outstanding links usable.
    if (options.guard.strategy === 'session') consumeMagicLink(requireMagicLinkSession(context))
    return response.ok(await renderIssuedAccountBody({ options, representIssued }, result))
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
