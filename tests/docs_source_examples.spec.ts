import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { test } from '@japa/runner'
import { sourceExamples, sourceRegion } from './helpers/source_examples.js'
import { repoRoot, trackedMarkdown } from './helpers/tracked_markdown.js'

/** Each problem with a document's sourced examples, as `document:line: message`. */
async function problems(document: string, contents: string): Promise<string[]> {
  const { examples, errors } = sourceExamples(contents)
  const found = errors.map((error) => `${document}: ${error}`)
  for (const example of examples) {
    const [path, region = ''] = example.target.split('#')
    const file = posix.normalize(posix.join(posix.dirname(document), path))
    const source = await readFile(join(repoRoot, file), 'utf8').catch(() => undefined)
    const body = source === undefined ? undefined : sourceRegion(source, region)
    if (source === undefined) found.push(`${document}:${example.line}: missing file ${file}`)
    else if (body === undefined)
      found.push(`${document}:${example.line}: missing region ${region} in ${file}`)
    else if (body.trim() !== example.body.trim())
      found.push(`${document}:${example.line}: differs from ${example.target}`)
  }
  return found
}

test('every sourced documentation example matches its source region', async ({ assert }) => {
  let checked = 0
  const found: string[] = []
  // The changelog records history, not maintained examples.
  for (const document of trackedMarkdown(['**/*.md']).filter((name) => name !== 'CHANGELOG.md')) {
    const contents = await readFile(join(repoRoot, document), 'utf8')
    checked += sourceExamples(contents).examples.length
    found.push(...(await problems(document, contents)))
  }
  assert.isAbove(checked, 0)
  assert.deepEqual(found, [])
})

test('a sourced example reports a changed region, a missing region and a stray marker', async ({
  assert,
}) => {
  const document = 'tests/helpers/source_examples.md'
  const fence = '```'
  const contents = [
    '<!-- source: source_examples.ts#nowhere -->',
    '',
    `${fence}ts`,
    'const value = 1',
    fence,
    '<!-- source: source_examples.ts#nowhere -->',
    'Text before any fence.',
  ].join('\n')
  assert.deepEqual(await problems(document, contents), [
    `${document}: line 6: source marker requires a following code fence`,
    `${document}:1: missing region nowhere in tests/helpers/source_examples.ts`,
  ])
  assert.deepEqual(sourceExamples(`<!-- source: a.ts#b -->\n${fence}\nx\n${fence}`).examples, [
    { line: 1, target: 'a.ts#b', body: 'x' },
  ])
  assert.equal(sourceRegion('// #region b\nx\n// #endregion b', 'b'), 'x')
  assert.isUndefined(sourceRegion('// #region b\nx', 'b'))
})
