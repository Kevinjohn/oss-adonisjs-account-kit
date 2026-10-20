import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const exampleRoot = fileURLToPath(new URL('../examples/api/', import.meta.url))

test('API example env template lists exactly the variables its env schema validates', async ({
  assert,
}) => {
  const template = await readFile(`${exampleRoot}.env.example`, 'utf8')
  const schema = await readFile(`${exampleRoot}start/env.ts`, 'utf8')
  const templateKeys = [...template.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)]
    .map(([, key]) => key)
    // Node reads TZ itself; the AdonisJS starters keep it out of the env schema.
    .filter((key) => key !== 'TZ')
  const schemaKeys = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*): Env\.schema\./gm)].map(
    ([, key]) => key
  )

  assert.sameMembers(templateKeys, schemaKeys)
})
