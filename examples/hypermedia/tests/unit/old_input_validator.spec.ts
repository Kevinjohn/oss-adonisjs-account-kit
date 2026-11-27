import { test } from '@japa/runner'
import { oldInputValidator } from '#validators/old_input'

test.group('example old input validation', () => {
  test('retains display fields and excludes credentials and unexpected fields', async ({
    assert,
  }) => {
    const result = await oldInputValidator.validate({
      fullName: 'Example User',
      email: 'person@example.test',
      password: 'private-password',
      currentPassword: 'private-current-password',
      _csrf: 'private-proof',
      unexpected: 'discard me',
    })
    assert.deepEqual(result, { fullName: 'Example User', email: 'person@example.test' })
  })

  test('drops malformed values independently while preserving cleared fields', async ({
    assert,
  }) => {
    for (const malformed of [{ nested: true }, ['name'], 42, 'x'.repeat(321)]) {
      assert.deepEqual(
        await oldInputValidator.validate({ fullName: malformed, email: 'person@example.test' }),
        { email: 'person@example.test' }
      )
    }
    assert.deepEqual(await oldInputValidator.validate({ fullName: null, email: '' }), {
      fullName: '',
      email: '',
    })
    assert.deepEqual(await oldInputValidator.validate({}), {})
  })

  test('retains each display field up to its recovery limit', async ({ assert }) => {
    const result = await oldInputValidator.validate({
      fullName: 'n'.repeat(320),
      email: 'e'.repeat(320),
    })
    assert.deepEqual(result, { fullName: 'n'.repeat(320), email: 'e'.repeat(320) })
  })
})
