import { channel } from 'node:diagnostics_channel'
import { DeliveryError, PostCommitError } from 'adonisjs-account-kit'

type SafeLogger = { error: (details: object, message: string) => void }
type Failure = 'delivery' | 'post_commit' | 'credential_establishment'

export const followUpFailureChannel = channel('account_kit.reference.follow_up_failure')

function reportFailure(logger: SafeLogger, operation: string, failure: Failure) {
  const details = { event: 'account_kit_follow_up_failed', operation, failure }
  logger.error(details, 'Account operation committed but a follow-up failed')
  followUpFailureChannel.publish(details)
}

/** Report follow-up failures without recording an address, proof, credential, or raw exception. */
export function reportCommittedFailure(
  logger: SafeLogger,
  error: DeliveryError | PostCommitError,
  operation: string
) {
  reportFailure(logger, operation, error instanceof DeliveryError ? 'delivery' : 'post_commit')
}

/**
 * Run an operation whose data change commits before its follow-up work. A delivery or post-commit
 * failure is reported and resolves to `undefined`, because the change itself succeeded; every other
 * error is rethrown.
 */
export async function committedFollowUp<T>(
  logger: SafeLogger,
  operation: string,
  run: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
    reportCommittedFailure(logger, error, operation)
    return undefined
  }
}

export function reportCredentialEstablishmentFailure(logger: SafeLogger, operation: string) {
  reportFailure(logger, operation, 'credential_establishment')
}
