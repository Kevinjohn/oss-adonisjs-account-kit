import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import { InvitationManagementDeniedError, ThrottledError } from '../src/errors.js'
import { renderAccountKitError } from '../src/http/responses.js'
import { fakeManagedHttp } from './helpers/managed_http_fakes.js'

/** A fake context that records the status and body the response was sent with. */
function recordingContext(accept?: string) {
  const { context } = fakeManagedHttp()
  const ctx = context({}, accept === undefined ? {} : { accept }) as HttpContext & {
    headers: Record<string, string>
  }
  const sent: { status?: number; body?: unknown } = {}
  const response = ctx.response as unknown as {
    status(status: number): { send(body: unknown): void }
  }
  response.status = (status: number) => ({
    send(body: unknown) {
      sent.status = status
      sent.body = body
    },
  })
  return { ctx, sent }
}

test.group('AccountKitError self-handling', () => {
  test('handle writes the envelope, status and headers for a masked error', async ({ assert }) => {
    const { ctx, sent } = recordingContext()
    const error = new InvitationManagementDeniedError('hidden invitation')
    await error.handle(error, ctx)
    assert.equal(sent.status, 404)
    assert.deepEqual(sent.body, {
      errors: [{ code: 'E_ACCOUNT_KIT_INVITATION_NOT_FOUND', message: 'Invitation not found.' }],
    })
    assert.equal(ctx.headers['Content-Type'], 'application/json')
    assert.equal(ctx.headers.Vary, 'Accept')
    assert.equal(ctx.headers['Cache-Control'], 'no-store')
  })

  test('handle negotiates JSON:API and keeps Retry-After on throttled errors', async ({
    assert,
  }) => {
    const { ctx, sent } = recordingContext('application/vnd.api+json')
    const error = new ThrottledError(1.2)
    await error.handle(error, ctx)
    assert.equal(sent.status, 429)
    assert.deepEqual(sent.body, {
      errors: [{ code: 'E_ACCOUNT_KIT_THROTTLED', title: 'Too many requests.' }],
    })
    assert.equal(ctx.headers['Content-Type'], 'application/vnd.api+json')
    assert.equal(ctx.headers['Retry-After'], '2')
  })

  test('leaves a non-package error alone', async ({ assert }) => {
    const { ctx, sent } = recordingContext()
    await renderAccountKitError(ctx, new Error('database password') as never)
    assert.isUndefined(sent.status)
    assert.deepEqual(ctx.headers, {})
  })
})
