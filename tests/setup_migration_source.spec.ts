import { test } from '@japa/runner'
import { migrationContent, requireMigrationTemplatePath } from '../src/setup/migration_source.ts'
import { buildMigrationSchema } from '../src/setup/migration_definitions.ts'

test.group('setup migration templates', () => {
  test('renders a template with the selected users table and id columns', async ({ assert }) => {
    const content = await migrationContent(
      await requireMigrationTemplatePath('create_password_reset_tokens'),
      buildMigrationSchema('members')
    )
    assert.notInclude(content, '{{{')
    assert.notInclude(content, 'exports(')
    assert.include(content, 'members')
  })

  test('names the missing template instead of leaking a file system error', async ({ assert }) => {
    await assert.rejects(
      () => requireMigrationTemplatePath('does_not_exist'),
      /Account Kit migration template does_not_exist is missing/
    )
  })
})
