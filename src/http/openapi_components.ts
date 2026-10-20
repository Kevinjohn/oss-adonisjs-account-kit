import type { JsonSchema } from './openapi_types.js'
import { closed, constant, ref, string } from './openapi_primitives.js'

/** Shared component schemas; `IssuedAccount`, `Account` and `SocialProvider` are added per document. */
export function sharedSchemas(): Record<string, JsonSchema> {
  const userId = { type: ['integer', 'string'] }
  const timestamp = string({ format: 'date-time' })
  const socialStatus = { enum: ['linked', 'new'] }
  return {
    SafeAccount: closed({
      id: userId,
      email: string(),
      unverifiedEmail: { type: ['string', 'null'] },
      hasPassword: { type: 'boolean' },
      active: { type: 'boolean' },
    }),
    ManagedCommittedSuccess: closed({ committed: constant(true) }),
    SignIn: closed({
      id: { type: 'integer' },
      label: { type: ['string', 'null'] },
      createdAt: timestamp,
      lastSeenAt: { type: ['string', 'null'], format: 'date-time' },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      current: { type: 'boolean' },
    }),
    AccountExport: closed(
      {
        format: constant('adonisjs-account-kit/export'),
        version: constant(1),
        generatedAt: timestamp,
        account: closed({
          id: userId,
          email: string(),
          unverifiedEmail: { type: ['string', 'null'] },
          emailVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
          hasPassword: { type: 'boolean' },
          credentialsChangedAt: { type: ['string', 'null'], format: 'date-time' },
        }),
        socialIdentities: { type: 'array', items: { type: 'object' } },
        invitationsSent: { type: 'array', items: { type: 'object' } },
        accessTokens: {
          type: 'array',
          items: { type: 'object' },
          description: 'Present only for the access-token strategy.',
        },
        pending: { type: 'object' },
        application: {
          description: "What the application's `exportAccountData` returned, or null.",
        },
      },
      [
        'format',
        'version',
        'generatedAt',
        'account',
        'socialIdentities',
        'invitationsSent',
        'pending',
        'application',
      ]
    ),
    ManagedErrorBody: closed({
      errors: {
        type: 'array',
        minItems: 1,
        items: closed({ code: string(), message: string(), field: string() }, ['code', 'message']),
      },
    }),
    ValidationErrorBody: closed({
      errors: {
        type: 'array',
        minItems: 1,
        items: closed(
          {
            field: string(),
            rule: string(),
            message: string(),
            meta: { type: 'object' },
            index: { type: 'integer' },
          },
          ['field', 'rule', 'message']
        ),
      },
    }),
    JsonApiErrorBody: closed({
      errors: {
        type: 'array',
        minItems: 1,
        items: {
          oneOf: [
            closed({ code: string(), title: string() }),
            closed(
              {
                code: string(),
                title: string(),
                source: closed({ pointer: string() }),
                meta: { type: 'object' },
              },
              ['code', 'title', 'source']
            ),
          ],
        },
      },
    }),
    Invitation: closed({
      id: { type: 'integer' },
      email: string(),
      role: string(),
      inviterId: { type: ['integer', 'string', 'null'] },
      expiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    InvitationPage: closed({
      items: { type: 'array', items: ref('Invitation') },
      nextCursor: { type: ['string', 'null'] },
    }),
    SocialFlowResult: {
      oneOf: [
        closed({ status: socialStatus, account: ref('SafeAccount') }),
        closed({
          status: socialStatus,
          code: string({ description: 'Handoff code for `auth/oauth/token`.' }),
        }),
        closed({ status: socialStatus }),
        closed({ status: constant('new'), continuation: string() }),
        closed({ status: constant('new'), emailVerificationRequired: constant(true) }),
        closed({ status: constant('link_required') }),
        closed({ status: constant('reauthenticated'), proof: string() }),
      ],
    },
  }
}
