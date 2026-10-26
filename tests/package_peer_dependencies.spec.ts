import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'

test('keeps peer dependency floors at the oldest supported versions', async ({ assert }) => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

  // Raising a floor stops applications on older versions from installing the package. Raise one
  // only when the package needs the newer version, with a changelog entry, and update this list.
  assert.deepEqual(manifest.peerDependencies, {
    '@adonisjs/assembler': '^8.0.0',
    '@adonisjs/core': '^7.0.0',
    '@adonisjs/limiter': '^3.0.0',
    '@adonisjs/lucid': '^22.4.2',
    '@adonisjs/mail': '^10.0.0',
    '@adonisjs/session': '^8.1.0',
    '@vinejs/vine': '^4.4.0',
    'luxon': '^3.0.0',
    'typescript': '^5.9.3 || ^6.0.3',
  })
})
