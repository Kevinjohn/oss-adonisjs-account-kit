import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
import { envName } from '../src/setup/diagnostics.ts'

/** Read explicit, literal Ace overrides without loading the application's environment. */
export function environmentOverrides(assignments: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null)
  for (const assignment of assignments) {
    const separator = assignment.indexOf('=')
    const name = assignment.slice(0, separator)
    if (separator < 1 || !envName.test(name) || Object.hasOwn(env, name))
      throw new InvalidArgumentsException('Each --env requires a unique NAME=value assignment')
    env[name] = assignment.slice(separator + 1)
  }
  return env
}
