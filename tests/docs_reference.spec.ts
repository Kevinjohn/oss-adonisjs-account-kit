import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import * as errors from '../src/errors.js'
import { planManagedRoutes, type ManagedCapability } from '../src/http/routes.js'

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the error reference lists every exported error with its code and status', async ({
  assert,
}) => {
  const reference = await read('docs/reference/errors.md')
  const missing: string[] = []
  for (const [name, value] of Object.entries(errors)) {
    if (typeof value !== 'function') continue
    const row = `| \`${name}\``
    const line = reference.split('\n').find((candidate) => candidate.startsWith(`${row} `))
    if (
      !line ||
      !line.includes(`| \`${value.code}\``) ||
      !new RegExp(`\\|\\s+${value.status} \\|`).test(line)
    )
      missing.push(`${name} ${value.code} ${value.status}`)
  }
  assert.deepEqual(missing, [])
})

test('the endpoint reference lists every managed route', async ({ assert }) => {
  // Prettier pads table cells, so compare rows with single spaces.
  const source = await read('docs/reference/endpoints.md')
  const reference = source.replace(/ {2,}/g, ' ')
  const enabled: ManagedCapability[] = [
    'authentication',
    'registration',
    'passwordReset',
    'emailVerification',
    'emailPasswordManagement',
    'invitations',
    'socialAuthentication',
    'sessionManagement',
  ]
  const routes = planManagedRoutes({ prefix: '/prefix', strategy: 'session', enabled })
  const missing = routes
    .map(
      (route) =>
        `| \`${route.method}\` | \`${route.path.slice('/prefix'.length)}\` | \`${route.name}\` | ${route.access} |`
    )
    .filter((row) => !reference.includes(row))
  assert.isAbove(routes.length, 0)
  assert.deepEqual(missing, [])
})
