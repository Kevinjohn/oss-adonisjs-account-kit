import { Kernel, ListLoader, type BaseCommand } from '@adonisjs/core/ace'
import type { TestApp } from './app.js'

export interface AceLog {
  message: string
  stream: string
}

/**
 * An Ace kernel over the test application that loads only `commands` and
 * collects output in raw mode instead of writing to the terminal.
 */
export function aceKernel(kit: TestApp, commands: (typeof BaseCommand)[]) {
  const kernel = new Kernel(kit.app)
  kernel.addLoader(new ListLoader(commands))
  kernel.ui.switchMode('raw')
  const logs = () => kernel.ui.logger.getLogs() as AceLog[]
  return { kernel, logs }
}
