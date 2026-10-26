import { test } from '@japa/runner'
import { migrationContent } from '../src/setup/migration_source.js'
import { defaultSetupChoices } from '../src/setup/defaults.js'

test.group('setup migration templates', () => {
  test('renders a template with the selected users table and id columns', async ({ assert }) => {
    const choices = defaultSetupChoices()
    choices.user.table = 'members'
    const content = await migrationContent('create_password_reset_tokens', choices)
    assert.notInclude(content, '{{{')
    assert.notInclude(content, 'exports(')
    assert.include(content, 'members')
  })

  test('names the missing template instead of leaking a file system error', async ({ assert }) => {
    await assert.rejects(
      () => migrationContent('does_not_exist', defaultSetupChoices()),
      /Account Kit migration template does_not_exist is missing/
    )
  })
})
