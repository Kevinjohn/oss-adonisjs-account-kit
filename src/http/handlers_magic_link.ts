/** Managed handlers for the magic-link capability: request, link inspection and completion. */
import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError, InvalidTokenError } from '../errors.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import {
  invalidProof,
  issuedAccountBody,
  reportCommittedFailure,
  translate,
} from './response_helpers.js'
import { magicLinkCompleteValidator, magicLinkRequestValidator } from './validators.js'
import { newVerifier } from './pkce_verifier.js'
import { requireSession } from './session_access.js'

const verifierKey = 'accountKit.magicLink.verifier'

function session(context: HttpContext) {
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
      session(context)
      const issued = newVerifier()
      verifier = issued.verifier
      clientChallenge = issued.challenge
    }
    if (!clientChallenge) throw new InvalidInputError('Client challenge is required')
    try {
      await kit.magicLink.request({ email: input.email, clientKey: request.ip(), clientChallenge })
    } catch (error) {
      // Known and unknown addresses must answer alike, whatever failed after the commit.
      if (!reportCommittedFailure(context, route.name, error)) throw error
    }
    // Stored only once the link is issued: a refused request must not orphan the live link.
    if (verifier) session(context).put(verifierKey, verifier)
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
      : invalidProof(context, 'magicLink', options.extensions?.message),
  'auth.magicLink.complete': async ({ context, kit, options, representIssued }) => {
    const { request, response, params } = context
    const input = await request.validateUsing(magicLinkCompleteValidator)
    let verifier = input.verifier
    if (options.guard.strategy === 'session') {
      const stored = session(context).get(verifierKey)
      verifier = typeof stored === 'string' ? stored : undefined
    }
    if (!verifier) throw new InvalidTokenError()
    const result = await kit.magicLink.complete(
      { token: params.token, verifier },
      options.guard.forRequest(context)
    )
    // Kept after a failure: it only matches the one link issued with it, which is single use.
    if (options.guard.strategy === 'session') session(context).forget(verifierKey)
    return response.ok(await issuedAccountBody({ options, representIssued }, result))
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
