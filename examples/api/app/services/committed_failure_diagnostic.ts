import { DeliveryError, type PostCommitError } from 'adonisjs-account-kit'

type SafeLogger = { error: (details: object, message: string) => void }

/** Report follow-up failures without recording an address, proof, credential, or raw exception. */
export function reportCommittedFailure(
  logger: SafeLogger,
  error: DeliveryError | PostCommitError,
  operation: string
) {
  logger.error(
    {
      event: 'account_kit_follow_up_failed',
      operation,
      failure: error instanceof DeliveryError ? 'delivery' : 'post_commit',
    },
    'Account operation committed but a follow-up failed'
  )
}
