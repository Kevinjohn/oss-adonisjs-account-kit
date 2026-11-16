import type * as TypeScript from 'typescript'
import { lazyImportPath, parseSetupSource, walk } from './ts_source.js'

/** Check static lazy-import entries in defineConfig({ commands: [...] }). */
export async function hasRegisteredCommand(
  sourceText: string,
  commandPath: string
): Promise<boolean> {
  const source = await parseSetupSource(sourceText)
  const { ts, file } = source
  let config: TypeScript.ObjectLiteralExpression | undefined
  walk(source, (node) => {
    if (config || !ts.isCallExpression(node) || node.expression.getText(file) !== 'defineConfig') {
      return
    }
    const argument = node.arguments[0]
    if (argument && ts.isObjectLiteralExpression(argument)) config = argument
  })
  if (!config) return false

  const commandsProperty = config.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      !ts.isComputedPropertyName(property.name) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'commands'
  )
  if (!commandsProperty || !ts.isPropertyAssignment(commandsProperty)) return false
  const commands = commandsProperty.initializer
  if (!ts.isArrayLiteralExpression(commands)) return false
  return commands.elements.some((entry) => lazyImportPath(source, entry) === commandPath)
}
