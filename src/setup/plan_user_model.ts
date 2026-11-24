import { RuntimeException } from '@adonisjs/core/exceptions'
// Setup planning phase: static analysis of the selected Lucid user model.
import { lstat, readFile } from 'node:fs/promises'
import { requireSafeSetupPath } from './safe_path.js'
import type { SetupChoices, SetupInspection, SetupDiagnostic } from './types.js'
import {
  getDefaultImportName,
  isDirectClassBaseReference,
  isExactCall,
  hasUnsafeBindingReferences,
  getImportedBindingName,
  isTypeOnlyReference,
  parseSetupSource,
  unwrapStaticExpression,
  walk,
  type SetupSource,
} from './ts_source.js'
import { E_ACCOUNT_KIT_INVALID_SETUP_SOURCE } from '../errors.js'
import { addSetupDiagnostic } from './shared.js'
import {
  inspectClassColumns,
  hasUnsafeStaticMetadata,
  listStaticMembers,
  hasUnsupportedClassRuntime,
} from './model_inspection.js'
import { hasConventionalSetupImport } from './package_imports.js'
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
        !hasConventionalSetupImport(
          state.files['package.json'],
          choices.user.model,
          '#models/*',
          './app/models/*.js',
          `./${modelPath.slice(0, -3)}.js`
        )
      )
        addSetupDiagnostic(
          diagnostics,
          'user.model',
          `Setup cannot resolve ${choices.user.model} to the inspected model`
        )
      const modelFile = await requireSafeSetupPath(state.root, modelPath)
      const modelStat = await lstat(modelFile)
      if (!modelStat.isFile())
        throw new RuntimeException(`Setup cannot inspect non-regular model ${modelPath}`)
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
      const baseModelBinding = getImportedBindingName(model, '@adonisjs/lucid/orm', 'BaseModel')
      const schemaBinding = getImportedBindingName(model, '#database/schema', 'UserSchema')
      const composeBinding = getImportedBindingName(model, '@adonisjs/core/helpers', 'compose')
      const authFinderBinding = getImportedBindingName(
        model,
        '@adonisjs/auth/mixins/lucid',
        'withAuthFinder'
      )
      const hashBinding = getDefaultImportName(model, '@adonisjs/core/services/hash')
      const providerBinding = getImportedBindingName(
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
        addSetupDiagnostic(
          diagnostics,
          'user.model',
          'Selected Lucid model must expose a default model class'
        )
      const listModelStaticMembers = (name: string) => listStaticMembers(model, selectedClass, name)
      const unsafeMetadata = hasUnsafeStaticMetadata(model, selectedClass, [
        'table',
        'connection',
        'primaryKey',
        'namingStrategy',
        'accessTokens',
      ])
      let mutatedModel = false
      const nativeProvider = listModelStaticMembers('accessTokens')[0]
      const nativeProviderCall =
        nativeProvider && ts.isPropertyDeclaration(nativeProvider)
          ? nativeProvider.initializer && unwrapStaticExpression(model, nativeProvider.initializer)
          : undefined
      const supportedTokenProvider = Boolean(
        nativeProviderCall &&
        providerBinding &&
        isExactCall(model, nativeProviderCall, providerBinding, 'forModel') &&
        nativeProviderCall.arguments.length === 1 &&
        ts.isIdentifier(nativeProviderCall.arguments[0]) &&
        nativeProviderCall.arguments[0].text === selectedClass?.name?.text &&
        !hasUnsafeBindingReferences(
          model,
          providerBinding,
          (call) =>
            call === nativeProviderCall && isExactCall(model, call, providerBinding, 'forModel')
        )
      )
      const isSafeSelfReference = (node: TypeScript.Identifier) =>
        Boolean(
          node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.arguments.length === 1 &&
          node.parent.arguments[0] === node &&
          node.parent === nativeProviderCall &&
          providerBinding &&
          isExactCall(model, node.parent, providerBinding, 'forModel') &&
          !hasUnsafeBindingReferences(
            model,
            providerBinding,
            (call) =>
              call === nativeProviderCall && isExactCall(model, call, providerBinding, 'forModel')
          )
        )
      if (selectedClass?.name)
        walk(model, (node) => {
          if (
            ts.isIdentifier(node) &&
            node.text === selectedClass.name!.text &&
            node !== selectedClass.name &&
            !isTypeOnlyReference(model, node) &&
            !isSafeSelfReference(node)
          )
            mutatedModel = true
        })
      if (
        unsafeMetadata ||
        mutatedModel ||
        (selectedClass && hasUnsupportedClassRuntime(model, selectedClass, false))
      )
        addSetupDiagnostic(
          diagnostics,
          'user.model',
          'Model static metadata or later class references require manual review before generated migrations'
        )
      if (choices.authentication?.strategy === 'access_tokens' && !supportedTokenProvider)
        addSetupDiagnostic(
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
      const isSoleImportedReference = (
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
        isSoleImportedReference(schemaBinding, composeCall.arguments[0]) &&
        isSoleImportedReference(hashBinding, finderCall.arguments[0])
      const composedBase = composeCall && finderCall && composesWith(baseModelBinding)
      const safeBaseComposition =
        composedBase &&
        !hasUnsafeBindingReferences(model, composeBinding!, (call) => call === composeCall) &&
        !hasUnsafeBindingReferences(model, authFinderBinding!, (call) => call === finderCall) &&
        isSoleImportedReference(hashBinding, finderCall.arguments[0])
      if (
        baseModelBinding &&
        hasUnsafeBindingReferences(
          model,
          baseModelBinding,
          () => false,
          (reference) =>
            (isDirectClassBaseReference(model, reference) &&
              reference.parent.parent.parent === selectedClass) ||
            Boolean(safeBaseComposition && reference === composeCall?.arguments[0])
        )
      )
        addSetupDiagnostic(
          diagnostics,
          'user.connection',
          'Resolve imported BaseModel origins before generated migrations'
        )
      if (safeComposition && schemaBinding)
        ({ schemaClass, schemaSource } = await inspectUserSchema(
          state.root,
          state.files['package.json'],
          diagnostics
        ))
      const listInheritedStaticMembers = (name: string) =>
        schemaSource ? listStaticMembers(schemaSource, schemaClass, name) : []
      const modelColumns = selectedClass ? inspectClassColumns(model, selectedClass) : null
      const inheritedColumns =
        schemaClass && schemaSource ? inspectClassColumns(schemaSource, schemaClass) : null
      const matchesPrimaryKeyMember = (member: TypeScript.Node | undefined) =>
        member &&
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        ts.isStringLiteral(member.initializer) &&
        member.initializer.text === 'id'
      const declaredKeys = [
        ...listModelStaticMembers('primaryKey'),
        ...listInheritedStaticMembers('primaryKey'),
      ]
      if (
        declaredKeys.some((member) => !matchesPrimaryKeyMember(member)) ||
        listModelStaticMembers('namingStrategy').length ||
        listInheritedStaticMembers('namingStrategy').length
      )
        addSetupDiagnostic(
          diagnostics,
          'user.idType',
          'Resolve the model primary key and naming strategy before generating migrations'
        )
      if (modelColumns?.unsafe || inheritedColumns?.unsafe)
        addSetupDiagnostic(
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
        const id = effective.get('id')
        const expectedType =
          choices.user.idType === 'integer'
            ? ts.SyntaxKind.NumberKeyword
            : ts.SyntaxKind.StringKeyword
        if (
          !id ||
          !id.primary ||
          id.physical !== 'id' ||
          primary.length !== 1 ||
          primary[0][0] !== 'id' ||
          id.declaration.type?.kind !== expectedType
        )
          addSetupDiagnostic(
            diagnostics,
            'user.idType',
            'Model must expose one physical id primary column with the selected TypeScript id type'
          )
      }
      const tableMember = listModelStaticMembers('table')
      const tableInitializer =
        tableMember.length === 1 && ts.isPropertyDeclaration(tableMember[0])
          ? tableMember[0].initializer
          : undefined
      const table =
        tableInitializer && ts.isStringLiteral(tableInitializer) ? tableInitializer.text : null
      if (tableMember.length && !table)
        addSetupDiagnostic(
          diagnostics,
          'user.table',
          'Resolve the inherited or declared model table before generating migrations'
        )
      if (table && table !== choices.user.table)
        addSetupDiagnostic(
          diagnostics,
          'user.table',
          `Model table ${table} differs from selected ${choices.user.table}`
        )
      if (
        listModelStaticMembers('connection').length ||
        listInheritedStaticMembers('connection').length
      )
        addSetupDiagnostic(
          diagnostics,
          'user.connection',
          'Selected Lucid model must not declare an explicit connection override'
        )
      if (!table && selectedClass?.name?.text !== 'User')
        addSetupDiagnostic(
          diagnostics,
          'user.table',
          'Confirm the final model table mapping before generated migrations'
        )
      if (!table && choices.user.table !== 'users')
        addSetupDiagnostic(
          diagnostics,
          'user.table',
          'Default Lucid User table is users; declare a model-owned table for another name'
        )
      if (
        listInheritedStaticMembers('table').length &&
        listInheritedStaticMembers('table').some(
          (member) =>
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            !ts.isStringLiteral(member.initializer)
        )
      )
        addSetupDiagnostic(
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
        addSetupDiagnostic(
          diagnostics,
          'user.connection',
          'Resolve the imported Lucid BaseModel inheritance before using this model for generated migrations'
        )
    } catch (error) {
      if (error instanceof E_ACCOUNT_KIT_INVALID_SETUP_SOURCE)
        addSetupDiagnostic(
          diagnostics,
          'user.model',
          `Setup cannot inspect ${modelPath}; fix its TypeScript errors first`
        )
      else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      else addSetupDiagnostic(diagnostics, 'user.model', `${modelPath} was not found`)
    }
  }
}
