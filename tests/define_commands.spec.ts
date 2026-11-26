import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import * as commandLoader from '../commands/main.ts'
import { defineCommands, type AccountKitCommandName } from '../src/define_commands.ts'
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from '../src/errors.ts'

const names = (commands: { commandName: string }[]) =>
  commands.map((command) => command.commandName).sort()
const metadata = async (options?: Parameters<typeof defineCommands>[0]) => {
  const loader = await defineCommands(options)()
  return loader.getMetaData()
}

test.group('defineCommands', () => {
  test('lists exactly the commands the ./commands loader registers', async ({ assert }) => {
    const registered = names(await commandLoader.getMetaData()) as AccountKitCommandName[]
    assert.lengthOf(registered, 8)
    assert.deepEqual(names(await metadata()), registered)
    // Every registered name is a known name, so a new command cannot be missed.
    assert.deepEqual(await metadata({ exclude: registered }), [])
  })

  test('leaves an excluded command out of the metadata and the lookup', async ({ assert }) => {
    const loader = await defineCommands({ exclude: ['account-kit:reset-link'] })()
    const kept = names(await loader.getMetaData())
    assert.notInclude(kept, 'account-kit:reset-link')
    assert.lengthOf(kept, 7)
    const all = await commandLoader.getMetaData()
    const resetLink = all.find((command) => command.commandName === 'account-kit:reset-link')!
    const prune = all.find((command) => command.commandName === 'account-kit:prune')!
    assert.isNull(await loader.getCommand(resetLink))
    assert.equal(await loader.getCommand(prune), await commandLoader.getCommand(prune))
  })

  test('refuses an unknown or repeated command name', ({ assert }) => {
    for (const exclude of [
      ['account-kit:unknown'],
      ['account-kit:prune', 'account-kit:prune'],
    ] as AccountKitCommandName[][]) {
      let error: unknown
      try {
        defineCommands({ exclude })
      } catch (caught) {
        error = caught
      }
      assert.instanceOf(error, E_ACCOUNT_KIT_INVALID_CONFIGURATION)
      assert.equal(
        (error as InstanceType<typeof E_ACCOUNT_KIT_INVALID_CONFIGURATION>).field,
        'commands.exclude'
      )
      assert.equal(
        (error as Error).message,
        `account_kit: unknown command ${exclude.at(-1)} in exclude`
      )
    }
  })

  test('imports the commands only when the returned loader factory runs', ({ assert }) => {
    const script = `
      import { registerHooks } from 'node:module'
      const loaded = []
      registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })
      const commands = () => loaded.some((url) => url.endsWith('/commands/main.ts'))
      const { defineCommands } = await import('./src/define_commands.js')
      const factory = defineCommands({ exclude: ['account-kit:reset-link'] })
      const before = commands()
      await factory()
      console.log(JSON.stringify({ before, after: commands() }))
    `
    const child = spawnSync(
      process.execPath,
      ['--import=@poppinss/ts-exec', '--input-type=module', '-e', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }
    )
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), { before: false, after: true })
  })
})
