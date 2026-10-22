import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { IgnitorFactory } from '@adonisjs/core/factories'

/**
 * Loads every public entry point of the installed package on the exact dependency floors, so a
 * module that imports an export the floor does not provide fails here instead of in a consumer.
 */
const manifestUrl = new URL('./node_modules/adonisjs-account-kit/package.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as {
  exports: Record<string, string>
}
const specifiers = Object.keys(manifest.exports).map((key) =>
  key.replace(/^\./, 'adonisjs-account-kit')
)
assert.ok(specifiers.length > 0, 'The installed package declares no entry points')

// The services entry registers a boot hook, so a created application must exist first.
const ignitor = new IgnitorFactory()
  .withCoreProviders()
  .withCoreConfig()
  .create(new URL('./', import.meta.url))
const app = ignitor.createApp('console')
await app.init()
try {
  for (const specifier of specifiers) {
    const loaded = await import(specifier)
    assert.equal(typeof loaded, 'object', `${specifier} did not load as a module`)
    console.log(`MINIMUM_ENTRY ${specifier}`)
  }
} finally {
  await app.terminate()
}
