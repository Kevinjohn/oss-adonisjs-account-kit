import type { HttpContext, Router } from '@adonisjs/core/http'
import type {} from '@adonisjs/core/providers/vinejs_provider'
import type { AccountKit } from '../account_kit.js'
import {
  DeliveryError,
  EmailAlreadyRegisteredError,
  InvalidInputError,
  InvalidTokenError,
  PostCommitError,
} from '../errors.js'
import type {
  AccountUser,
  AuthenticationGuard,
  CurrentAccount,
  CurrentAccountInput,
} from '../types.js'
import {
  managedErrorResponse,
  proofHeaders,
  type ManagedErrorResponse,
  type ManagedMessage,
} from './responses.js'
import {
  assertManagedRouteCollisions,
  planManagedRoutes,
  type ManagedCapability,
  type ManagedEndpointName,
  type ManagedRoute,
} from './routes.js'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationSendValidator,
  loginValidator,
  passwordChangeValidator,
  passwordResetCompleteValidator,
  passwordResetRequestValidator,
  profileUpdateValidator,
  signupValidator,
} from './validators.js'

export interface ManagedGuard<Credential> {
  strategy: 'session' | 'access_tokens'
  name: string
  /** Construct the existing selected guard's service adapter for this request. */
  forRequest(context: HttpContext): AuthenticationGuard<Credential>
  /** Authenticate through that guard and return its trusted token id or session revision. */
  current(context: HttpContext): Promise<CurrentAccountInput>
  /** Return the current credential for bearer logout; sessions may omit this callback. */
  logoutCredential?(context: HttpContext): Promise<Credential>
  /** Expose only the opaque bearer value after successful token issuance. */
  publicCredential?(credential: Credential): string
}

export interface ManagedExtensions {
  /** Public wording only; the stable status and machine code cannot be changed. */
  message?: ManagedMessage
  registration?: {
    /** HTTP schema; field mapping and domain rules remain in the public registration service. */
    validate(context: HttpContext): Promise<{
      email: string
      password: string
      registrationData?: unknown
    }>
  }
  invitationAcceptance?: {
    validate(context: HttpContext): Promise<{ password: string; registrationData?: unknown }>
  }
  profile?: {
    validate(context: HttpContext): Promise<{
      currentPassword: string
      email?: string
      registrationData?: unknown
    }>
  }
  /** After service reads; output is application-owned public data and must exclude secrets. */
  representAccount?(
    account: CurrentAccount,
    context: HttpContext
  ): Promise<Record<string, unknown>> | Record<string, unknown>
}

export interface ManagedRoutesOptions<Credential> {
  prefix: string
  kit(): Promise<AccountKit>
  guard: ManagedGuard<Credential>
  enabled: readonly ManagedCapability[]
  except?: readonly ManagedEndpointName[]
  /** Require verified email on active routes; defaults to true. Guard and revision checks always apply. */
  verificationRequired?: boolean
  extensions?: ManagedExtensions
}

const mounted = new WeakSet<Router>()

function invitationId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid invitation ID')
  return id
}

function responseHeaders(context: HttpContext, route: ManagedRoute): void {
  if (!route.proof) return
  for (const [name, value] of Object.entries(proofHeaders())) context.response.header(name, value)
}

function applyMappedHeaders(context: HttpContext, mapped: ManagedErrorResponse): void {
  for (const [name, value] of Object.entries(mapped.headers)) {
    if (name.toLowerCase() !== 'vary') {
      context.response.header(name, value)
      continue
    }
    const existing = context.response.getHeader('Vary')
    const terms = existing
      ? String(existing)
          .split(',')
          .map((term) => term.trim())
      : []
    if (terms.includes('*')) continue
    if (!terms.some((term) => term.toLowerCase() === 'accept')) terms.push('Accept')
    context.response.header('Vary', terms.join(', '))
  }
  context.response.header('Content-Type', mapped.contentType)
}

function invalidProof(
  context: HttpContext,
  proof: 'password' | 'email' | 'invitation',
  message?: ManagedMessage
): unknown {
  const mapped = managedErrorResponse(new InvalidTokenError(), {
    proof,
    accept: context.request.header('accept'),
    message,
  })!
  applyMappedHeaders(context, mapped)
  return context.response.status(mapped.status).send(mapped.body)
}

function passwordPolicyError(context: HttpContext, field: 'password' | 'newPassword'): unknown {
  return context.response.status(422).send({
    errors: [{ field, rule: 'passwordPolicy', message: 'Password does not meet the policy.' }],
  })
}

function safeAccount(account: CurrentAccount): Record<string, unknown> {
  return {
    id: account.id,
    email: account.email,
    unverifiedEmail: account.unverifiedEmail,
    hasPassword: account.hasPassword,
    active: account.active,
  }
}

function currentAccount(user: AccountUser): CurrentAccount {
  return {
    id: user.id,
    email: user.email,
    unverifiedEmail: user.unverifiedEmail,
    hasPassword: user.hasPassword,
    active: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
  }
}

function recoveryDiagnostic(
  context: HttpContext,
  operation: ManagedEndpointName,
  outcome: 'delivery_failed' | 'followup_failed' | 'authentication_failed' | 'representation_failed'
): void {
  context.logger?.warn({ operation, outcome }, 'Managed account operation needs reconciliation')
}

async function execute<Credential>(
  route: ManagedRoute,
  context: HttpContext,
  options: ManagedRoutesOptions<Credential>
): Promise<unknown> {
  responseHeaders(context, route)
  const { request, response, params } = context
  const csrfToken = (request as typeof request & { csrfToken?: string }).csrfToken
  if (
    options.guard.strategy === 'session' &&
    (route.method !== 'GET' || route.name === 'auth.csrf') &&
    typeof csrfToken !== 'string'
  )
    throw new Error('Managed session routes require Shield CSRF middleware')
  const kit = await options.kit()
  kit.managedHttp.assertGuard(options.guard)
  if (route.proof) await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
  const accountInput = route.access === 'public' ? undefined : await options.guard.current(context)
  const account = accountInput
    ? route.access === 'active' && options.verificationRequired !== false
      ? await kit.authentication.requireActive(accountInput)
      : await kit.authentication.current(accountInput)
    : undefined
  const actorId = account?.id
  const represent = (value: CurrentAccount) =>
    options.extensions?.representAccount?.(value, context) ?? safeAccount(value)
  const representIssued = async (value: CurrentAccount) => {
    try {
      return await represent(value)
    } catch {
      recoveryDiagnostic(context, route.name, 'representation_failed')
      return safeAccount(value)
    }
  }

  switch (route.name) {
    case 'auth.csrf':
      return response.ok({ csrfToken })
    case 'auth.login': {
      const { email, password } = await request.validateUsing(loginValidator)
      const result = await kit.authentication.login(
        { email, password, clientKey: request.ip() },
        options.guard.forRequest(context)
      )
      return response.ok({
        account: await representIssued(result.account),
        ...(options.guard.strategy === 'access_tokens'
          ? { token: options.guard.publicCredential!(result.credential) }
          : {}),
      })
    }
    case 'account.logout':
      await kit.authentication.logout(
        options.guard.forRequest(context),
        await options.guard.logoutCredential?.(context)
      )
      return response.noContent()
    case 'account.profile.show':
      return response.ok({ account: await represent(account!) })
    case 'auth.passwordReset.request': {
      const { email } = await request.validateUsing(passwordResetRequestValidator)
      try {
        await kit.passwordReset.request({ email, clientKey: request.ip() })
      } catch (error) {
        if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
        recoveryDiagnostic(
          context,
          route.name,
          error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
        )
      }
      return response.accepted({ message: 'If the account exists, instructions will be sent.' })
    }
    case 'auth.passwordReset.inspect':
      return (await kit.passwordReset.inspect({ token: params.token }))
        ? response.ok({ valid: true })
        : invalidProof(context, 'password', options.extensions?.message)
    case 'auth.passwordReset.complete': {
      const { password } = await request.validateUsing(passwordResetCompleteValidator)
      if (!kit.managedHttp.passwordAllowed(password))
        return passwordPolicyError(context, 'password')
      await kit.passwordReset.reset({ token: params.token, password })
      return response.ok({ reset: true })
    }
    case 'auth.invitation.inspect': {
      const preview = await kit.invitations.inspect({ token: params.token })
      return preview
        ? response.ok(preview)
        : invalidProof(context, 'invitation', options.extensions?.message)
    }
    case 'auth.invitation.accept': {
      const input = options.extensions?.invitationAcceptance
        ? await options.extensions.invitationAcceptance.validate(context)
        : await request.validateUsing(invitationAcceptValidator)
      if (!kit.managedHttp.passwordAllowed(input.password))
        return passwordPolicyError(context, 'password')
      const user = await kit.invitations.accept({
        token: params.token,
        password: input.password,
        registrationData: 'registrationData' in input ? input.registrationData : undefined,
      })
      return response.created({ account: await representIssued(currentAccount(user)) })
    }
    case 'account.password.change': {
      const { currentPassword, newPassword } = await request.validateUsing(passwordChangeValidator)
      if (!kit.managedHttp.passwordAllowed(newPassword))
        return passwordPolicyError(context, 'newPassword')
      await kit.emailPasswordManagement.changePassword({
        actorId: actorId!,
        currentPassword,
        newPassword,
      })
      return response.ok({ changed: true })
    }
    case 'account.emailVerification.send': {
      const result = await kit.emailVerification.send({ userId: actorId! })
      return response.ok({ result })
    }
    case 'account.invitation.send': {
      const { email, role } = await request.validateUsing(invitationSendValidator)
      const invitation = await kit.invitations.send({ actorId: actorId!, email, role })
      return response.created({ id: invitation.id })
    }
    case 'account.invitation.list': {
      const { limit, cursor } = await request.validateUsing(invitationListValidator)
      return response.ok(await kit.invitations.list({ actorId: actorId!, limit, cursor }))
    }
    case 'account.invitation.resend': {
      const invitation = await kit.invitations.resend({
        actorId: actorId!,
        invitationId: invitationId(params.id),
      })
      return response.ok({ id: invitation.id })
    }
    case 'account.invitation.revoke':
      await kit.invitations.revoke({ actorId: actorId!, invitationId: invitationId(params.id) })
      return response.noContent()
    default:
      return executePending(route, context, options, kit, actorId, representIssued)
  }
}

async function executePending<Credential>(
  route: ManagedRoute,
  context: HttpContext,
  options: ManagedRoutesOptions<Credential>,
  kit: AccountKit,
  actorId: CurrentAccount['id'] | undefined,
  representIssued: (value: CurrentAccount) => Promise<Record<string, unknown>>
): Promise<unknown> {
  const { request, response, params } = context
  switch (route.name) {
    case 'auth.signup': {
      kit.managedHttp.assertPublicRegistration()
      await kit.managedHttp.consume({ endpoint: route.name, clientKey: request.ip() })
      const input = options.extensions?.registration
        ? await options.extensions.registration.validate(context)
        : await request.validateUsing(signupValidator)
      if (!kit.managedHttp.passwordAllowed(input.password))
        return passwordPolicyError(context, 'password')
      try {
        await kit.registration.register({
          email: input.email,
          password: input.password,
          registrationData: 'registrationData' in input ? input.registrationData : undefined,
        })
      } catch (error) {
        if (error instanceof EmailAlreadyRegisteredError)
          return response.unprocessableEntity({
            errors: [
              { field: 'email', rule: 'unique', message: 'The email has already been taken.' },
            ],
          })
        if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
        recoveryDiagnostic(
          context,
          route.name,
          error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
        )
      }
      let result: { account: CurrentAccount; credential: Credential }
      try {
        result = await kit.authentication.login(
          { email: input.email, password: input.password, clientKey: request.ip() },
          options.guard.forRequest(context)
        )
      } catch {
        recoveryDiagnostic(context, route.name, 'authentication_failed')
        return response.created({ registered: true, authenticated: false })
      }
      return response.created({
        account: await representIssued(result.account),
        ...(options.guard.strategy === 'access_tokens'
          ? { token: options.guard.publicCredential!(result.credential) }
          : {}),
      })
    }
    case 'auth.emailVerification.inspect':
      return (await kit.emailVerification.inspect({ token: params.token }))
        ? response.ok({ valid: true })
        : invalidProof(context, 'email', options.extensions?.message)
    case 'auth.emailVerification.complete': {
      const { password } = await request.validateUsing(passwordResetCompleteValidator)
      if (!kit.managedHttp.passwordAllowed(password))
        return passwordPolicyError(context, 'password')
      await kit.emailVerification.complete({ token: params.token, password })
      return response.ok({ verified: true })
    }
    case 'auth.emailChange.inspect':
      return (await kit.emailPasswordManagement.inspectEmailChange({ token: params.token }))
        ? response.ok({ valid: true })
        : invalidProof(context, 'email', options.extensions?.message)
    case 'auth.emailChange.complete': {
      const user = await kit.emailPasswordManagement.completeEmailChange({ token: params.token })
      return response.ok({ account: await representIssued(currentAccount(user)) })
    }
    case 'account.profile.update': {
      const input = options.extensions?.profile
        ? await options.extensions.profile.validate(context)
        : await request.validateUsing(profileUpdateValidator)
      const user = await kit.emailPasswordManagement.updateProfile({
        actorId: actorId!,
        currentPassword: input.currentPassword,
        email: input.email,
        ...('registrationData' in input ? { registrationData: input.registrationData } : {}),
      })
      return response.ok({ account: await representIssued(currentAccount(user)) })
    }
    default:
      throw new Error(`Unhandled managed endpoint: ${route.name}`)
  }
}

/** Explicitly register one selected managed route group. Never called by the package root. */
export function registerManagedRoutes<Credential>(
  router: Router,
  options: ManagedRoutesOptions<Credential>
): readonly ManagedRoute[] {
  if (router.commited)
    throw new Error('Managed routes must be registered before the router commits')
  if (
    options.guard.strategy === 'access_tokens' &&
    options.enabled.some(
      (capability) => capability === 'authentication' || capability === 'registration'
    ) &&
    !options.guard.publicCredential
  )
    throw new Error('Managed access-token routes require publicCredential')
  const existing = (router.toJSON().root ?? []).flatMap((route) =>
    route.methods.map((method) => ({ method, path: route.pattern, name: route.name }))
  )
  const routes = planManagedRoutes(
    {
      prefix: options.prefix,
      strategy: options.guard.strategy,
      enabled: options.enabled,
      except: options.except,
    },
    existing,
    mounted.has(router)
  )
  for (const route of routes) {
    router
      .route(route.path, [route.method], async (context) => {
        try {
          return await execute(route, context, options)
        } catch (error) {
          if (
            route.method !== 'GET' &&
            (error instanceof PostCommitError || error instanceof DeliveryError)
          ) {
            recoveryDiagnostic(
              context,
              route.name,
              error instanceof DeliveryError ? 'delivery_failed' : 'followup_failed'
            )
            return context.response.accepted({ committed: true })
          }
          const mapped = managedErrorResponse(error, {
            accept: context.request.header('accept'),
            message: options.extensions?.message,
            proof: route.proof
              ? route.name.includes('passwordReset')
                ? 'password'
                : route.name.includes('invitation')
                  ? 'invitation'
                  : 'email'
              : undefined,
          })
          if (!mapped) throw error
          applyMappedHeaders(context, mapped)
          return context.response.status(mapped.status).send(mapped.body)
        }
      })
      .as(`accountKit.${route.name}`)
  }
  // Adonis exposes queued route definitions through toJSON only after commit. The
  // lifecycle wrapper rejects ambiguous application routes before the server starts.
  const commit = router.commit
  router.commit = function (this: Router, ...args: Parameters<Router['commit']>) {
    const result = commit.apply(this, args)
    const committed = (this.toJSON().root ?? []).flatMap((item) =>
      item.methods.map((method) => ({ method, path: item.pattern, name: item.name }))
    )
    assertManagedRouteCollisions(routes, committed)
    return result
  }
  mounted.add(router)
  return routes
}
