import { test } from '@japa/runner'
import { DeliveryError, PostCommitError } from '@kevinjohn/adonisjs-account-kit'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

test('committed follow-up diagnostics omit private error details', async ({ assert }) => {
  const reported: Array<{ details: object; message: string }> = []
  const logger = {
    error(details: object, message: string) {
      reported.push({ details, message })
    },
  }
  reportCommittedFailure(
    logger,
    new DeliveryError('secret proof and recipient@example.test'),
    'password_reset.request'
  )
  reportCommittedFailure(
    logger,
    new PostCommitError('secret proof and recipient@example.test'),
    'password_reset.complete'
  )
  assert.deepEqual(reported, [
    {
      details: {
        event: 'account_kit_follow_up_failed',
        operation: 'password_reset.request',
        failure: 'delivery',
      },
      message: 'Account operation committed but a follow-up failed',
    },
    {
      details: {
        event: 'account_kit_follow_up_failed',
        operation: 'password_reset.complete',
        failure: 'post_commit',
      },
      message: 'Account operation committed but a follow-up failed',
    },
  ])
})

test('committed follow-up diagnostics rethrow unexpected errors without reporting them', async ({
  assert,
}) => {
  const reported: Array<{ details: object; message: string }> = []
  const logger = {
    error(details: object, message: string) {
      reported.push({ details, message })
    },
  }
  const unexpected = new Error('unrelated failure')
  let caught: unknown

  try {
    reportCommittedFailure(logger, unexpected, 'account_password.change')
  } catch (error) {
    caught = error
  }

  assert.equal(caught, unexpected)
  assert.deepEqual(reported, [])
})
