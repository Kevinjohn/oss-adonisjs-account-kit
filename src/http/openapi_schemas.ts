/**
 * OpenAPI schemas for every managed endpoint: request bodies, queries and success responses.
 * The record is keyed by `ManagedEndpointName`, so a route added without schemas does not compile.
 * Request schemas mirror `validators.ts`; cross-field rules are described in text.
 */
import { sensitivePurposes } from '../social_enums.js'
export interface EndpointResponse {
  description: string
  /** Omitted for responses without a body. */
  schema?: JsonSchema
}

export interface EndpointQueryParameter {
  name: string
  required?: boolean
  description?: string
  schema: JsonSchema
}

export interface EndpointSchemas {
  summary: string
  description?: string
  body?: (strategy: Strategy) => JsonSchema
  query?: EndpointQueryParameter[]
  success: (strategy: Strategy) => Record<number, EndpointResponse>
  /** The endpoint can report a conflict with existing account state (409). */
  conflict?: true
  /** A public endpoint that authenticates its caller: a failed sign-in is a 401 or 403. */
  authenticates?: true
  /** A public endpoint that can refuse the caller (403) without authenticating them. */
  forbidden?: true
  /** A public endpoint that also authenticates the caller for `link` and `reauth` intents. */
  optionalAuth?: true
  /**
   * The provider redirects the browser here: the GET carries the session cookie but never a
   * bearer token, and it can commit changes.
   */
  providerCallback?: true
  /** Success responses carry `Cache-Control: no-store`. */
  noStore?: true
}

import {
  accountBody,
  authorizationUrl,
  body,
  clientChallenge,
  closed,
  confirmed,
  constant,
  email,
  nonEmpty,
  ok,
  password,
  policyNote,
  ref,
  registrationData,
  socialFlow,
  string,
  valid,
  noContent,
} from './openapi_primitives.js'
export { ref } from './openapi_primitives.js'
import type { JsonSchema } from './openapi_types.js'
import type { ManagedEndpointName } from './routes.js'

type Strategy = 'session' | 'access_tokens'

export const managedEndpointSchemas: Record<ManagedEndpointName, EndpointSchemas> = {
  'auth.signup': {
    summary: 'Register with email and password, then sign in',
    description: `${policyNote} An email that is already registered is reported as a 422 \`unique\` error on \`email\`.`,
    body: () =>
      body(
        {
          email: email(),
          password: password(),
          passwordConfirmation: confirmed('password'),
          registrationData: registrationData(),
        },
        ['email', 'password', 'passwordConfirmation']
      ),
    success: (strategy) => ({
      201: {
        description:
          'Registered. When sign-in after registration fails, the body reports `authenticated: false`.',
        schema: {
          oneOf: [
            accountBody(strategy, 'optional'),
            closed({ registered: constant(true), authenticated: constant(false) }),
          ],
        },
      },
    }),
    forbidden: true,
  },
  'auth.csrf': {
    summary: 'Read the CSRF token for session requests',
    success: ok('CSRF token for the `X-CSRF-TOKEN` header.', closed({ csrfToken: string() })),
    noStore: true,
  },
  'auth.login': {
    summary: 'Sign in with email and password',
    body: () => body({ email: email(), password: string() }, ['email', 'password']),
    success: (strategy) => ({
      200: { description: 'Signed in.', schema: accountBody(strategy, 'required') },
    }),
    authenticates: true,
  },
  'auth.passwordReset.request': {
    summary: 'Request a password-reset email',
    description: 'The response is the same whether or not an account uses the address.',
    body: () => body({ email: email() }, ['email']),
    success: () => ({
      202: {
        description: 'Accepted. Instructions are sent when the account exists.',
        schema: closed({ message: string() }),
      },
    }),
  },
  'auth.passwordReset.inspect': {
    summary: 'Check a password-reset link',
    success: valid,
  },
  'auth.passwordReset.complete': {
    summary: 'Set a new password from a reset link',
    description: policyNote,
    body: () =>
      body({ password: password(), passwordConfirmation: confirmed('password') }, [
        'password',
        'passwordConfirmation',
      ]),
    success: ok('Password reset.', closed({ reset: constant(true) })),
  },
  'auth.emailVerification.inspect': {
    summary: 'Check an email-verification link',
    success: valid,
  },
  'auth.emailVerification.complete': {
    summary: 'Verify the email address and set a password',
    description: policyNote,
    body: () =>
      body({ password: password(), passwordConfirmation: confirmed('password') }, [
        'password',
        'passwordConfirmation',
      ]),
    success: ok('Email verified.', closed({ verified: constant(true) })),
  },
  'auth.invitation.inspect': {
    summary: 'Check an invitation link',
    success: ok('The invitation is valid.', closed({ email: string(), role: string() })),
  },
  'auth.invitation.accept': {
    summary: 'Accept an invitation and create the account',
    description: policyNote,
    body: () =>
      body(
        {
          password: password(),
          passwordConfirmation: confirmed('password'),
          registrationData: registrationData(),
        },
        ['password', 'passwordConfirmation']
      ),
    success: (strategy) => ({
      201: { description: 'Account created.', schema: accountBody(strategy, 'none') },
    }),
    conflict: true,
  },
  'auth.emailChange.inspect': {
    summary: 'Check an email-change link',
    success: valid,
  },
  'auth.emailChange.complete': {
    summary: 'Confirm an email change',
    success: (strategy) => ({
      200: { description: 'Email changed.', schema: accountBody(strategy, 'none') },
    }),
    conflict: true,
  },
  'account.logout': {
    summary: 'Sign out the current session or access token',
    success: noContent,
  },
  'account.profile.show': {
    summary: 'Read the signed-in account',
    success: ok('The signed-in account.', closed({ account: ref('Account') })),
  },
  'account.profile.update': {
    summary: 'Update the signed-in account',
    description:
      'Changing the email requires `currentPassword` or a `recentProof` for `email_change`.',
    body: () =>
      body(
        {
          currentPassword: nonEmpty(),
          recentProof: nonEmpty(),
          email: email(),
          registrationData: registrationData(),
        },
        []
      ),
    success: (strategy) => ({
      200: { description: 'Profile updated.', schema: accountBody(strategy, 'none') },
    }),
    conflict: true,
  },
  'account.password.change': {
    summary: 'Change the password',
    description: `Requires \`currentPassword\` or a \`recentProof\` for \`password_change\`. ${policyNote}`,
    body: () =>
      body(
        {
          currentPassword: nonEmpty(),
          recentProof: nonEmpty(),
          newPassword: password(),
          newPasswordConfirmation: confirmed('newPassword'),
        },
        ['newPassword', 'newPasswordConfirmation']
      ),
    success: ok('Password changed.', closed({ changed: constant(true) })),
  },
  'account.emailVerification.send': {
    summary: 'Send the email-verification link again',
    success: ok(
      'Sent, or the address is already verified.',
      closed({ result: { enum: ['sent', 'already_verified'] } })
    ),
  },
  'account.invitation.send': {
    summary: 'Invite someone by email',
    body: () =>
      body({ email: email(), role: string({ minLength: 1, maxLength: 64 }) }, ['email', 'role']),
    success: () => ({
      201: { description: 'Invitation sent.', schema: closed({ id: { type: 'integer' } }) },
    }),
    conflict: true,
  },
  'account.invitation.list': {
    summary: 'List pending invitations',
    query: [
      {
        name: 'limit',
        description: 'Page size.',
        schema: { type: 'integer', minimum: 1, maximum: 100 },
      },
      {
        name: 'cursor',
        description: 'The `nextCursor` of the previous page.',
        schema: string(),
      },
    ],
    success: ok('One page of invitations.', ref('InvitationPage')),
  },
  'account.invitation.resend': {
    summary: 'Resend an invitation with a new link',
    success: ok('Invitation resent.', closed({ id: { type: 'integer' } })),
  },
  'account.invitation.revoke': {
    summary: 'Revoke an invitation',
    success: noContent,
  },
  'auth.oauth.redirect': {
    summary: 'Start a social sign-in, link or re-authentication',
    description:
      '`link` and `reauth` require an authenticated caller. `reauth` issues a proof for `purpose`.',
    body: (strategy) =>
      body(
        {
          intent: { enum: ['login', 'link', 'reauth'] },
          purpose: { enum: [...sensitivePurposes] },
          proof: string(),
          clientChallenge: clientChallenge(strategy),
        },
        strategy === 'access_tokens' ? ['clientChallenge'] : []
      ),
    success: authorizationUrl,
    optionalAuth: true,
  },
  'auth.oauth.callback': {
    summary: 'Provider redirect target',
    description:
      'Session guards finish the flow here. Access-token guards accept only `login` here; other intents use the POST form. A `link` refused by `acceptLink` is a 403 `E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED`.',
    query: [
      { name: 'code', description: 'Provider authorisation code.', schema: string() },
      { name: 'state', description: 'Flow state from the redirect.', schema: string() },
      { name: 'error', description: 'Provider error; the flow fails.', schema: string() },
    ],
    success: socialFlow,
    conflict: true,
    optionalAuth: true,
    providerCallback: true,
  },
  'auth.oauth.complete': {
    summary: 'Finish a social flow from an access-token client',
    description: 'A `link` refused by `acceptLink` is a 403 `E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED`.',
    body: () =>
      body(
        {
          code: nonEmpty(),
          state: nonEmpty(),
          intent: { enum: ['login', 'link', 'reauth', 'confirm'] },
        },
        ['code', 'state']
      ),
    success: socialFlow,
    conflict: true,
    optionalAuth: true,
  },
  'auth.oauth.registration': {
    summary: 'Finish registration after a social sign-in',
    body: () =>
      body(
        {
          continuation: nonEmpty(),
          email: email(),
          registrationData: { description: 'Application-defined registration data.' },
        },
        ['continuation']
      ),
    success: socialFlow,
    conflict: true,
  },
  'auth.oauth.confirmation': {
    summary: 'Confirm a pending link with the provider',
    body: (strategy) =>
      body(
        { verificationToken: nonEmpty(), clientChallenge: clientChallenge(strategy) },
        strategy === 'access_tokens'
          ? ['verificationToken', 'clientChallenge']
          : ['verificationToken']
      ),
    success: authorizationUrl,
  },
  'auth.oauth.token': {
    summary: 'Exchange a social handoff code for an access token',
    body: () =>
      body({ code: nonEmpty(), verifier: string({ minLength: 43 }) }, ['code', 'verifier']),
    success: ok(
      'Signed in.',
      closed({
        account: ref('SafeAccount'),
        token: string({ description: 'Opaque bearer access token.' }),
      })
    ),
  },
  'auth.methods': {
    summary: 'List sign-in methods and the last one used on this device',
    success: ok(
      'Configured providers and the visitor-local hint.',
      closed({
        providers: { type: 'array', items: ref('SocialProvider') },
        lastUsedMethod: {
          anyOf: [constant('password'), ref('SocialProvider'), { type: 'null' }],
        },
      })
    ),
  },
  'account.socialProof.password': {
    summary: 'Prove the password for a sensitive social action',
    body: () =>
      body({ password: nonEmpty(), purpose: { enum: [...sensitivePurposes] } }, [
        'password',
        'purpose',
      ]),
    success: ok('Short-lived proof for `purpose`.', closed({ proof: string() })),
  },
  'account.socialIdentities.list': {
    summary: 'List linked social identities',
    success: ok(
      'Linked identities.',
      closed({
        identities: {
          type: 'array',
          items: closed({
            id: { type: 'integer' },
            provider: ref('SocialProvider'),
            email: { type: ['string', 'null'] },
            emailVerified: { type: 'boolean' },
          }),
        },
      })
    ),
  },
  'account.socialIdentities.unlink': {
    summary: 'Unlink a social identity',
    body: () => body({ proof: nonEmpty() }, ['proof']),
    success: noContent,
    conflict: true,
  },
  'auth.magicLink.request': {
    summary: 'Request a magic sign-in link',
    description:
      'The response is the same whether or not an account uses the address. Session guards bind the link to this session; access-token clients send `clientChallenge`.',
    body: (strategy) =>
      body({ email: email(), clientChallenge: clientChallenge(strategy) }, ['email']),
    success: () => ({
      202: {
        description: 'Accepted. A link is sent if the account exists.',
        schema: closed({ message: string() }),
      },
    }),
  },
  'auth.magicLink.inspect': {
    summary: 'Check a magic sign-in link without using it',
    success: valid,
  },
  'auth.magicLink.complete': {
    summary: 'Sign in with a magic link',
    description:
      'Consumes the link, also when a check fails. Session guards use the verifier held in the session.',
    body: (strategy) =>
      body(
        {
          verifier: string({
            description:
              strategy === 'access_tokens'
                ? 'The verifier whose S256 challenge was sent with the request. Required for access tokens.'
                : 'Ignored for session guards.',
          }),
        },
        []
      ),
    success: (strategy) => ({
      200: { description: 'Signed in.', schema: accountBody(strategy, 'required') },
    }),
  },
  'account.sessions.list': {
    summary: "List the account's sign-ins",
    success: ok(
      'Sign-ins, newest first.',
      closed({ sessions: { type: 'array', items: ref('SignIn') } })
    ),
  },
  'account.sessions.revoke': {
    summary: 'Sign out one sign-in',
    description: 'Revoking the current sign-in also ends this session or token.',
    success: noContent,
  },
  'account.sessions.revokeOthers': {
    summary: 'Sign out every other sign-in',
    success: ok('Signed out.', closed({ count: { type: 'integer', minimum: 0 } })),
  },
  'account.sessions.revokeAll': {
    summary: 'Sign out everywhere, including this sign-in',
    success: noContent,
  },
  'account.data.export': {
    summary: "Download the account's data",
    description:
      'Requires `currentPassword` or a `recentProof` for `account_export`. Sent as an attachment.',
    body: () => body({ currentPassword: nonEmpty(), recentProof: nonEmpty() }, []),
    success: ok('The export document.', ref('AccountExport')),
  },
  'account.delete': {
    summary: 'Delete the account permanently',
    description:
      'Requires `currentPassword` or a `recentProof` for `account_delete`. A session is ended; an access token is deleted with the account.',
    body: () => body({ currentPassword: nonEmpty(), recentProof: nonEmpty() }, []),
    success: noContent,
  },
}
export { sharedSchemas } from './openapi_components.js'
