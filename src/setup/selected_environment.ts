import type * as TypeScript from 'typescript'
import { exactCall, safeEnvGetter, type SetupSource } from './ts_source.js'
import { resolveSelectedEnvironment } from './selected_environment_values.js'

export {
  IndirectEnvironmentValueError,
  resolveSelectedEnvironment,
  resolveSelectedEnvironmentValue,
} from './selected_environment_values.js'

/**
 * Resolve the name chosen by `env.get('NAME')` or `env.get('NAME', 'fallback')`.
 * Returns `undefined` when the expression is not that call on a safe env binding, and `null`
 * when neither the environment nor the fallback names anything. `variable` pins the allowed
 * name; without it, the name must be an upper-case environment variable.
 */
export async function selectedEnvName(
  source: SetupSource,
  root: string,
  envBinding: string | null,
  expression: TypeScript.Expression,
  variable?: string
): Promise<string | null | undefined> {
  const { ts } = source
  if (
    !envBinding ||
    !exactCall(source, expression, envBinding, 'get') ||
    !safeEnvGetter(source, envBinding)
  )
    return undefined
  const args = expression.arguments
  if (
    args.length < 1 ||
    args.length > 2 ||
    !ts.isStringLiteral(args[0]) ||
    (variable === undefined
      ? !/^[A-Z][A-Z0-9_]*$/.test(args[0].text)
      : args[0].text !== variable) ||
    (args.length === 2 && !ts.isStringLiteral(args[1]))
  )
    return undefined
  return (
    (await resolveSelectedEnvironment(root, args[0].text)) ??
    (args.length === 2 ? (args[1] as TypeScript.StringLiteral).text : null)
  )
}
