import { test } from '@japa/runner'
import type * as Http from '../http/main.ts'
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session'
import type * as Auth from '../auth/main.ts'
import type * as AuthTypes from '../src/types_auth.ts'
import type * as AccountKit from '../index.ts'
import type * as Admission from '../src/admission/main.ts'
import type * as Commands from '../src/define_commands.ts'
import type * as Types from '../src/types.ts'
import type * as Transaction from '../transaction/main.ts'

test('exposes account mail and link types through the central types entry point', ({
  expectTypeOf,
}) => {
  expectTypeOf<Types.ActionUrlOptions>().toEqualTypeOf<AccountKit.ActionUrlOptions>()
  expectTypeOf<Types.RenderedAccountMessage>().toEqualTypeOf<AccountKit.RenderedAccountMessage>()
  expectTypeOf<Types.MailNotificationOptions>().toEqualTypeOf<AccountKit.MailNotificationOptions>()
  expectTypeOf<Types.NotificationReadinessInput>().toEqualTypeOf<AccountKit.NotificationReadinessInput>()
})

test('shares central types with the admission, command and transaction entry points', ({
  expectTypeOf,
}) => {
  expectTypeOf<Types.AdmissionDependencies>().toEqualTypeOf<Admission.AdmissionDependencies>()
  expectTypeOf<Types.AdmissionDecision>().toEqualTypeOf<Admission.AdmissionDecision>()
  expectTypeOf<Types.AdmissionPage>().toEqualTypeOf<Admission.AdmissionPage>()
  expectTypeOf<Types.AccountKitCommandsLoader>().toEqualTypeOf<Commands.AccountKitCommandsLoader>()
  expectTypeOf<Types.DialectSource>().toEqualTypeOf<Transaction.DialectSource>()
})

test('shares managed HTTP route, guard, OpenAPI and endpoint types with the HTTP entry point', ({
  expectTypeOf,
}) => {
  expectTypeOf<Types.ManagedRoute>().toEqualTypeOf<Http.ManagedRoute>()
  expectTypeOf<Types.ExistingRoute>().toEqualTypeOf<Http.ExistingRoute>()
  expectTypeOf<Types.ManagedOpenApiInput>().toEqualTypeOf<Http.ManagedOpenApiInput>()
  expectTypeOf<Types.OpenApiDocument>().toEqualTypeOf<Http.OpenApiDocument>()
  expectTypeOf<Types.ManagedRoutesOptions<Types.ManagedTokenCredential>>().toEqualTypeOf<
    Http.ManagedRoutesOptions<Http.ManagedTokenCredential>
  >()
  expectTypeOf<Types.ManagedSessionConfiguration>().toEqualTypeOf<Http.ManagedSessionConfiguration>()
  expectTypeOf<Types.ManagedRequestBody<'account.invitation.send'>>().toEqualTypeOf<
    Http.ManagedRequestBody<'account.invitation.send'>
  >()
  expectTypeOf<Types.ManagedQuery<'account.invitation.list'>>().toEqualTypeOf<
    Http.ManagedQuery<'account.invitation.list'>
  >()
  expectTypeOf<Types.ManagedSuccessBody<'account.invitation.list'>>().toEqualTypeOf<
    Http.ManagedSuccessBody<'account.invitation.list'>
  >()
  expectTypeOf<Types.ManagedErrorBody>().toEqualTypeOf<Http.ManagedErrorBody>()
  expectTypeOf<Types.ManagedMessage>().toEqualTypeOf<Http.ManagedMessage>()
})

test('shares the optional session guard type with the auth entry point', ({ expectTypeOf }) => {
  expectTypeOf<
    AuthTypes.AccountKitSessionGuard<SessionUserProviderContract<unknown>>
  >().toEqualTypeOf<Auth.AccountKitSessionGuard<SessionUserProviderContract<unknown>>>()
})
