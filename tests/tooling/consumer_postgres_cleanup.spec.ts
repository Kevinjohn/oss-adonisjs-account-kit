import { test } from '@japa/runner'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const operations = [
  'resetExclusivePostgresSchema',
  'ensureExclusivePostgresDatabase',
  'postgresVersion',
]
const scenarios = ['success', 'connect', 'query', 'end', 'query+end', 'connect+end']

// Every child owns a real referenced timer: missing shutdown prevents natural exit.
// The deadline only bounds a broken implementation; no timer stages test behavior.
async function runChild(script: string, temporary: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import=@poppinss/ts-exec',
        '--input-type=module',
        '-e',
        script,
        '--',
        '--database=postgres',
      ],
      {
        cwd: repoRoot,
        // The consumer settings create their run directory under TMPDIR; keep it in the test's.
        env: { ...process.env, TMPDIR: temporary, DB_DATABASE: 'account_kit_consumer' },
        stdio: 'pipe',
      }
    )
    let output = ''
    child.stdout.on('data', (data) => (output += data))
    child.stderr.on('data', (data) => (output += data))
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`PostgreSQL child did not settle: ${output}`))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      if (code !== 0) reject(new Error(`Child failed (${code}, ${signal}): ${output}`))
      else resolve(output)
    })
  })
}

test.group('Consumer PostgreSQL cleanup', () => {
  for (const operation of operations) {
    for (const scenario of scenarios) {
      test(`${operation}: ${scenario} preserves failures and releases its live handle`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'consumer-postgres-cleanup-'))
        try {
          await mkdir(join(root, 'node_modules/pg'), { recursive: true })
          await writeFile(join(root, 'package.json'), '{}')
          await writeFile(
            join(root, 'node_modules/pg/index.js'),
            `exports.Client = class {
              constructor(options) { globalThis.options = options }
              async connect() {
                globalThis.events.push('connect')
                this.live = setInterval(() => {}, 1000)
                console.log('LIVE', this.live.hasRef())
                if (globalThis.scenario.includes('connect')) throw globalThis.operationError
              }
              async query(sql) {
                globalThis.events.push(sql)
                if (globalThis.scenario.includes('query')) throw globalThis.operationError
                return { rowCount: 0, rows: [{ server_version: '16.fake' }] }
              }
              async end() {
                globalThis.events.push('end')
                clearInterval(this.live)
                console.log('CLOSED', this.live._destroyed)
                if (globalThis.scenario.includes('end')) throw globalThis.endError
              }
            }`
          )
          const modulePath = new URL(
            operation === 'postgresVersion'
              ? '../../bin/helpers/consumer/consumer_archive.ts'
              : '../../bin/helpers/consumer/postgres.ts',
            import.meta.url
          ).href
          const output = await runChild(
            `
            import assert from 'node:assert/strict'
            globalThis.scenario = ${JSON.stringify(scenario)}
            globalThis.operationError = new Error('operation sentinel')
            globalThis.endError = new Error('end sentinel')
            globalThis.events = []
            const { ${operation}: operation } = await import(${JSON.stringify(modulePath)})
            let result, failure
            try { result = await operation(${JSON.stringify(root)}) } catch (error) { failure = error }
            const operationFailed = scenario.includes('connect') || scenario.includes('query')
            if (operationFailed && scenario.includes('end')) {
              assert(failure instanceof AggregateError)
              assert.equal(failure.errors.length, 2)
              assert.equal(failure.errors[0], operationError)
              assert.equal(failure.errors[1], endError)
            } else if (operationFailed) assert.equal(failure, operationError)
            else if (scenario === 'end') assert.equal(failure, endError)
            else {
              assert.equal(failure, undefined)
              assert.equal(result, ${operation === 'postgresVersion' ? "'PostgreSQL 16.fake'" : 'undefined'})
            }
            const queries = scenario.includes('connect') ? [] : ${JSON.stringify(
              operation === 'postgresVersion'
                ? ['SHOW server_version']
                : operation === 'resetExclusivePostgresSchema'
                  ? ['DROP SCHEMA public CASCADE', 'CREATE SCHEMA public']
                  : [
                      'SELECT 1 FROM pg_database WHERE datname = $1',
                      'CREATE DATABASE account_kit_consumer',
                    ]
            )}
            assert.deepEqual(events, ['connect', ...(scenario.includes('query') ? queries.slice(0, 1) : queries), 'end'])
            assert.equal(options.database, ${JSON.stringify(operation === 'ensureExclusivePostgresDatabase' ? 'postgres' : 'account_kit_consumer')})
            console.log('SETTLED')
          `,
            root
          )
          assert.match(output, /LIVE true/)
          assert.match(output, /CLOSED true/)
          assert.match(output, /SETTLED/)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }).timeout(15_000)
    }
  }
})
