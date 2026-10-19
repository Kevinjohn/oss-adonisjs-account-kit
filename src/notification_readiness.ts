// Notification readiness: checks that account email will reach people in an environment.
import { createActionUrls, trustedOrigin, type ActionUrlOptions } from './action_urls.js'
import type { Capability, UrlCallbacks } from './types.js'

/**
 * What `notificationReadiness` checks: environment, delivery mode, mail transport, origins, enabled
 * capabilities and page paths.
 */
export interface NotificationReadinessInput {
  /** The environment being checked. */
  environment: ActionUrlOptions['environment']
  /** The configured `delivery` mode. */
  delivery: 'best-effort' | 'durable' | 'capture'
  /** The application's selected AdonisJS Mail transport behavior. */
  transport: 'delivery' | 'capture' | 'discard'
  /** The API's public origin. */
  backendOrigin: string
  /** The frontend origin the links point at. */
  actionOrigin: string
  /** The enabled capabilities, to know which links are needed. */
  enabled: Capability[]
  /** The relative page path for each kind of link. */
  destinations: Partial<Record<keyof UrlCallbacks, string>>
  /** Application assertions; Account Kit cannot inspect an application-owned worker. */
  durableChecks?: {
    worker: boolean
    retries: boolean
    terminalFailures: boolean
    actionLinks: boolean
    securityNotices: boolean
  }
}

/**
 * Checks that account email will actually reach people in this environment. Returns `ready`, a
 * delivery classification, and the problems and notes to show an operator.
 */
export function notificationReadiness(input: NotificationReadinessInput) {
  const problems: string[] = []
  for (const [label, origin] of [
    ['backend', input.backendOrigin],
    ['action', input.actionOrigin],
  ]) {
    try {
      trustedOrigin(origin, input.environment)
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`)
    }
  }
  if (input.environment === 'production' && input.delivery === 'capture')
    problems.push('capture is development only and does not deliver to recipients')
  if (input.transport === 'discard')
    problems.push('discard transport does not deliver or capture account messages')
  if (input.transport === 'capture' && input.delivery !== 'capture')
    problems.push('capture transport requires capture delivery classification')
  if (input.transport === 'delivery' && input.delivery === 'capture')
    problems.push('capture delivery classification requires a capture transport')
  if (input.environment === 'production' && input.transport !== 'delivery')
    problems.push('production mail transport must deliver to recipients')
  if (
    input.delivery === 'durable' &&
    (!input.durableChecks?.worker ||
      !input.durableChecks.retries ||
      !input.durableChecks.terminalFailures ||
      !input.durableChecks.actionLinks ||
      !input.durableChecks.securityNotices)
  )
    problems.push(
      'durable delivery requires verified worker, retries, terminal failure reporting, action links and security notices'
    )
  const required: (keyof UrlCallbacks)[] = []
  if (input.enabled.includes('passwordReset')) required.push('passwordReset')
  if (input.enabled.includes('emailVerification') || input.enabled.includes('registration'))
    required.push('emailVerification')
  if (input.enabled.includes('invitations')) required.push('invitation')
  if (input.enabled.includes('emailPasswordManagement')) required.push('emailChange')
  if (input.enabled.includes('magicLinkLogin')) required.push('magicLink')
  for (const name of required)
    if (!input.destinations[name]) problems.push(`${name} destination is required`)
  try {
    createActionUrls({
      backendOrigin: input.backendOrigin,
      appFrontendUrl: input.actionOrigin,
      destinations: input.destinations,
      environment: input.environment,
    })
  } catch (error) {
    problems.push((error as Error).message)
  }
  const classification =
    input.transport === 'discard'
      ? 'discarded'
      : input.transport === 'capture'
        ? 'development capture'
        : input.delivery === 'durable'
          ? 'application declared durable'
          : 'best effort'
  const notes =
    classification === 'development capture'
      ? ['Captured for development; no message was delivered to a recipient.']
      : classification === 'discarded'
        ? ['Messages are discarded and cannot be recovered from this transport.']
        : input.delivery === 'durable'
          ? ['Verify application worker, retry, terminal failure and deduplication operations.']
          : [
              'Best effort has no package retry or crash recovery; diagnose failures and do not replay committed mutations.',
            ]
  return { ready: problems.length === 0, classification, problems, notes }
}
