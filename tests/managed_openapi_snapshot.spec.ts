import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { generateManagedOpenApi } from '../src/http/openapi.js'
import { planManagedRoutes, type ManagedCapability } from '../src/http/routes.js'
import type { SocialProviderName } from '../src/types.js'

const directory = new URL('./fixtures/openapi/', import.meta.url)

test.group('managed OpenAPI snapshot', () => {
  test('the committed documents match the generator', async ({ assert }) => {
    const input = JSON.parse(await readFile(new URL('snapshot_input.json', directory), 'utf8')) as {
      prefix: string
      enabled: ManagedCapability[]
      socialProviders: SocialProviderName[]
      info: { title: string; version: string }
      strategies: Array<'session' | 'access_tokens'>
    }
    for (const strategy of input.strategies) {
      const document = generateManagedOpenApi({
        registration: {
          routes: planManagedRoutes({ prefix: input.prefix, strategy, enabled: input.enabled }),
          strategy,
          prefix: input.prefix,
          socialProviders: input.socialProviders,
          replaced: {
            registration: false,
            invitationAcceptance: false,
            profile: false,
            representAccount: false,
          },
        },
        info: input.info,
      })
      const committed = JSON.parse(
        await readFile(new URL(`managed_${strategy}.json`, directory), 'utf8')
      )
      assert.deepEqual(
        document,
        committed,
        `Regenerate with \`pnpm build && node scripts/openapi_snapshot.mjs\` and review the diff`
      )
    }
  })
})
