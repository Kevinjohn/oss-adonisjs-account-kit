import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { repoRoot, trackedMarkdown } from './helpers/tracked_markdown.js'

type Blocks = Record<'errors.json' | 'validator.json', unknown>

/** The first JSON fence after `marker`, parsed. */
function jsonAfter(source: string, marker: string): unknown {
  const block = source.split(marker)[1]?.match(/```json\n([\s\S]*?)```/)
  if (!block) throw new Error(`no JSON block after ${marker}`)
  return JSON.parse(block[1])
}

/** The English source blocks in the managed HTTP page. */
async function englishBlocks(): Promise<Blocks> {
  const source = await readFile(join(repoRoot, 'docs/managed-http.md'), 'utf8')
  return {
    'errors.json': jsonAfter(source, 'resources/lang/<locale>/errors.json'),
    'validator.json': jsonAfter(source, 'resources/lang/<locale>/validator.json'),
  }
}

/** A locale page's blocks, each under a `## <file>` heading. */
function localeBlocks(source: string): Blocks {
  return {
    'errors.json': jsonAfter(source, '\n## errors.json\n'),
    'validator.json': jsonAfter(source, '\n## validator.json\n'),
  }
}

/** Every leaf value by its dotted key path. */
function leaves(value: unknown, path = '', into = new Map<string, unknown>()) {
  if (value && typeof value === 'object' && !Array.isArray(value))
    for (const [key, child] of Object.entries(value))
      leaves(child, path ? `${path}.${key}` : key, into)
  else into.set(path, value)
  return into
}

/** The argument names a parsed ICU message uses, including those inside plural and select. */
function placeholders(elements: MessageFormatElement[], into = new Set<string>()) {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue
    if (element.type === TYPE.tag) {
      placeholders(element.children, into)
      continue
    }
    into.add(element.value)
    if (element.type === TYPE.select || element.type === TYPE.plural)
      for (const option of Object.values(element.options)) placeholders(option.value, into)
  }
  return into
}

/** What a translation gets wrong against the English block; wording is never checked. */
function translationProblems(english: unknown, translated: unknown): string[] {
  const problems: string[] = []
  const source = leaves(english)
  const target = leaves(translated)
  for (const key of source.keys()) if (!target.has(key)) problems.push(`${key}: missing`)
  for (const [key, value] of target) {
    if (!source.has(key)) {
      problems.push(`${key}: not in the English block`)
      continue
    }
    if (typeof value !== 'string') {
      problems.push(`${key}: not a string`)
      continue
    }
    let elements: MessageFormatElement[]
    try {
      elements = parse(value)
    } catch (error) {
      problems.push(`${key}: invalid ICU message (${(error as Error).message})`)
      continue
    }
    const expected = placeholders(parse(source.get(key) as string))
    // A subject line may drop the brand name, which the email already shows.
    if (key.split('.').at(-1) === 'subject' && !value.includes('brandName'))
      expected.delete('brandName')
    const actual = placeholders(elements)
    for (const name of expected) if (!actual.has(name)) problems.push(`${key}: lost {${name}}`)
    for (const name of actual) if (!expected.has(name)) problems.push(`${key}: unknown {${name}}`)
  }
  return problems
}

const english = {
  shared: { messages: { unique: 'The {field} has already been taken.' } },
  subject: 'Reset your {brandName} password',
}

test.group('docs translations', () => {
  test('the English blocks are valid ICU messages', async ({ assert }) => {
    for (const block of Object.values(await englishBlocks()))
      assert.deepEqual(translationProblems(block, block), [])
  })

  test('every locale page has the English keys and placeholders', async ({ assert }) => {
    const source = await englishBlocks()
    const pages = trackedMarkdown(['docs/translations/*.md']).filter(
      (page) => page !== 'docs/translations/index.md'
    )
    const problems: string[] = []
    for (const page of pages) {
      const blocks = localeBlocks(await readFile(join(repoRoot, page), 'utf8'))
      for (const file of ['errors.json', 'validator.json'] as const)
        for (const problem of translationProblems(source[file], blocks[file]))
          problems.push(`${page} ${file} ${problem}`)
    }
    assert.deepEqual(problems, [])
  })

  test('a matching translation passes, and a subject may drop the brand name', ({ assert }) => {
    assert.deepEqual(
      translationProblems(english, {
        shared: { messages: { unique: 'Le champ {field} est déjà utilisé.' } },
        subject: 'Réinitialisez votre mot de passe',
      }),
      []
    )
  })

  test('a missing key fails', ({ assert }) => {
    assert.deepEqual(translationProblems(english, { subject: 'Réinitialisez' }), [
      'shared.messages.unique: missing',
    ])
  })

  test('an extra key fails', ({ assert }) => {
    assert.deepEqual(
      translationProblems(english, {
        ...english,
        shared: { messages: { ...english.shared.messages, other: 'x' } },
      }),
      ['shared.messages.other: not in the English block']
    )
  })

  test('a lost or unknown placeholder fails', ({ assert }) => {
    assert.deepEqual(
      translationProblems(english, {
        ...english,
        shared: { messages: { unique: 'Le champ {champ} est déjà utilisé.' } },
      }),
      ['shared.messages.unique: lost {field}', 'shared.messages.unique: unknown {champ}']
    )
  })

  test('a broken ICU message fails', ({ assert }) => {
    const problems = translationProblems(english, {
      ...english,
      shared: { messages: { unique: 'Le champ {field est déjà utilisé.' } },
    })
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /^shared\.messages\.unique: invalid ICU message/)
  })

  test('a block that is not valid JSON fails', ({ assert }) => {
    const page = (errors: string) =>
      `\n## errors.json\n\n\`\`\`json\n${errors}\n\`\`\`\n\n## validator.json\n\n\`\`\`json\n{}\n\`\`\`\n`
    assert.doesNotThrow(() => localeBlocks(page('{ "a": "b" }')))
    assert.throws(() => localeBlocks(page('{ "a": }')), SyntaxError)
  })
})
