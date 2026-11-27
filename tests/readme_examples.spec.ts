import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { generateAccessMiddlewareSource } from '../src/setup/generated_http.ts'
import type { SetupChoices } from '../src/setup/types.ts'

test('README middleware example is the access middleware setup generates', async ({ assert }) => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const section = readme.slice(
    readme.indexOf('### Middleware'),
    readme.indexOf('### Quick example')
  )
  const example = section.match(/```ts\n([\s\S]*?)```/)?.[1]
  const generated = generateAccessMiddlewareSource({
    policy: { verificationRequired: true },
  } as SetupChoices)

  assert.equal(example, generated)
})
