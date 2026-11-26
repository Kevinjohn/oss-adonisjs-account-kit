import type { BaseCommand } from '@adonisjs/core/ace'
import type { CommandMetaData } from '@adonisjs/core/types/ace'

/** Every command name the package's `./commands` loader registers. */
export type AccountKitCommandName =
  | 'account-kit:admission:install'
  | 'account-kit:doctor'
  | 'account-kit:invite'
  | 'account-kit:openapi'
  | 'account-kit:prune'
  | 'account-kit:reset-link'
  | 'account-kit:retirement-impact'
  | 'account-kit:setup'

export interface AccountKitCommandsOptions {
  /** Commands to leave out. */
  exclude?: readonly AccountKitCommandName[]
}

export interface AccountKitCommandsLoader {
  getMetaData(): Promise<CommandMetaData[]>
  getCommand(metaData: CommandMetaData): Promise<typeof BaseCommand | null>
}
