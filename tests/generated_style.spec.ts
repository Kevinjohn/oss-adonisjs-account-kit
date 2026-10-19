import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { format, resolveConfig } from 'prettier'
import { bootTestApp } from './helpers/app.js'

const stubsRoot = fileURLToPath(new URL('../stubs', import.meta.url))
// This repository and new AdonisJS apps both use @adonisjs/prettier-config.
const configPath = fileURLToPath(new URL('../configure.ts', import.meta.url))

// Applications created by create-adonisjs use the AdonisJS Prettier preset, so the config that
// configure writes should already be formatted, not only after the application's formatter runs.
test('configure renders config/account_kit.ts already formatted', async ({ assert }) => {
  const kit = await bootTestApp()
  try {
    const stubs = await kit.app.stubs.create()
    const stub = await stubs.build('config/account_kit.stub', { source: stubsRoot })
    const prepared = await stub.prepare({
      config: { destination: join(tmpdir(), 'account_kit.ts') },
    })
    // The AdonisJS stub engine trims every file it renders, so the final newline is not ours.
    const contents = prepared.contents + '\n'
    const options = await resolveConfig(configPath)
    const formatted = await format(contents, { ...options, filepath: 'account_kit.ts' })
    assert.equal(formatted, contents)
  } finally {
    await kit.close()
  }
})
