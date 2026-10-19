import { test } from '@japa/runner'
import { stripSourceComments } from '../src/setup/strip_source_comments.js'

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
