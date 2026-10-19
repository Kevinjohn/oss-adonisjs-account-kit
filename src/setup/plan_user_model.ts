// Setup planning phase: static analysis of the selected Lucid user model.
import { lstat, readFile } from 'node:fs/promises'
import { safeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import {
  defaultImportName,
  directClassBaseHeritage,
  exactCall,
  hasUnsafeBindingReferences,
  importedName,
  isTypeOnlyReference,
  parseSetupSource,
  unwrapStaticExpression,
  walk,
  type SetupSource,
} from './ts_source.js'
import { diagnostic } from './shared.js'
import {
  classColumns,
  conventionalSetupImport,
  hasUnsafeStaticMetadata,
  staticMembers,
  unsupportedClassRuntime,
} from './model_inspection.js'
import { inspectUserSchema } from './user_schema_inspection.js'
import type * as TypeScript from 'typescript'

export async function planUserModel(
  choices: SetupChoices,
  state: SetupInspection,
  diagnostics: SetupDiagnostic[]
): Promise<void> {
  if (
    choices.user.adapter === 'lucid' &&
    /^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) &&
    !choices.user.model.includes('//')
  ) {
    const modelPath = `app/models/${choices.user.model.slice('#models/'.length)}.ts`
    try {
      if (
        !(await conventionalSetupImport(
          state.root,
          choices.user.model,
          '#models/*',
          './app/models/*.js',
          `./${modelPath.slice(0, -3)}.js`
        ))
      )
        diagnostic(
          diagnostics,
          'user.model',
          `Setup cannot resolve ${choices.user.model} to the inspected model`
        )
      const modelFile = await safeSetupPath(state.root, modelPath)
      const modelStat = await lstat(modelFile)
      if (!modelStat.isFile())
        throw new Error(`Setup cannot inspect non-regular model ${modelPath}`)
      const model = await parseSetupSource(await readFile(modelFile, 'utf8'))
      const { ts } = model
      const classes = model.file.statements.filter(
        (node): node is TypeScript.ClassDeclaration =>
          ts.isClassDeclaration(node) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
          )
      )
      const selectedClass = classes.length === 1 ? classes[0] : null
      const baseModelBinding = importedName(model, '@adonisjs/lucid/orm', 'BaseModel')
      const schemaBinding = importedName(model, '#database/schema', 'UserSchema')
      const composeBinding = importedName(model, '@adonisjs/core/helpers', 'compose')
      const authFinderBinding = importedName(model, '@adonisjs/auth/mixins/lucid', 'withAuthFinder')
      const hashBinding = defaultImportName(model, '@adonisjs/core/services/hash')
      const providerBinding = importedName(
        model,
        '@adonisjs/auth/access_tokens',
        'DbAccessTokensProvider'
      )
      if (
        !selectedClass ||
        !selectedClass.heritageClauses?.some(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
        )
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Selected Lucid model must expose a default model class'
        )
      const staticMember = (name: string) => staticMembers(model, selectedClass, name)
      const unsafeMetadata = hasUnsafeStaticMetadata(model, selectedClass, [
        'table',
        'connection',
        'primaryKey',
        'namingStrategy',
        'accessTokens',
      ])
      let mutatedModel = false
      const nativeProvider = staticMember('accessTokens')[0]
      const nativeProviderCall =
        nativeProvider && ts.isPropertyDeclaration(nativeProvider)
          ? nativeProvider.initializer && unwrapStaticExpression(model, nativeProvider.initializer)
          : undefined
      const supportedTokenProvider = Boolean(
        nativeProviderCall &&
        providerBinding &&
        exactCall(model, nativeProviderCall, providerBinding, 'forModel') &&
        nativeProviderCall.arguments.length === 1 &&
        ts.isIdentifier(nativeProviderCall.arguments[0]) &&
        nativeProviderCall.arguments[0].text === selectedClass?.name?.text &&
        !hasUnsafeBindingReferences(
          model,
          providerBinding,
          (call) =>
            call === nativeProviderCall && exactCall(model, call, providerBinding, 'forModel')
        )
      )
      const safeSelfReference = (node: TypeScript.Identifier) =>
        Boolean(
          node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.arguments.length === 1 &&
          node.parent.arguments[0] === node &&
          node.parent === nativeProviderCall &&
          providerBinding &&
          exactCall(model, node.parent, providerBinding, 'forModel') &&
          !hasUnsafeBindingReferences(
            model,
            providerBinding,
            (call) =>
              call === nativeProviderCall && exactCall(model, call, providerBinding, 'forModel')
          )
        )
      if (selectedClass?.name)
        walk(model, (node) => {
          if (
            ts.isIdentifier(node) &&
            node.text === selectedClass.name!.text &&
            node !== selectedClass.name &&
            !isTypeOnlyReference(model, node) &&
            !safeSelfReference(node)
          )
            mutatedModel = true
        })
      if (
        unsafeMetadata ||
        mutatedModel ||
        (selectedClass && unsupportedClassRuntime(model, selectedClass, false))
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Model static metadata or later class references require manual review before generated migrations'
        )
      if (choices.authentication?.strategy === 'access_tokens' && !supportedTokenProvider)
        diagnostic(
          diagnostics,
          'user.model',
          'Token guard model must initialize accessTokens with the supported DbAccessTokensProvider.forModel(User) provider'
        )
      let schemaClass: TypeScript.ClassDeclaration | null = null
      let schemaSource: SetupSource | null = null
      const heritage = selectedClass?.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
      )
      const extended = heritage?.types.length === 1 ? heritage.types[0].expression : null
      const composeCall = extended && ts.isCallExpression(extended) ? extended : null
      const finderCall =
        composeCall && ts.isCallExpression(composeCall.arguments[1])
          ? composeCall.arguments[1]
          : null
      const composesWith = (base: string | null) =>
        Boolean(
          composeCall &&
          ts.isIdentifier(composeCall.expression) &&
          composeCall.expression.text === composeBinding &&
          composeCall.arguments.length === 2 &&
          ts.isIdentifier(composeCall.arguments[0]) &&
          composeCall.arguments[0].text === base &&
          finderCall &&
          ts.isIdentifier(finderCall.expression) &&
          finderCall.expression.text === authFinderBinding &&
          finderCall.arguments.length === 1 &&
          ts.isIdentifier(finderCall.arguments[0]) &&
          finderCall.arguments[0].text === hashBinding
        )
      const composed = composeCall && finderCall && composesWith(schemaBinding)
      const onlyImportedReference = (
        binding: string | null,
        expected: TypeScript.Node | undefined
      ) => {
        if (!binding || !expected) return false
        let safe = true
        walk(model, (node) => {
          if (
            !ts.isIdentifier(node) ||
            node.text !== binding ||
            node === expected ||
            isTypeOnlyReference(model, node)
          )
            return
          if (
            ts.isImportSpecifier(node.parent) &&
            (node.parent.name === node || node.parent.propertyName === node)
          )
            return
          if (ts.isImportClause(node.parent) && node.parent.name === node) return
          if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
          safe = false
        })
        return safe
      }
      const safeComposition =
        composed &&
        !hasUnsafeBindingReferences(model, composeBinding!, (call) => call === composeCall) &&
        !hasUnsafeBindingReferences(model, authFinderBinding!, (call) => call === finderCall) &&
        onlyImportedReference(schemaBinding, composeCall.arguments[0]) &&
        onlyImportedReference(hashBinding, finderCall.arguments[0])
      const composedBase = composeCall && finderCall && composesWith(baseModelBinding)
      const safeBaseComposition =
        composedBase &&
        !hasUnsafeBindingReferences(model, composeBinding!, (call) => call === composeCall) &&
        !hasUnsafeBindingReferences(model, authFinderBinding!, (call) => call === finderCall) &&
        onlyImportedReference(hashBinding, finderCall.arguments[0])
      if (
        baseModelBinding &&
        hasUnsafeBindingReferences(
          model,
          baseModelBinding,
          () => false,
          (reference) =>
            (directClassBaseHeritage(model, reference) &&
              reference.parent.parent.parent === selectedClass) ||
            Boolean(safeBaseComposition && reference === composeCall?.arguments[0])
        )
      )
        diagnostic(
          diagnostics,
          'user.connection',
          'Resolve imported BaseModel provenance before generated migrations'
        )
      if (safeComposition && schemaBinding)
        ({ schemaClass, schemaSource } = await inspectUserSchema(state.root, diagnostics))
      const inheritedMember = (name: string) =>
        schemaSource ? staticMembers(schemaSource, schemaClass, name) : []
      const modelColumns = selectedClass ? classColumns(model, selectedClass) : null
      const inheritedColumns =
        schemaClass && schemaSource ? classColumns(schemaSource, schemaClass) : null
      const primaryKeyMember = (member: TypeScript.Node | undefined) =>
        member &&
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        ts.isStringLiteral(member.initializer) &&
        member.initializer.text === choices.user.primaryKey
      const declaredKeys = [...staticMember('primaryKey'), ...inheritedMember('primaryKey')]
      if (
        declaredKeys.some((member) => !primaryKeyMember(member)) ||
        staticMember('namingStrategy').length ||
        inheritedMember('namingStrategy').length
      )
        diagnostic(
          diagnostics,
          'user.idType',
          'Resolve the model primary key and naming strategy before generating migrations'
        )
      if (modelColumns?.unsafe || inheritedColumns?.unsafe)
        diagnostic(
          diagnostics,
          'user.idType',
          'Resolve model column decorators before generating migrations'
        )
      if (selectedClass && modelColumns) {
        const effective = new Map([
          ...(inheritedColumns?.columns ?? new Map()),
          ...modelColumns.columns,
        ])
        const primary = [...effective.entries()].filter(([, value]) => value.primary)
        const id = effective.get(choices.user.primaryKey)
        const expectedType =
          choices.user.idType === 'integer'
            ? ts.SyntaxKind.NumberKeyword
            : ts.SyntaxKind.StringKeyword
        if (
          !id ||
          !id.primary ||
          id.physical !== choices.user.primaryKey ||
          primary.length !== 1 ||
          primary[0][0] !== choices.user.primaryKey ||
          id.declaration.type?.kind !== expectedType
        )
          diagnostic(
            diagnostics,
            'user.idType',
            'Model must expose one physical id primary column with the selected TypeScript id type'
          )
      }
      const tableMember = staticMember('table')
      const tableInitializer =
        tableMember.length === 1 && ts.isPropertyDeclaration(tableMember[0])
          ? tableMember[0].initializer
          : undefined
      const table =
        tableInitializer && ts.isStringLiteral(tableInitializer) ? tableInitializer.text : null
      if (tableMember.length && !table)
        diagnostic(
          diagnostics,
          'user.table',
          'Resolve the inherited or declared model table before generating migrations'
        )
      if (table && table !== choices.user.table)
        diagnostic(
          diagnostics,
          'user.table',
          `Model table ${table} differs from selected ${choices.user.table}`
        )
      if (staticMember('connection').length || inheritedMember('connection').length)
        diagnostic(
          diagnostics,
          'user.connection',
          'Selected Lucid model must not declare an explicit connection override'
        )
      if (!table && selectedClass?.name?.text !== 'User')
        diagnostic(
          diagnostics,
          'user.table',
          'Confirm the final model table mapping before generated migrations'
        )
      if (!table && choices.user.table !== 'users')
        diagnostic(
          diagnostics,
          'user.table',
          'Default Lucid User table is users; declare a model-owned table for another name'
        )
      if (
        inheritedMember('table').length &&
        inheritedMember('table').some(
          (member) =>
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            !ts.isStringLiteral(member.initializer)
        )
      )
        diagnostic(
          diagnostics,
          'user.table',
          'Resolve schema table evaluation before generated migrations'
        )
      const extendsBase = selectedClass?.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some(
            (item) =>
              (ts.isIdentifier(item.expression) && item.expression.text === baseModelBinding) ||
              (composed && schemaClass !== null) ||
              (safeBaseComposition && item.expression === composeCall)
          )
      )
      if (!extendsBase)
        diagnostic(
          diagnostics,
          'user.connection',
          'Resolve the imported Lucid BaseModel inheritance before using this model for generated migrations'
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      diagnostic(diagnostics, 'user.model', `${modelPath} was not found`)
    }
  }
}
