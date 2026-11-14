import { test } from '@japa/runner'
import { migrationContent, migrationTemplate } from '../src/setup/migration_source.js'
import { migrationSchema } from '../src/setup/migration_definitions.js'

test.group('setup migration templates', () => {
  test('renders a template with the selected users table and id columns', async ({ assert }) => {
    const content = await migrationContent(
      await migrationTemplate('create_password_reset_tokens'),
      migrationSchema('members')
    )
    assert.notInclude(content, '{{{')
    assert.notInclude(content, 'exports(')
    assert.include(content, 'members')
  })

  test('names the missing template instead of leaking a file system error', async ({ assert }) => {
    await assert.rejects(
      () => migrationTemplate('does_not_exist'),
      /Account Kit migration template does_not_exist is missing/
    )
  })
})
