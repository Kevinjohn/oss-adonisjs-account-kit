import { readdir, readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'

type Blocks = Record<string, string>

const FILES = ['errors.json', 'validator.json']
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** The English blocks are the ones `docs/managed-http.md` tells applications to copy. */
async function englishBlocks(): Promise<Blocks> {
  const docs = await read('docs/managed-http.md')
  const blocks: Blocks = {}
  for (const file of FILES) {
    const block = docs.split(`resources/lang/<locale>/${file}`)[1]?.match(/```json\n([\s\S]*?)```/)
    blocks[file] = block![1]
  }
  return blocks
}

/** A locale page titles each block with its file name: ```json [errors.json] */
function localeBlocks(page: string): Blocks {
  const blocks: Blocks = {}
  for (const match of page.matchAll(/```json \[([\w.]+)\]\n([\s\S]*?)```/g)) {
    blocks[match[1]] = match[2]
  }
  return blocks
}

function flatten(value: unknown, prefix = '', into: Record<string, unknown> = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, into)
    }
  } else {
    into[prefix] = value
  }
  return into
}

function placeholders(elements: MessageFormatElement[], into = new Set<string>()) {
  for (const element of elements) {
    if (element.type === TYPE.literal || element.type === TYPE.pound) continue
    if (element.type === TYPE.tag) {
      placeholders(element.children, into)
      continue
    }
    into.add(element.value)
    if (element.type === TYPE.plural || element.type === TYPE.select) {
      for (const option of Object.values(element.options)) placeholders(option.value, into)
    }
  }
  return into
}

function messages(json: string, file: string, problems: string[]) {
  try {
    return flatten(JSON.parse(json))
  } catch {
    problems.push(`${file}: invalid JSON`)
    return undefined
  }
}

/** Compares structure only: keys, ICU syntax and placeholders. Wording is never checked. */
function compare(english: Blocks, locale: Blocks): string[] {
  const problems: string[] = []
  for (const file of Object.keys(locale)) {
    if (!(file in english)) problems.push(`${file}: not an English block`)
  }
  for (const [file, source] of Object.entries(english)) {
    if (!(file in locale)) {
      problems.push(`${file}: block missing`)
      continue
    }
    const expected = messages(source, file, problems)
    const actual = messages(locale[file], file, problems)
    if (!expected || !actual) continue
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) problems.push(`${file}: missing key ${key}`)
    }
    for (const [key, value] of Object.entries(actual)) {
      if (!(key in expected)) {
        problems.push(`${file}: extra key ${key}`)
        continue
      }
      if (typeof value !== 'string') {
        problems.push(`${file}: ${key} is not a string`)
        continue
      }
      let found: Set<string>
      try {
        found = placeholders(parse(value))
      } catch {
        problems.push(`${file}: ${key} is not valid ICU`)
        continue
      }
      const wanted = placeholders(parse(String(expected[key])))
      if ([...wanted].sort().join() !== [...found].sort().join()) {
        problems.push(`${file}: ${key} placeholders differ`)
      }
    }
  }
  return problems
}

/** Copies the English blocks as a locale page would hold them, after one edit to a file. */
async function localeFrom(file: string, edit: (json: string) => string): Promise<Blocks> {
  const blocks = await englishBlocks()
  return { ...blocks, [file]: edit(blocks[file]) }
}

test.group('docs translations', () => {
  test('the English blocks are valid ICU and match themselves', async ({ assert }) => {
    const english = await englishBlocks()
    assert.deepEqual(Object.keys(english), FILES)
    assert.deepEqual(compare(english, english), [])
  })

  test('every locale page has the same keys and placeholders as English', async ({ assert }) => {
    const english = await englishBlocks()
    const names = await readdir(new URL('../docs/translations/', import.meta.url))
    const pages = names.filter((name) => name.endsWith('.md') && name !== 'index.md')
    const problems: string[] = []
    for (const page of pages) {
      const blocks = localeBlocks(await read(`docs/translations/${page}`))
      problems.push(...compare(english, blocks).map((problem) => `${page} ${problem}`))
    }
    assert.deepEqual(problems, [])
  })

  test('a locale page is parsed by its titled blocks', async ({ assert }) => {
    const english = await englishBlocks()
    const page = FILES.map((file) => `\`\`\`json [${file}]\n${english[file]}\`\`\``).join('\n\n')
    assert.deepEqual(localeBlocks(page), english)
  })

  test('a missing key is reported', async ({ assert }) => {
    const locale = await localeFrom('errors.json', (json) =>
      json.replace(/\s*"E_ACCOUNT_KIT_THROTTLED": "[^"]*",/, '')
    )
    assert.deepEqual(compare(await englishBlocks(), locale), [
      'errors.json: missing key E_ACCOUNT_KIT_THROTTLED',
    ])
  })

  test('an extra key is reported', async ({ assert }) => {
    const locale = await localeFrom('errors.json', (json) =>
      json.replace('{', '{\n  "E_ACCOUNT_KIT_UNKNOWN": "Unknown.",')
    )
    assert.deepEqual(compare(await englishBlocks(), locale), [
      'errors.json: extra key E_ACCOUNT_KIT_UNKNOWN',
    ])
  })

  test('a lost placeholder is reported', async ({ assert }) => {
    const locale = await localeFrom('validator.json', (json) =>
      json.replace('The {field} has already been taken.', 'Already taken.')
    )
    assert.deepEqual(compare(await englishBlocks(), locale), [
      'validator.json: shared.messages.unique placeholders differ',
    ])
  })

  test('broken ICU is reported', async ({ assert }) => {
    const locale = await localeFrom('validator.json', (json) =>
      json.replace('The {field} has already been taken.', 'The {field has already been taken.')
    )
    assert.deepEqual(compare(await englishBlocks(), locale), [
      'validator.json: shared.messages.unique is not valid ICU',
    ])
  })

  test('invalid JSON and a missing block are reported', async ({ assert }) => {
    const english = await englishBlocks()
    assert.deepEqual(compare(english, { 'errors.json': '{' }), [
      'errors.json: invalid JSON',
      'validator.json: block missing',
    ])
  })
})
