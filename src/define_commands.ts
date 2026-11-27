// A command loader for `adonisrc.ts` that can leave commands out. It imports the commands only
// when Ace first asks for them, so loading `adonisrc.ts` stays cheap.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'
import type {
  AccountKitCommandName,
  AccountKitCommandsLoader,
  AccountKitCommandsOptions,
} from './types_commands.ts'

export type {
  AccountKitCommandName,
  AccountKitCommandsLoader,
  AccountKitCommandsOptions,
} from './types_commands.ts'

const accountKitCommandNames: readonly AccountKitCommandName[] = [
  'account-kit:admission:approve',
  'account-kit:admission:bootstrap',
  'account-kit:admission:grant-invitation',
  'account-kit:admission:install',
  'account-kit:admission:revoke',
  'account-kit:doctor',
  'account-kit:invite',
  'account-kit:openapi',
  'account-kit:prune',
  'account-kit:reset-link',
  'account-kit:retirement-impact',
  'account-kit:setup',
]

/**
 * A lazy command loader for the `commands` array in `adonisrc.ts`.
 *
 * @example
 * ```ts
 * import { defineCommands } from '@kevinjohn/adonisjs-account-kit/define_commands'
 * import { defineConfig } from '@adonisjs/core/app'
 *
 * export default defineConfig({
 *   commands: [defineCommands({ exclude: ['account-kit:invite'] })],
 * })
 * ```
 */
export function defineCommands(
  options: AccountKitCommandsOptions = {}
): () => Promise<AccountKitCommandsLoader> {
  const excluded = new Set<string>()
  for (const name of options.exclude ?? []) {
    if (!accountKitCommandNames.includes(name) || excluded.has(name))
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'commands.exclude',
        `account_kit: unknown command ${name} in exclude`
      )
    excluded.add(name)
  }
  return async () => {
    const loader = await import('../commands/main.js')
    return {
      async getMetaData() {
        const commands = await loader.getMetaData()
        return commands.filter((command) => !excluded.has(command.commandName))
      },
      getCommand(metaData) {
        return excluded.has(metaData.commandName)
          ? Promise.resolve(null)
          : loader.getCommand(metaData)
      },
    }
  }
}
