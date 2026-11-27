import type { BaseCommand } from '@adonisjs/core/ace'
import type { CommandMetaData } from '@adonisjs/core/types/ace'

/** Every command name the package's `./commands` loader registers. */
export type AccountKitCommandName =
  | 'account-kit:admission:approve'
  | 'account-kit:admission:bootstrap'
  | 'account-kit:admission:grant-invitation'
  | 'account-kit:admission:install'
  | 'account-kit:admission:revoke'
  | 'account-kit:doctor'
  | 'account-kit:invite'
  | 'account-kit:openapi'
  | 'account-kit:prune'
  | 'account-kit:reset-link'
  | 'account-kit:retirement-impact'
  | 'account-kit:setup'

/** Selects which package commands an application registers. */
export interface AccountKitCommandsOptions {
  /** Commands to leave out. */
  exclude?: readonly AccountKitCommandName[]
}

/** The command metadata and class loader consumed by Ace. */
export interface AccountKitCommandsLoader {
  /** Lists the commands available to Ace. */
  getMetaData(): Promise<CommandMetaData[]>
  /** Loads the class for one listed command. */
  getCommand(metaData: CommandMetaData): Promise<typeof BaseCommand | null>
}

/** Metadata for the commands registered by the package's `./commands` loader. */
export declare const getMetaData: AccountKitCommandsLoader['getMetaData']

/** Loads a command from its metadata. */
export declare const getCommand: AccountKitCommandsLoader['getCommand']
