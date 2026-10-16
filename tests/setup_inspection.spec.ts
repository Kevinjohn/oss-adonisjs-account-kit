import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { inspectSetup } from '../src/setup/inspect.js'
import { stripSourceComments } from '../src/setup/source_text.js'

async function applicationRoot() {
  const root = await mkdtemp(join(tmpdir(), 'account-setup-inspect-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'package.json'), '{}')
  return root
}

test('source inspection removes comments while preserving escaped and template literals', async ({
  assert,
}) => {
  const source = [
    'const url = "https://example.test/a//b"',
    String.raw`const message = 'it\'s /* literal */'`,
    'const template = `// literal ${ /* hidden */ value }`',
    '// web: sessionGuard({})',
    '/* api: tokensGuard({}) */',
  ].join('\n')
  const inspected = stripSourceComments(source)
  assert.equal(inspected.length, source.length)
  assert.include(inspected, 'https://example.test/a//b')
  assert.include(inspected, String.raw`'it\'s /* literal */'`)
  assert.match(inspected, /`\/\/ literal \$\{\s+value \}`/)
  assert.notInclude(inspected, 'web: sessionGuard')
  assert.notInclude(inspected, 'api: tokensGuard')
})

test('commented guards and models do not become setup prerequisites', async ({ assert }) => {
  const root = await applicationRoot()
  try {
    const authPath = join(root, 'config/auth.ts')
    await writeFile(
      authPath,
      [
        '/* web: sessionGuard({ provider: sessionUserProvider({ model: () => import("#models/ghost") }) }) */',
        '// api: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/ghost") }) })',
        'export default { guards: {} }',
      ].join('\n')
    )
    const commented = await inspectSetup(root)
    assert.deepEqual(commented.guards, [])
    assert.deepEqual(commented.guardModels, {})

    await writeFile(
      authPath,
      [
        'export default { guards: {',
        '  web: sessionGuard({ provider: sessionUserProvider({ model: () => import("#models/user") }) }),',
        '  api: tokensGuard({ provider: tokensUserProvider({ model: () => import("#models/user") }) }),',
        '} }',
      ].join('\n')
    )
    const live = await inspectSetup(root)
    assert.deepEqual(live.guardStrategies, { web: 'session', api: 'access_tokens' })
    assert.deepEqual(live.guardModels, { web: '#models/user', api: '#models/user' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolved package metadata must be a regular in-application file', async ({ assert }) => {
  const root = await applicationRoot()
  const external = await mkdtemp(join(tmpdir(), 'account-setup-external-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { 'linked-package': '1.0.0' } })
    )
    await mkdir(join(root, 'vendor/linked-package'), { recursive: true })
    await mkdir(join(root, 'node_modules'))
    await symlink(join(root, 'vendor/linked-package'), join(root, 'node_modules/linked-package'))
    const metadata = join(root, 'vendor/linked-package/package.json')
    await writeFile(metadata, JSON.stringify({ version: '1.2.3' }))
    const installed = await inspectSetup(root)
    assert.equal(installed.installedVersions['linked-package'], '1.2.3')

    await writeFile(join(external, 'package.json'), JSON.stringify({ version: '99.0.0' }))
    await rm(metadata)
    await symlink(join(external, 'package.json'), metadata)
    await assert.rejects(() => inspectSetup(root), /non-regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
