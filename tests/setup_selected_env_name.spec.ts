import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { selectedEnvName } from '../src/setup/selected_environment.js'
import { defaultExpression, defaultImportName, parseSetupSource } from '../src/setup/ts_source.js'

async function select(root: string, expression: string, variable?: string, extra = '') {
  const source = await parseSetupSource(
    `import env from '#start/env'\n${extra}export default ${expression}\n`
  )
  return selectedEnvName(
    source,
    root,
    defaultImportName(source, '#start/env'),
    defaultExpression(source)!.expression,
    variable
  )
}

async function withEnv(contents: string, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'account-setup-env-name-'))
  try {
    await writeFile(join(root, '.env'), contents)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('DB_CONNECTION is read only from the pinned variable', async ({ assert }) => {
  await withEnv('DB_CONNECTION=pg\nOTHER=mysql\n', async (root) => {
    assert.equal(await select(root, "env.get('DB_CONNECTION', 'sqlite')", 'DB_CONNECTION'), 'pg')
    assert.isUndefined(await select(root, "env.get('OTHER', 'sqlite')", 'DB_CONNECTION'))
    assert.isUndefined(await select(root, "env.get('DB_CONNECTION', 1)", 'DB_CONNECTION'))
  })
})

test('the mail transport variable falls back to the literal default', async ({ assert }) => {
  await withEnv('', async (root) => {
    assert.equal(await select(root, "env.get('MAIL_MAILER', 'smtp')", 'MAIL_MAILER'), 'smtp')
    assert.isNull(await select(root, "env.get('MAIL_MAILER')", 'MAIL_MAILER'))
    assert.isUndefined(await select(root, "env.get('MAIL_MAILER', 'smtp', 'x')", 'MAIL_MAILER'))
  })
})

test('the limiter store variable must be an upper-case name', async ({ assert }) => {
  await withEnv('LIMITER_STORE=database\nlimiter_store=redis\n', async (root) => {
    assert.equal(await select(root, "env.get('LIMITER_STORE', 'memory')"), 'database')
    assert.isUndefined(await select(root, "env.get('limiter_store', 'memory')"))
  })
})

test('the session driver variable needs a read-only env binding', async ({ assert }) => {
  await withEnv('SESSION_DRIVER=cookie\n', async (root) => {
    assert.equal(await select(root, "env.get('SESSION_DRIVER')"), 'cookie')
    assert.isUndefined(
      await select(root, "env.get('SESSION_DRIVER')", undefined, "env.set('SESSION_DRIVER', 'x')\n")
    )
    assert.isUndefined(await select(root, "other.get('SESSION_DRIVER')"))
  })
})
