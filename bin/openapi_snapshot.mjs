// Regenerates the committed OpenAPI snapshots from the built package: `pnpm build` first.
// tests/managed_openapi_snapshot.spec.ts fails until a schema change is regenerated and reviewed.
import { readFile, writeFile } from 'node:fs/promises'
import { generateManagedOpenApi, planManagedRoutes } from '../build/http/main.js'

const directory = new URL('../tests/fixtures/openapi/', import.meta.url)
const input = JSON.parse(await readFile(new URL('snapshot_input.json', directory), 'utf8'))

for (const strategy of input.strategies) {
  const routes = planManagedRoutes({ prefix: input.prefix, strategy, enabled: input.enabled })
  const document = generateManagedOpenApi({
    registration: {
      routes,
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
  const target = new URL(`managed_${strategy}.json`, directory)
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`Wrote ${target.pathname}`)
}
