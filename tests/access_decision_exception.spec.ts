import { test } from '@japa/runner'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { E_ACCOUNT_KIT_INVALID_ACCESS_DECISION } from '../src/errors.ts'
import { fakeManagedHttp } from './helpers/managed_http_fakes.ts'

test('the access decision exception renders a masked response through its framework handle', async ({
  assert,
}) => {
  const error = new E_ACCOUNT_KIT_INVALID_ACCESS_DECISION({ cause: new Error('private detail') })
  const context = fakeManagedHttp().context()
  let sent: { status: number; body: unknown } | undefined
  context.response.status = ((status: number) => ({
    send: (body: unknown) => {
      sent = { status, body }
    },
  })) as typeof context.response.status
  await error.handle(error, context)
  assert.instanceOf(error, RuntimeException)
  assert.deepEqual(sent, {
    status: 500,
    body: {
      errors: [{ code: 'E_ACCOUNT_KIT_OPERATION_FAILED', message: 'Account operation failed.' }],
    },
  })
  assert.equal(context.headers['Cache-Control'], 'no-store')
  assert.equal(context.headers['Content-Type'], 'application/json')
  assert.notInclude(JSON.stringify(sent), 'private detail')
})
