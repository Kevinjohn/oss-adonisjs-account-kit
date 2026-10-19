import { test } from '@japa/runner'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { AccountKit, defineConfig } from '../src/account_kit.js'
import { consume, limiterKey } from '../src/throttle.js'
import { useTestApp } from './helpers/app.js'
import { makeConfig, makeUsersAdapter } from './helpers/fakes.js'

test.group('limiter privacy', (group) => {
  const kit = useTestApp(group)

  test('separate processes share private database budgets by configured secret and namespace', async ({
    assert,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'account-kit-limiter-'))
    const filename = join(directory, 'limits.sqlite')
    const secret = 'test-only-shared-limiter-secret-32-bytes'
    const fixture = fileURLToPath(new URL('./fixtures/shared_limiter_process.ts', import.meta.url))
    const sqlite = new DatabaseSync(filename)
    sqlite.exec(
      'CREATE TABLE rate_limits (key VARCHAR(255) PRIMARY KEY NOT NULL, points INTEGER NOT NULL DEFAULT 0, expire BIGINT)'
    )
    sqlite.close()
    try {
      const run = (namespace: string, selectedSecret = secret) => {
        const child = spawnSync(process.execPath, ['--import=@poppinss/ts-exec', fixture], {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            ...process.env,
            DEBUG: 'adonisjs:limiter',
            ACCOUNT_KIT_TEST_DB: filename,
            ACCOUNT_KIT_TEST_SECRET: selectedSecret,
            ACCOUNT_KIT_TEST_NAMESPACE: namespace,
          },
          encoding: 'utf8',
          timeout: 8000,
        })
        assert.equal(child.status, 0, child.stderr)
        const output = `${child.stdout}${child.stderr}`
        for (const raw of ['person@example.test', '192.0.2.14', secret, selectedSecret])
          assert.notInclude(output, raw)
        return JSON.parse(child.stdout.trim().split('\n').at(-1)!) as Array<{
          throttled: boolean
          status?: number
        }>
      }
      assert.deepEqual(run('app-a'), [{ throttled: false }, { throttled: false }])
      assert.deepEqual(run('app-a'), [
        { throttled: true, status: 429 },
        { throttled: true, status: 429 },
      ])
      assert.deepEqual(run('app-b'), [{ throttled: false }, { throttled: false }])
      assert.deepEqual(run('app-a', 'another-test-only-shared-secret-32-bytes'), [
        { throttled: false },
        { throttled: false },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }).timeout(40000)

  test('keys hide identifiers and separate secret, namespace, and operation', async ({
    assert,
  }) => {
    const keys: string[] = []
    const limiter = {
      use: () => ({
        consume: async (key: string) => {
          keys.push(key)
        },
      }),
    }
    const budget = { requests: 1, duration: '1h' }
    await consume(
      limiter as never,
      'recovery:email',
      'person@example.test',
      budget,
      'a'.repeat(32),
      'app-a'
    )
    await consume(
      limiter as never,
      'recovery:email',
      'person@example.test',
      budget,
      'a'.repeat(32),
      'app-a'
    )
    await consume(
      limiter as never,
      'recovery:client',
      'person@example.test',
      budget,
      'a'.repeat(32),
      'app-a'
    )
    await consume(
      limiter as never,
      'recovery:email',
      'person@example.test',
      budget,
      'b'.repeat(32),
      'app-a'
    )
    await consume(
      limiter as never,
      'recovery:email',
      'person@example.test',
      budget,
      'a'.repeat(32),
      'app-b'
    )
    assert.equal(keys[0], keys[1])
    assert.lengthOf(new Set(keys), 4)
    for (const key of keys) assert.notInclude(key, 'person@example.test')
  })

  test('the kit throttler keys budgets by the configured secret and namespace', async ({
    assert,
  }) => {
    const keys: string[] = []
    const limiter = {
      use: () => ({
        consume: async (key: string) => {
          keys.push(key)
        },
      }),
    }
    const users = makeUsersAdapter(kit.db, kit.hash)
    for (const limiterNamespace of ['app-a', 'app-b']) {
      const account = new AccountKit({
        config: defineConfig(makeConfig({ users, limiterNamespace })),
        db: kit.db,
        limiter: limiter as never,
        encryption: kit.encryption,
      })
      await account.managedHttp.consume({ endpoint: 'password_reset', clientKey: '192.0.2.14' })
    }
    const secret = 'test_only_shared_limiter_secret_32_bytes'
    assert.deepEqual(keys, [
      limiterKey('managed:password_reset', '192.0.2.14', secret, 'app-a'),
      limiterKey('managed:password_reset', '192.0.2.14', secret, 'app-b'),
    ])
  })
})
